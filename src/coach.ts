// The coach itself — ported from Hermes agents/health-coach and adapted for a
// standalone bot. Nutritionist + trainer + sleep & recovery coach in one:
//   - photo/PDF (food, lab report, tracker screenshot) → vision → log → verdict
//   - free text → log a fact OR answer a question from the journal
//   - /coach [days] → on-demand report; Sunday cron → weekly trends
//   - daily 20:45 cron → digest of today / one-line nudge / silence

import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from './models.js';
import { AppConfig } from './config.js';
import { log } from './logger.js';
import { ANTI_HALLUCINATION_BLOCK } from './prompts.js';
import { todayInTz, startOfDayUtcISO } from './day.js';
import {
  HealthKind,
  HEALTH_KINDS,
  logHealth,
  fetchHealthSince,
  serializeHealthRows,
  dataSummary,
} from './store.js';

const COACH_PERSONA = `Ти — «Пульс тіла», персональний health-бот Андрія Сусленка: нутриціолог, спортивний тренер, коуч зі сну та відновлення в одній особі.

Характер:
- Жорсткий, прямий, конкретний. Не «можливо варто», а «прибери X, додай Y».
- Хвалиш коротко, коли заслужено. Критикуєш чесно, коли бачиш проблему.
- Пушиш: якщо в журналі видно пропуски тренувань, недосип, перебір калорій — кажи це прямо.
- Порівнюй з ЙОГО даними: сьогоднішня їжа проти його ж середнього, вага проти тренду, їжа проти його аналізів (якщо в журналі є маркери — напр. високий холестерин → менше смаженого).
- Українською. Telegram HTML (<b>, <i>), БЕЗ markdown. Коротко — не більше ~1200 символів.

Оцінки калорій/макросів з фото — ЗАВЖДИ приблизні: пиши «≈». Якщо на фото не видно порцію/склад — скажи, що саме уточнити, замість вгадувати точні цифри.`;

const JSON_CONTRACT = `Відповідай ОДНИМ JSON-обʼєктом без жодного тексту довкола:
{
  "kind": "meal" | "workout" | "sleep" | "weight" | "labs" | "wellbeing" | "note" | "other",
  "title": "короткий опис факту (що саме з'їдено/зроблено/виміряно), 5-12 слів",
  "data": { структуровані числа, тільки ті що реально є:
    meal → "calories", "protein_g", "fat_g", "carbs_g" (числа), "items" (масив рядків);
    workout → "type", "duration_min", "intensity";
    sleep → "sleep_h", "quality";
    weight → "weight_kg";
    labs → "markers": [{"name","value","unit","ref","flag":"low|high|ok"}];
    wellbeing/note → {} },
  "reply": "твоя відповідь-вердикт Андрію як коуча, Telegram HTML"
}
"other" — коли вхід НЕ є новим фактом про здоровʼя (не їжа/тренування/сон/аналізи/вага): тоді data={} і reply — твоя відповідь по суті.
Для labs у reply дай розбір: що в нормі, що ні, що з цим робити.`;

export interface CoachParsed {
  kind: HealthKind | 'other';
  title: string;
  data: Record<string, unknown>;
  reply: string;
}

// Tolerant JSON extraction: strips ```json fences, salvages the first {...}
// block, validates kind. Null on anything unusable → callers fail-open.
export function parseCoachJson(raw: string): CoachParsed | null {
  if (!raw) return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  text = text.slice(start, end + 1);
  try {
    const obj = JSON.parse(text) as Partial<CoachParsed>;
    const kind = String(obj.kind ?? '');
    if (kind !== 'other' && !HEALTH_KINDS.includes(kind as HealthKind)) return null;
    const reply = String(obj.reply ?? '').trim();
    if (!reply) return null;
    return {
      kind: kind as CoachParsed['kind'],
      title: String(obj.title ?? '').slice(0, 300),
      data: obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : {},
      reply,
    };
  } catch {
    return null;
  }
}

// Daily-cron decision. Pure + exported for tests.
//   digest — entries today → real summary
//   nudge  — nothing today but the habit exists → one-line push, no LLM call
//   silent — feature unused in the window → say nothing
export function nudgeDecision(todayCount: number, priorDaysCount: number): 'digest' | 'nudge' | 'silent' {
  if (todayCount > 0) return 'digest';
  if (priorDaysCount > 0) return 'nudge';
  return 'silent';
}

function makeClient(config: AppConfig): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.anthropicApiKey, timeout: 120_000, maxRetries: 2 });
}

async function recentLogBlock(userId: number, timezone: string, days: number): Promise<string> {
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = await fetchHealthSince(userId, sinceISO);
  return `=== ЖУРНАЛ ЗДОРОВ'Я АНДРІЯ (останні ${days} дн) ===\n${serializeHealthRows(rows, timezone)}\n=== КІНЕЦЬ ЖУРНАЛУ ===`;
}

// Footer confirming what landed in the log — the user must always know whether
// the fact was persisted.
function storedFooter(parsed: CoachParsed, id: number | null): string {
  if (parsed.kind === 'other') return '';
  if (id === null) return '\n\n⚠️ <i>Проаналізував, але НЕ записав у журнал (база недоступна).</i>';
  return `\n\n📊 <i>Записав: ${parsed.title}${dataSummary(parsed.data)}</i>`;
}

/** Photo (food, labs, tracker screenshot) or PDF of labs → analyze, log, verdict. */
export async function analyzeHealthMedia(
  config: AppConfig,
  userId: number,
  media: { base64: string; mediaType: string },
  caption: string,
): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;
  const start = Date.now();

  const logBlock = await recentLogBlock(userId, config.timezone, 30);
  const isPdf = media.mediaType === 'application/pdf';
  const mediaBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: media.base64 } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: media.mediaType as 'image/jpeg', data: media.base64 } };

  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 2000,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Андрій надіслав фото або документ. Визнач, що це:
- їжа/напій → оціни склад, ≈калорії та макроси, дай вердикт відносно його дня і журналу;
- бланк аналізів (лабораторія) → витягни маркери зі значеннями/референсами, розбери що не в нормі;
- скриншот трекера (сон, ваги, годинник, тренування) → витягни числа;
- щось інше → kind "other".

${JSON_CONTRACT}

${logBlock}

Зараз: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone })}`,
      messages: [
        {
          role: 'user',
          content: [
            mediaBlock,
            { type: 'text', text: caption ? `Підпис Андрія до фото: ${caption}` : 'Без підпису.' },
          ],
        },
      ],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = parseCoachJson(raw);
    if (!parsed) {
      log({ level: 'warn', action: 'health_photo_parse_fail', details: { sample: raw.slice(0, 120) } });
      return raw.trim().length > 0
        ? `${raw.trim()}\n\n⚠️ <i>Не зміг структурувати — у журнал не записав.</i>`
        : null;
    }

    let id: number | null = null;
    if (parsed.kind !== 'other') {
      id = await logHealth(userId, parsed.kind, parsed.title, parsed.data);
    }
    log({
      level: 'info',
      action: 'health_photo_analyzed',
      userId,
      details: { kind: parsed.kind, stored: id !== null, durationMs: Date.now() - start, pdf: isPdf },
    });
    return parsed.reply + storedFooter(parsed, id);
  } catch (err) {
    log({ level: 'error', action: 'health_photo_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Free text — a fact to log («вага 91.2», «спав 6 год») OR a question to the
 *  coach («скільки калорій за тиждень?», «що мені їсти на вечерю?»). Facts get
 *  stored; questions get answered from the journal (kind "other", no write). */
export async function handleText(config: AppConfig, userId: number, text: string): Promise<string> {
  const client = makeClient(config);
  if (!client) return '⚠️ Claude API не підключений';

  const logBlock = await recentLogBlock(userId, config.timezone, 14);
  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 1400,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Андрій пише тобі в чат. Два випадки:
1) НОВИЙ ФАКТ про здоровʼя (вага, сон, тренування, їжа словами, самопочуття, ціль) → класифікуй, витягни числа, підтверди коротко (1-3 речення) з одним коуч-коментарем. Цілі («ціль: 88 кг») записуй як kind "note" з data {"goal": ...} — далі звіряй журнал з ними.
2) ПИТАННЯ або розмова (скільки калорій, яка динаміка ваги, що їсти, як спати краще) → kind "other", відповідай як коуч НА ОСНОВІ ЖУРНАЛУ нижче; чого нема в журналі — чесно кажи, що не логувалось.

${JSON_CONTRACT}

${logBlock}

Зараз: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone })}`,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = parseCoachJson(raw);
    if (!parsed) return '⚠️ Не зрозумів. Спробуй конкретніше: «вага 91.2», «спав 6 год», «тренування ноги 45 хв» — або постав питання.';
    if (parsed.kind === 'other') return parsed.reply;
    const id = await logHealth(userId, parsed.kind, parsed.title, parsed.data);
    return parsed.reply + storedFooter(parsed, id);
  } catch (err) {
    log({ level: 'error', action: 'health_text_error', details: { error: String(err).slice(0, 200) } });
    return '⚠️ Не вдалося обробити. Спробуй ще раз.';
  }
}

/** On-demand + weekly report over the last `days`. Null when the window has no
 *  data (cron stays silent; /coach explains how to start). */
export async function runHealthReport(
  config: AppConfig,
  userId: number,
  opts: { days?: number } = {},
): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;
  const days = opts.days && opts.days >= 1 ? Math.min(opts.days, 90) : 7;
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = await fetchHealthSince(userId, sinceISO);
  if (rows.length === 0) return null;

  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 1600,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Побудуй health-звіт за ${days} дн ТІЛЬКИ з журналу нижче. Структура:
💪 <b>Пульс тіла · ${days} дн</b>
<b>Їжа:</b> скільки логів, ≈середні калорії/день (рахуй лише дні, де Є записи їжі — і скажи скільки таких днів), що системно добре/погано.
<b>Тренування:</b> скільки, які. Якщо нуль — скажи прямо.
<b>Сон / вага:</b> тренд, якщо є дані; інакше «не логував».
<b>Аналізи:</b> якщо в журналі є маркери поза нормою — нагадай про них.
<b>Вердикт:</b> 2-3 речення прямо: що змінити наступного тижня. Якщо є ціль (запис з goal) — звіряй з нею.
Пропущені категорії назви чесно — «не логував», без вигаданих цифр.`,
      messages: [
        {
          role: 'user',
          content: `=== ЖУРНАЛ (${rows.length} записів за ${days} дн) ===\n${serializeHealthRows(rows, config.timezone)}\n=== КІНЕЦЬ ===`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    log({ level: 'info', action: 'health_report_run', userId, details: { days, rows: rows.length } });
    return text || null;
  } catch (err) {
    log({ level: 'error', action: 'health_report_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Daily 20:45 digest. digest → LLM summary of today; nudge → static one-liner
 *  (no LLM call); silent → null. */
export async function runHealthDaily(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const todayStartISO = startOfDayUtcISO(config.timezone, todayInTz(config.timezone));
  const todayCut = new Date(todayStartISO).getTime();
  const all = await fetchHealthSince(userId, new Date(todayCut - 3 * 24 * 3600 * 1000).toISOString());
  const today = all.filter((r) => r.logged_at.getTime() >= todayCut);
  const prior = all.length - today.length;

  const decision = nudgeDecision(today.length, prior);
  if (decision === 'silent') return null;
  if (decision === 'nudge') {
    return '🥗 <b>Пульс тіла:</b> за сьогодні жодного запису — ні їжі, ні тренування, ні сну. День без даних = день, який я не можу покращити. Кинь хоч фото вечері.';
  }

  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 1000,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Вечірній міні-дайджест дня (~600 символів):
🥗 <b>Пульс тіла · сьогодні</b>
Що зʼїв (≈сумарні калорії, якщо є записи їжі), тренування/сон/вага якщо логував. Один чесний вердикт дня + ОДНА конкретна порада на завтра. Категорії без записів сьогодні — одним словом «не логував», без моралі про кожну.`,
      messages: [
        {
          role: 'user',
          content:
            `=== СЬОГОДНІ ===\n${serializeHealthRows(today, config.timezone)}\n` +
            `=== ПОПЕРЕДНІ 3 ДНІ (контекст) ===\n${serializeHealthRows(all.filter((r) => r.logged_at.getTime() < todayCut), config.timezone)}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    log({ level: 'info', action: 'health_daily_run', userId, details: { today: today.length, prior } });
    return text || null;
  } catch (err) {
    log({ level: 'error', action: 'health_daily_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}
