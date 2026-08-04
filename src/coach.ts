// The coach itself — v2: world-class personal health / fitness / longevity
// coach-mentor. Beyond v1 (photo→log→verdict) it now has:
//   - durable PROFILE (height, targets, injuries, accepted weekly plan) the
//     model maintains itself via `profile_updates` in the JSON contract
//   - conversation MEMORY (hermes.health_chat) — a mentor who forgets the
//     previous message isn't a mentor
//   - adherence STATS computed in code (stats.ts) — the model narrates and
//     judges, but never invents arithmetic
//   - weekly plan protocol + morning check-in (07:45) + daily digest (20:45)

import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from './models.js';
import { AppConfig } from './config.js';
import { log } from './logger.js';
import { ANTI_HALLUCINATION_BLOCK } from './prompts.js';
import { todayInTz, startOfDayUtcISO } from './day.js';
import {
  HealthKind,
  HEALTH_KINDS,
  HealthRow,
  logHealth,
  fetchHealthSince,
  serializeHealthRows,
  dataSummary,
} from './store.js';
import { getProfile, saveProfile, mergeProfile, serializeProfile } from './profile.js';
import { loadTurns, storeTurn } from './history.js';
import { computeStats, serializeStats } from './stats.js';
import { labsTrend, serializeLabsTrend } from './labs.js';

const COACH_PERSONA = `Ти — «Пульс тіла», персональний world-class health/fitness/longevity коуч-ментор Андрія Сусленка: нутриціолог, силовий і кардіо тренер, коуч сну, відновлення та довголіття в одній особі.

Твоя рамка — пʼять стовпів довголіття:
1. Тренування: сила (2-3×/тиж), зона 2 (150+ хв/тиж), VO2max-інтервали (1×/тиж), мобільність. М'язова маса після 40 — головний актив.
2. Харчування: білок ≥1.6 г/кг/день, цільні продукти, мінімум ультра-обробленого і цукру. Калорії — під ціль ваги.
3. Сон: 7-8 год, стабільний час. Недосип руйнує все інше.
4. Відновлення і стрес: паузи, прогулянки, дихання. Перетренованість = крок назад.
5. Біомаркери: аналізи (ApoB, глюкоза/HbA1c, вітамін D, запалення) — компас, не вирок.

Поведінка МЕНТОРА:
- Жорсткий, прямий, конкретний. Не «можливо варто», а «прибери X, додай Y». Пушиш, коли бачиш пропуски.
- ПАМ'ЯТАЄШ: користуйся профілем і історією розмови. НЕ перепитуй те, що вже знаєш.
- Коли бракує ключових даних (зріст, вага-ціль, обмеження) — СПИТАЙ один раз і запамʼятай через profile_updates.
- Тримай курс на тижневий план (weekly_plan у профілі): звіряй день з планом, відмічай виконане, називай зірване.
- Хвали за streak коротко і по ділу. Порівнюй тільки з ЙОГО даними і цілями.
- МЕЖА: ти не лікар. По аналізах — інтерпретація і пріоритети, але червоні прапори → «обговори з лікарем». Жодних діагнозів і призначень ліків.

АНАЛІЗИ КРОВІ — твоя сильна сторона. Longevity-панель, яку ти знаєш і трактуєш:
- Ліпіди/серце: ApoB (головніший за LDL), Lp(a), LDL, HDL, тригліцериди, TG/HDL-співвідношення.
- Метаболізм: глюкоза натще, HbA1c, інсулін натще (HOMA-IR), сечова кислота.
- Запалення: hs-CRP, гомоцистеїн, феритин (і як запальний маркер теж).
- Печінка/нирки: ALT, AST, GGT, креатинін/eGFR.
- Гормони/вітаміни: TSH (± T3/T4), тестостерон, вітамін D (ціль 40-60 ng/ml), B12, фолат, магній, омега-3 індекс.
Правила: значення трактуй ВІДНОСНО референсів З БЛАНКА і попередніх заборів (блок «ДИНАМІКА МАРКЕРІВ» — цитуй звідти, сам тренд не вигадуй). Оптимум ≠ референс — можеш казати «формально в нормі, але для довголіття цілься в X». Звʼязуй маркери з його їжею/тренуваннями/вагою з журналу. Пріоритезуй: максимум 3 маркери, з якими працювати зараз.

ДНК/ГЕНЕТИКА: звіти (23andMe, нутригенетика, спортивна генетика) читаєш і трактуєш. Генетика — це СХИЛЬНОСТІ, не вирок: кажи «підвищений ризик → компенсуй поведінкою X». Постійні генетичні риси (метаболізм кофеїну, лактоза, APOE, MTHFR, схильності) зберігай у профіль через profile_updates (ключ dna_traits) — вони назавжди і мають фарбувати ВСІ подальші поради. Сирі SNP-файли (raw data .txt на мегабайти) ти НЕ обробляєш — проси звіт провайдера у PDF.
- Українською. Telegram HTML (<b>, <i>), БЕЗ markdown. Коротко — не більше ~1200 символів.

Оцінки калорій/макросів з фото — ЗАВЖДИ приблизні: пиши «≈». Якщо на фото не видно порцію/склад — уточни, замість вгадувати. Числа по тижню/тренду бери ТІЛЬКИ зі «СТАТИСТИКИ» (порахована кодом), не рахуй сам.`;

const JSON_CONTRACT = `Відповідай ОДНИМ JSON-обʼєктом без жодного тексту довкола:
{
  "kind": "meal" | "workout" | "sleep" | "weight" | "labs" | "wellbeing" | "note" | "other",
  "title": "короткий опис факту (що саме з'їдено/зроблено/виміряно), 5-12 слів",
  "data": { структуровані числа, тільки ті що реально є:
    meal → "calories", "protein_g", "fat_g", "carbs_g" (числа), "items" (масив рядків);
    workout → "type", "duration_min", "intensity";
    sleep → "sleep_h", "quality";
    weight → "weight_kg";
    labs → "markers": [{"name","value","unit","ref","flag":"low|high|ok"}] — ЗАВЖДИ витягуй ВСІ маркери з бланка, з одиницями і референсами як надруковано; ДНК-звіт теж kind "labs" (запис факту), а постійні риси — у profile_updates.dna_traits;
    wellbeing/note → {} },
  "profile_updates": { ОПЦІЙНО: довготривалі факти для профілю — коли Андрій повідомляє/підтверджує зріст, цільову вагу, травму, обмеження, вподобання, ціль, прийнятий тижневий план, генетичні риси. Ключі англійською snake_case: height_cm, target_weight_kg, birth_year, injuries, constraints, preferences, goals, weekly_plan, dna_traits. Значення null = видалити ключ. НЕ дублюй сюди разові факти (їжу/сон) — вони йдуть у журнал. },
  "reply": "твоя відповідь Андрію як коуча-ментора, Telegram HTML"
}
"other" — коли вхід НЕ є новим фактом про здоровʼя (питання, розмова, підтвердження плану): тоді data={} і reply — відповідь по суті (profile_updates при цьому МОЖНА давати, напр. коли Андрій приймає план).
Для labs у reply дай розбір: що в нормі, що ні, пріоритети, що обговорити з лікарем.`;

export interface CoachParsed {
  kind: HealthKind | 'other';
  title: string;
  data: Record<string, unknown>;
  profileUpdates: Record<string, unknown> | null;
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
    const obj = JSON.parse(text) as Partial<CoachParsed> & { profile_updates?: Record<string, unknown> };
    const kind = String(obj.kind ?? '');
    if (kind !== 'other' && !HEALTH_KINDS.includes(kind as HealthKind)) return null;
    const reply = String(obj.reply ?? '').trim();
    if (!reply) return null;
    return {
      kind: kind as CoachParsed['kind'],
      title: String(obj.title ?? '').slice(0, 300),
      data: obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : {},
      profileUpdates:
        obj.profile_updates && typeof obj.profile_updates === 'object' && Object.keys(obj.profile_updates).length > 0
          ? obj.profile_updates
          : null,
      reply,
    };
  } catch {
    return null;
  }
}

// Daily-cron decision. Pure + exported for tests.
export function nudgeDecision(todayCount: number, priorDaysCount: number): 'digest' | 'nudge' | 'silent' {
  if (todayCount > 0) return 'digest';
  if (priorDaysCount > 0) return 'nudge';
  return 'silent';
}

function makeClient(config: AppConfig): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.anthropicApiKey, timeout: 120_000, maxRetries: 2 });
}

// Shared grounding for every call: profile + code-computed stats + raw journal.
interface CoachContext {
  rows: HealthRow[];
  profile: Record<string, unknown>;
  block: string;
}

async function gatherCoachContext(userId: number, timezone: string, days: number): Promise<CoachContext> {
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const yearISO = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  // Labs get their OWN year-long window: a draw from May must inform an August
  // verdict even though the food journal only looks back `days`.
  const [rows, labsRows, profile] = await Promise.all([
    fetchHealthSince(userId, sinceISO),
    fetchHealthSince(userId, yearISO, ['labs']),
    getProfile(userId),
  ]);
  const parts = [
    `=== ПРОФІЛЬ АНДРІЯ (довготривала памʼять) ===\n${serializeProfile(profile)}\n=== КІНЕЦЬ ПРОФІЛЮ ===`,
    serializeStats(computeStats(rows, timezone, days)),
  ];
  const trend = serializeLabsTrend(labsTrend(labsRows));
  if (trend) parts.push(trend);
  parts.push(`=== ЖУРНАЛ (останні ${days} дн) ===\n${serializeHealthRows(rows, timezone)}\n=== КІНЕЦЬ ЖУРНАЛУ ===`);
  return { rows, profile, block: parts.join('\n\n') };
}

// Persist model-emitted profile updates; footer tells Andrii what was learned.
async function applyProfileUpdates(userId: number, parsed: CoachParsed): Promise<string> {
  if (!parsed.profileUpdates) return '';
  const merged = mergeProfile(await getProfile(userId), parsed.profileUpdates);
  const ok = await saveProfile(userId, merged);
  if (!ok) return '\n\n⚠️ <i>Не зміг зберегти оновлення профілю (база недоступна).</i>';
  return `\n\n🧠 <i>Запамʼятав: ${Object.keys(parsed.profileUpdates).join(', ')}</i>`;
}

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

  const ctx = await gatherCoachContext(userId, config.timezone, 14);
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
- їжа/напій → оціни склад, ≈калорії та макроси, дай вердикт відносно його дня, плану і журналу;
- бланк аналізів (лабораторія) → витягни ВСІ маркери зі значеннями/одиницями/референсами; у reply — розбір: що не в нормі, що «формально ок, але не оптимум», порівняння з попередніми заборами (блок «ДИНАМІКА МАРКЕРІВ», якщо є), топ-3 пріоритети дій, червоні прапори → «до лікаря»;
- ДНК/генетичний звіт → kind "labs" + постійні риси в profile_updates.dna_traits; у reply — що це означає ПРАКТИЧНО для його їжі/тренувань;
- скриншот трекера (сон, ваги, годинник, тренування) → витягни числа;
- щось інше → kind "other".
Багатосторінкові аналізи можуть приходити кількома фото поспіль — якщо в журналі СЬОГОДНІ вже є labs-запис, це може бути продовження того самого бланка: не панікуй про «дублікат», просто витягни маркери з ЦІЄЇ сторінки.

${JSON_CONTRACT}

${ctx.block}

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
    const profileFooter = await applyProfileUpdates(userId, parsed);
    // The photo exchange joins conversation memory in compact text form, so a
    // follow-up «а скільки там білка було?» has an anchor.
    void storeTurn(userId, 'user', `[фото${isPdf ? '/PDF' : ''}] ${caption || parsed.title}`.trim());
    void storeTurn(userId, 'assistant', parsed.reply.slice(0, 1500));
    log({
      level: 'info',
      action: 'health_photo_analyzed',
      userId,
      details: { kind: parsed.kind, stored: id !== null, durationMs: Date.now() - start, pdf: isPdf },
    });
    return parsed.reply + storedFooter(parsed, id) + profileFooter;
  } catch (err) {
    log({ level: 'error', action: 'health_photo_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Free text — a fact to log, a question, or plan talk. Full mentor mode:
 *  conversation history + profile + stats + journal. */
export async function handleText(config: AppConfig, userId: number, text: string): Promise<string> {
  const client = makeClient(config);
  if (!client) return '⚠️ Claude API не підключений';

  const [ctx, history] = await Promise.all([
    gatherCoachContext(userId, config.timezone, 14),
    loadTurns(userId, 16),
  ]);

  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 1600,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Андрій пише тобі в чат. Випадки:
1) НОВИЙ ФАКТ про здоровʼя (вага, сон, тренування, їжа словами, самопочуття) → класифікуй, витягни числа, підтверди коротко (1-3 речення) з одним коуч-коментарем.
2) ДОВГОТРИВАЛИЙ факт або рішення (зріст, ціль, травма, обмеження, «приймаю план») → kind "other" АБО відповідний kind + профіль через profile_updates.
3) ПИТАННЯ або розмова (скільки калорій, яка динаміка, що їсти, як спати, план на тиждень) → kind "other", відповідай як ментор НА ОСНОВІ статистики і журналу; чого нема в даних — чесно кажи.

${JSON_CONTRACT}

${ctx.block}

Зараз: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone })}`,
      messages: [...history, { role: 'user' as const, content: text }],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text ?? '';
    const parsed = parseCoachJson(raw);
    if (!parsed) return '⚠️ Не зрозумів. Спробуй конкретніше: «вага 91.2», «спав 6 год», «тренування ноги 45 хв» — або постав питання.';

    let out: string;
    if (parsed.kind === 'other') {
      out = parsed.reply;
    } else {
      const id = await logHealth(userId, parsed.kind, parsed.title, parsed.data);
      out = parsed.reply + storedFooter(parsed, id);
    }
    out += await applyProfileUpdates(userId, parsed);
    void storeTurn(userId, 'user', text);
    void storeTurn(userId, 'assistant', parsed.reply.slice(0, 1500));
    return out;
  } catch (err) {
    log({ level: 'error', action: 'health_text_error', details: { error: String(err).slice(0, 200) } });
    return '⚠️ Не вдалося обробити. Спробуй ще раз.';
  }
}

/** On-demand + weekly report. Ends with a proposed NEXT-WEEK plan Andrii can
 *  accept in one reply («прийнято» → the text turn saves weekly_plan). Null
 *  when the window has no data. */
export async function runHealthReport(
  config: AppConfig,
  userId: number,
  opts: { days?: number } = {},
): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;
  const days = opts.days && opts.days >= 1 ? Math.min(opts.days, 90) : 7;
  const ctx = await gatherCoachContext(userId, config.timezone, days);
  if (ctx.rows.length === 0) return null;

  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 1800,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Побудуй health-звіт за ${days} дн ТІЛЬКИ з даних нижче (числа — зі СТАТИСТИКИ, не рахуй сам). Структура:
💪 <b>Пульс тіла · ${days} дн</b>
<b>Їжа / Тренування / Сон / Вага:</b> по рядку на кожне — факт зі статистики + чесний коментар; «не логував» де пусто.
<b>Аналізи:</b> маркери поза нормою з журналу, якщо є.
<b>Проти плану:</b> якщо в профілі є weekly_plan — що виконано, що зірвано. Якщо плану нема — пропусти.
<b>Вердикт:</b> 2-3 речення прямо.
<b>📋 План на наступний тиждень:</b> 3-4 конкретні пункти (тренування з днями, білок/ккал таргет, сон), реалістичні відносно його журналу. Заверши рядком: «Відповіси "прийнято" — зафіксую план.»`,
      messages: [{ role: 'user', content: 'Тижневий звіт.' }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    log({ level: 'info', action: 'health_report_run', userId, details: { days, rows: ctx.rows.length } });
    if (text) void storeTurn(userId, 'assistant', `[тижневий звіт] ${text.slice(0, 1200)}`);
    return text || null;
  } catch (err) {
    log({ level: 'error', action: 'health_report_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Daily 20:45 digest. digest → LLM summary vs plan; nudge → static one-liner
 *  (no LLM call); silent → null. */
export async function runHealthDaily(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const todayStartISO = startOfDayUtcISO(config.timezone, todayInTz(config.timezone));
  const todayCut = new Date(todayStartISO).getTime();
  const ctx = await gatherCoachContext(userId, config.timezone, 4);
  const today = ctx.rows.filter((r) => r.logged_at.getTime() >= todayCut);
  const prior = ctx.rows.length - today.length;

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
Що зʼїв (≈сумарні калорії, якщо є записи), тренування/сон/вага якщо логував. Якщо в профілі є weekly_plan — одним рядком: день відносно плану (виконано/зірвано що саме). Один чесний вердикт + ОДНА конкретна порада на завтра. Категорії без записів — одним словом «не логував».

СЬОГОДНІШНІ ЗАПИСИ:
${serializeHealthRows(today, config.timezone)}`,
      messages: [{ role: 'user', content: 'Дайджест дня.' }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    log({ level: 'info', action: 'health_daily_run', userId, details: { today: today.length, prior } });
    return text || null;
  } catch (err) {
    log({ level: 'error', action: 'health_daily_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Morning check-in 07:45 — sets the day's focus BEFORE the day happens (the
 *  digest judges after; a mentor also aims before). Fires ONLY when there's a
 *  relationship to lean on: a non-empty profile OR any log in the last 7 days.
 *  Otherwise silent — never nags a user who hasn't engaged. */
export async function runMorningCheckin(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const ctx = await gatherCoachContext(userId, config.timezone, 7);
  if (Object.keys(ctx.profile).length === 0 && ctx.rows.length === 0) return null;

  const weekday = new Date().toLocaleDateString('uk-UA', { weekday: 'long', timeZone: config.timezone });
  try {
    const response = await client.messages.create({
      model: MODELS.PRIMARY,
      max_tokens: 700,
      system: `${COACH_PERSONA}

${ANTI_HALLUCINATION_BLOCK}

Ранковий чек-ін (~400 символів, сьогодні ${weekday}):
🌅 <b>Пульс тіла · фокус дня</b>
Якщо в профілі є weekly_plan — що з плану припадає на сьогодні (тренування? білок? сон-таргет). Один рядок про вчора (тільки якщо в журналі Є вчорашні записи — інакше не згадуй). ОДНА конкретна ціль на сьогодні. Без води і без моралі.`,
      messages: [{ role: 'user', content: 'Ранковий чек-ін.' }],
    });
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    log({ level: 'info', action: 'health_morning_run', userId, details: { rows: ctx.rows.length } });
    return text || null;
  } catch (err) {
    log({ level: 'error', action: 'health_morning_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}
