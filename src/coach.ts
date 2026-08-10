// The coach — v3.
//
// The division of labour is now strict: CODE measures, the MODEL narrates and
// prioritizes. Every number the coach can cite (sleep regularity, HRV baseline,
// adherence %, estimated 1RM, marker trends) is computed by a pure function and
// handed over as text; the model is forbidden from doing arithmetic and has no
// reason to. Facts come back through forced tool use, so there is no JSON to
// rescue from prose.

import Anthropic from '@anthropic-ai/sdk';
import { MODELS, EFFORT } from './models.js';
import { AppConfig } from './config.js';
import { log } from './logger.js';
import { ANTI_HALLUCINATION_BLOCK } from './prompts.js';
import { todayInTz, startOfDayUtcISO, lastNDays, offsetHours, localDay } from './day.js';
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
import { computeStats, serializeStats, nutritionByDay, loggedDays } from './stats.js';
import {
  fetchMarkerSeries,
  serializeMarkerSeries,
  toMarkerRows,
  saveMarkers,
  latestReadings,
  staleFlagged,
} from './labs.js';
import { fetchDailyMetrics, indexByDay, serializeMetrics, METRIC } from './domain/metrics.js';
import { computeRegularity, serializeRegularity, SleepSession } from './domain/sleep.js';
import { computeAdherence, serializeAdherence } from './domain/adherence.js';
import { getTargets, saveTargets, validateTargets, serializeTargets, Target } from './targets.js';
import { evaluateTriggers, serializeTriggers, Trigger, peakSeverity } from './domain/triggers.js';
import { checkCritical, formatCriticalWarning } from './domain/safety.js';
import { exerciseKey, computePRs, hardSetCount, serializeStrength, ExerciseSet } from './domain/strength.js';
import { saveExerciseSets, fetchExerciseSets } from './domain/strength-store.js';
import { LOG_HEALTH_TOOL, LOG_TOOL_NAME, normalizeToolInput, CoachParsed } from './reason/schema.js';

const COACH_PERSONA = `Ти — «Пульс тіла», персональний world-class health/fitness/longevity коуч-ментор Андрія Сусленка: нутриціолог, силовий і кардіо тренер, коуч сну, відновлення та довголіття в одній особі.

Твоя рамка — пʼять стовпів довголіття:
1. Тренування: сила (2-3×/тиж, прогресивне перевантаження), зона 2 (150+ хв/тиж), VO2max-інтервали (1×/тиж), мобільність і рівновага. М'язова маса після 40 — головний актив.
2. Харчування: білок ≥1.6 г/кг/день, розподілений на 3-4 прийоми; цільні продукти, мінімум ультра-обробленого і цукру. Калорії — під ціль ваги.
3. Сон: 7-8 год, і головне — СТАБІЛЬНИЙ час. Регулярність ритму важить більше за окрему довгу ніч.
4. Відновлення і стрес: HRV і пульс спокою — компас навантаження. Перетренованість = крок назад.
5. Біомаркери: аналізи (ApoB, глюкоза/HbA1c, вітамін D, запалення) — компас, не вирок.

Поведінка МЕНТОРА:
- ПРЯМИЙ У ФАКТАХ, АВТОНОМНИЙ У РІШЕННЯХ. Факт називаєш як є («ти зробив 1 тренування з 3»), а рішення лишаєш Андрію («що реалістично наступного тижня — зменшити до 2 чи змінити час?»). Не читай мораль і не тисни виною: на дистанції в роки це знижує, а не підвищує прихильність.
- ПАМ'ЯТАЄШ: користуйся профілем, цілями та історією розмови. НЕ перепитуй те, що вже знаєш.
- Коли бракує ключових даних — СПИТАЙ один раз і запамʼятай (profile_updates для прозових фактів, targets для чисел).
- Плани формулюй як IMPLEMENTATION INTENTIONS: не «3 тренування», а «пн 18:30 — ноги, ср 18:30 — верх, сб 10:00 — зона 2». Конкретна прив'язка до часу і ситуації виконується в рази частіше за намір.
- Правило «ніколи не пропускай двічі»: один зрив — шум, два поспіль — початок кінця. Реагуй саме на другий.
- Хвали за процес (зробив), а не за результат (схуд). Порівнюй тільки з ЙОГО даними і цілями.
- МЕЖА: ти не лікар. По аналізах — інтерпретація і пріоритети, але червоні прапори → «обговори з лікарем». Жодних діагнозів і призначень ліків.

АНАЛІЗИ КРОВІ — твоя сильна сторона. Longevity-панель: ApoB (головніший за LDL), Lp(a), LDL/HDL/тригліцериди, глюкоза натще, HbA1c, інсулін (HOMA-IR), сечова кислота, hs-CRP, гомоцистеїн, феритин, ALT/AST/GGT, креатинін/eGFR, TSH, тестостерон, вітамін D (ціль 40-60 ng/ml), B12, фолат, магній, омега-3 індекс.
Правила: трактуй ВІДНОСНО референсів З БЛАНКА і попередніх заборів (блок «ДИНАМІКА МАРКЕРІВ» — цитуй звідти, тренд сам не вигадуй). Оптимум ≠ референс. Пріоритезуй: максимум 3 маркери, з якими працювати зараз.

ДНК/ГЕНЕТИКА: звіти читаєш і трактуєш як СХИЛЬНОСТІ, не вирок. Постійні риси — у profile_updates.dna_traits. Сирі SNP-файли не обробляєш — проси звіт провайдера у PDF.

ФОРМАТ: українською, Telegram HTML (<b>, <i>), БЕЗ markdown. Коротко — не більше ~1200 символів. Оцінки з фото ЗАВЖДИ приблизні: пиши «≈». Якщо на фото не видно порцію — уточни, замість вгадувати.

ЧИСЛА: усі агреговані числа (середні, тренди, відсотки виконання, регулярність сну, рекорди, динаміка маркерів) бери ТІЛЬКИ з блоків, порахованих кодом. Своєї арифметики не роби взагалі.`;

function makeClient(config: AppConfig): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.anthropicApiKey, timeout: 180_000, maxRetries: 2 });
}

/** Persona is ~4KB and identical on every call — cached so we stop paying full
 *  price for it dozens of times a day. */
const personaBlocks = (extra: string) => [
  { type: 'text' as const, text: COACH_PERSONA, cache_control: { type: 'ephemeral' as const } },
  { type: 'text' as const, text: `${ANTI_HALLUCINATION_BLOCK}\n\n${extra}` },
];

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

export interface CoachContext {
  rows: HealthRow[];
  profile: Record<string, unknown>;
  targets: Target[];
  triggers: Trigger[];
  block: string;
}

async function gatherCoachContext(userId: number, timezone: string, days: number): Promise<CoachContext> {
  const sinceISO = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const windowDays = lastNDays(timezone, days);
  const sinceDay = windowDays[0];

  const [rows, profile, targets, metrics, markerSeries, sets] = await Promise.all([
    fetchHealthSince(userId, sinceISO),
    getProfile(userId),
    getTargets(userId),
    fetchDailyMetrics(userId, sinceDay),
    fetchMarkerSeries(userId),
    fetchExerciseSets(userId, sinceISO),
  ]);

  // Wearable metrics and self-reported nutrition/weight land in one map so
  // adherence scores both without caring where a number came from.
  const byDay = indexByDay(metrics);
  for (const [day, m] of nutritionByDay(rows, timezone)) {
    const target = byDay.get(day) ?? new Map<string, number>();
    for (const [k, v] of m) target.set(k, v);
    byDay.set(day, target);
  }

  const sleepTarget = targets.find((t) => t.key === 'sleep_h_per_night')?.value ?? null;

  // Sleep regularity from real bedtimes when the ring provides them.
  const sessions: SleepSession[] = rows
    .filter((r) => r.kind === 'sleep')
    .map((r) => {
      const d = r.data as Record<string, unknown>;
      const start = Date.parse(String(d.bedtime_start ?? ''));
      const end = Date.parse(String(d.bedtime_end ?? ''));
      return { start, end };
    })
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const windowStartMs = Date.parse(startOfDayUtcISO(timezone, sinceDay));
  const regularity = computeRegularity(sessions, windowStartMs, days, offsetHours(timezone, sinceDay) * 60);

  const strengthSets: ExerciseSet[] = sets;
  const prs = computePRs(strengthSets);

  const adherence = computeAdherence(targets, {
    byDay,
    strengthSessions: new Set(
      rows.filter((r) => Array.isArray((r.data as Record<string, unknown>).sets)).map((r) => localDay(r.logged_at, timezone)),
    ).size,
    zone2Min: [...byDay.values()].reduce((acc, m) => acc + (m.get(METRIC.ZONE2_MIN) ?? 0), 0),
    vo2maxSessions: rows.filter((r) => String((r.data as Record<string, unknown>).intensity ?? '').toLowerCase() === 'hard').length,
    alcoholUnits: computeStats(rows, timezone, days).alcoholUnits,
    daysInWindow: days,
  });

  const triggers = evaluateTriggers({
    byDay,
    loggedDays: loggedDays(rows, timezone),
    days: windowDays,
    sleepTargetH: sleepTarget,
    sri: regularity.sri,
    staleFlaggedMarkers: staleFlagged(markerSeries),
  });

  const parts = [
    `=== ПРОФІЛЬ АНДРІЯ (довготривала памʼять) ===\n${serializeProfile(profile)}\n=== КІНЕЦЬ ПРОФІЛЮ ===`,
    `=== ЦІЛІ (типізовані, код звіряє з ними факт) ===\n${serializeTargets(targets)}\n=== КІНЕЦЬ ЦІЛЕЙ ===`,
    serializeStats(computeStats(rows, timezone, days)),
  ];
  const push = (s: string) => {
    if (s) parts.push(s);
  };
  push(serializeMetrics(metrics, days));
  push(serializeRegularity(regularity, sleepTarget));
  push(serializeAdherence(adherence, days));
  push(serializeStrength(prs, hardSetCount(strengthSets), days));
  push(serializeMarkerSeries(markerSeries));
  push(serializeTriggers(triggers));
  parts.push(`=== ЖУРНАЛ (останні ${days} дн) ===\n${serializeHealthRows(rows, timezone)}\n=== КІНЕЦЬ ЖУРНАЛУ ===`);

  return { rows, profile, targets, triggers, block: parts.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

interface CallOptions {
  model: string;
  effort: string;
  maxTokens: number;
  instructions: string;
  messages: Anthropic.MessageParam[];
  forceTool: boolean;
}

/** One place that talks to the API. Forced tool use gives us an already-parsed
 *  object instead of JSON-in-prose; `maxTokens` is generous because on Opus 5
 *  thinking and the answer share that budget. */
async function callModel(
  client: Anthropic,
  opts: CallOptions,
): Promise<{ parsed: CoachParsed | null; text: string }> {
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: personaBlocks(opts.instructions),
    output_config: { effort: opts.effort as 'low' | 'medium' | 'high' },
    ...(opts.forceTool
      ? { tools: [LOG_HEALTH_TOOL as unknown as Anthropic.Tool], tool_choice: { type: 'tool' as const, name: LOG_TOOL_NAME } }
      : {}),
    messages: opts.messages,
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === LOG_TOOL_NAME,
  );
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return { parsed: toolBlock ? normalizeToolInput(toolBlock.input) : null, text };
}

// ---------------------------------------------------------------------------
// Persistence of a parsed turn
// ---------------------------------------------------------------------------

async function applyProfileUpdates(userId: number, parsed: CoachParsed): Promise<string> {
  if (!parsed.profileUpdates) return '';
  const merged = mergeProfile(await getProfile(userId), parsed.profileUpdates);
  const ok = await saveProfile(userId, merged);
  if (!ok) return '\n\n⚠️ <i>Не зміг зберегти оновлення профілю (база недоступна).</i>';
  return `\n\n🧠 <i>Запамʼятав: ${Object.keys(parsed.profileUpdates).join(', ')}</i>`;
}

async function applyTargets(userId: number, parsed: CoachParsed): Promise<string> {
  if (!parsed.targets) return '';
  const { accepted, rejected } = validateTargets(parsed.targets);
  const notes: string[] = [];
  if (accepted.length > 0 && (await saveTargets(userId, accepted))) {
    notes.push(`🎯 <i>Цілі оновлено: ${accepted.map((t) => `${t.key} = ${t.value}`).join(', ')}</i>`);
  }
  if (rejected.length > 0) {
    notes.push(`⚠️ <i>Відхилив: ${rejected.map((r) => `${r.key} (${r.reason})`).join(', ')}</i>`);
  }
  return notes.length ? '\n\n' + notes.join('\n') : '';
}

function storedFooter(parsed: CoachParsed, id: number | null): string {
  if (parsed.kind === 'other') return '';
  if (id === null) return '\n\n⚠️ <i>Проаналізував, але НЕ записав у журнал (база недоступна або це дублікат).</i>';
  return `\n\n📊 <i>Записав: ${parsed.title}${dataSummary(parsed.data)}</i>`;
}

/** Write the event plus everything derived from it: lab markers into their own
 *  table, strength sets into theirs. Returns the reply with footers and any
 *  safety warning prepended. */
async function persistTurn(userId: number, parsed: CoachParsed, loggedAt = new Date()): Promise<string> {
  let out = parsed.reply;
  let warning = '';

  if (parsed.kind !== 'other' && HEALTH_KINDS.includes(parsed.kind as HealthKind)) {
    const id = await logHealth(userId, parsed.kind as HealthKind, parsed.title, parsed.data, { loggedAt });

    if (parsed.kind === 'labs') {
      const rows = toMarkerRows(parsed.data.markers, loggedAt);
      if (rows.length > 0) {
        await saveMarkers(userId, rows, id);
        // The safety floor runs on the numbers we just stored, independently of
        // whatever the model concluded about them.
        const hits = checkCritical(
          rows.map((r) => ({ markerKey: r.markerKey, nameRaw: r.nameRaw, value: r.valueNum, unit: r.unit })),
        );
        warning = formatCriticalWarning(hits);
        if (hits.length > 0) {
          log({ level: 'warn', action: 'critical_lab_value', userId, details: { count: hits.length } });
        }
      }
    }

    if (Array.isArray(parsed.data.sets)) {
      const sets = (parsed.data.sets as Array<Record<string, unknown>>)
        .map((s) => ({
          exerciseRaw: String(s.exercise ?? '').trim(),
          exerciseKey: exerciseKey(String(s.exercise ?? '')),
          weightKg: typeof s.weight_kg === 'number' ? s.weight_kg : null,
          reps: typeof s.reps === 'number' ? Math.round(s.reps) : null,
          rpe: typeof s.rpe === 'number' ? s.rpe : null,
          performedAt: loggedAt,
        }))
        .filter((s) => s.exerciseKey.length > 0);
      if (sets.length > 0) await saveExerciseSets(userId, sets, id);
    }

    out += storedFooter(parsed, id);
  }

  out += await applyProfileUpdates(userId, parsed);
  out += await applyTargets(userId, parsed);
  return warning + out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

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
    const { parsed, text } = await callModel(client, {
      model: MODELS.PRIMARY,
      effort: EFFORT.PRIMARY,
      maxTokens: 8000,
      forceTool: true,
      instructions: `Андрій надіслав фото або документ. Визнач, що це:
- їжа/напій → оціни склад, ≈калорії та макроси, дай вердикт відносно його дня, цілей і журналу;
- бланк аналізів → витягни ВСІ маркери зі значеннями/одиницями/референсами у data.markers; у reply — розбір: що не в нормі, що «формально ок, але не оптимум», порівняння з блоком «ДИНАМІКА МАРКЕРІВ», топ-3 пріоритети, червоні прапори → «до лікаря»;
- ДНК/генетичний звіт → kind "labs" + постійні риси у profile_updates.dna_traits; у reply — що це означає ПРАКТИЧНО;
- скриншот трекера → витягни числа;
- запис силового тренування → обовʼязково заповни data.sets (вправа/вага/повтори), інакше прогресію рахувати нічим;
- щось інше → kind "other".
Багатосторінкові аналізи можуть приходити кількома фото поспіль — якщо в журналі СЬОГОДНІ вже є labs-запис, це продовження того самого бланка: просто витягни маркери з ЦІЄЇ сторінки.

${ctx.block}

Зараз: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone })}`,
      messages: [
        {
          role: 'user',
          content: [mediaBlock, { type: 'text', text: caption ? `Підпис Андрія до фото: ${caption}` : 'Без підпису.' }],
        },
      ],
    });

    if (!parsed) {
      log({ level: 'warn', action: 'health_photo_no_tool', details: { sample: text.slice(0, 120) } });
      return text ? `${text}\n\n⚠️ <i>Не зміг структурувати — у журнал не записав.</i>` : null;
    }

    const reply = await persistTurn(userId, parsed);
    void storeTurn(userId, 'user', `[фото${isPdf ? '/PDF' : ''}] ${caption || parsed.title}`.trim());
    void storeTurn(userId, 'assistant', parsed.reply.slice(0, 1500));
    log({
      level: 'info',
      action: 'health_photo_analyzed',
      userId,
      details: { kind: parsed.kind, durationMs: Date.now() - start, pdf: isPdf },
    });
    return reply;
  } catch (err) {
    log({ level: 'error', action: 'health_photo_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Free text — a fact to log, a question, or plan talk. */
export async function handleText(config: AppConfig, userId: number, text: string): Promise<string> {
  const client = makeClient(config);
  if (!client) return '⚠️ Claude API не підключений';

  const [ctx, history] = await Promise.all([
    gatherCoachContext(userId, config.timezone, 14),
    loadTurns(userId, 16),
  ]);

  try {
    const { parsed, text: raw } = await callModel(client, {
      model: MODELS.FAST,
      effort: EFFORT.FAST,
      maxTokens: 6000,
      forceTool: true,
      instructions: `Андрій пише тобі в чат. Випадки:
1) НОВИЙ ФАКТ (вага, сон, тренування, їжа словами, алкоголь, самопочуття) → класифікуй, витягни числа, підтверди коротко (1-3 речення) з одним коуч-коментарем. Для силового ОБОВʼЯЗКОВО заповни data.sets.
2) ДОВГОТРИВАЛИЙ факт (зріст, травма, обмеження) → profile_updates. ЧИСЛОВА ЦІЛЬ або прийнятий план → targets.
3) ПИТАННЯ або розмова → kind "other", відповідай як ментор НА ОСНОВІ блоків нижче; чого нема в даних — чесно кажи.

${ctx.block}

Зараз: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone })}`,
      messages: [...history, { role: 'user' as const, content: text }],
    });

    if (!parsed) {
      return raw || '⚠️ Не зрозумів. Спробуй конкретніше: «вага 91.2», «спав 6 год», «присід 4×8×80» — або постав питання.';
    }

    const out = await persistTurn(userId, parsed);
    void storeTurn(userId, 'user', text);
    void storeTurn(userId, 'assistant', parsed.reply.slice(0, 1500));
    return out;
  } catch (err) {
    log({ level: 'error', action: 'health_text_error', details: { error: String(err).slice(0, 200) } });
    return '⚠️ Не вдалося обробити. Спробуй ще раз.';
  }
}

/** On-demand + weekly report. Ends with a next-week plan written as
 *  implementation intentions, which the model also stores as typed targets. */
export async function runHealthReport(
  config: AppConfig,
  userId: number,
  opts: { days?: number } = {},
): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;
  const days = opts.days && opts.days >= 1 ? Math.min(opts.days, 365) : 7;
  const ctx = await gatherCoachContext(userId, config.timezone, days);
  if (ctx.rows.length === 0 && ctx.targets.length === 0) return null;

  try {
    const { parsed, text } = await callModel(client, {
      model: MODELS.DEEP,
      effort: EFFORT.DEEP,
      maxTokens: 12000,
      forceTool: true,
      instructions: `Побудуй health-звіт за ${days} дн ТІЛЬКИ з даних нижче. kind="other", у reply — сам звіт. Структура:
💪 <b>Пульс тіла · ${days} дн</b>
<b>Сон:</b> тривалість І регулярність (SRI) — регулярність коментуй окремо, це найнедооціненіший показник.
<b>Відновлення:</b> HRV, пульс спокою, тренди.
<b>Тренування:</b> що зроблено; для силових — конкретні ваги і що ставити наступного разу.
<b>Їжа:</b> калорії/білок проти цілей.
<b>Аналізи:</b> маркери поза нормою і динаміка, якщо є.
<b>Проти плану:</b> відсоток виконання по кожній цілі з блоку «ВИКОНАННЯ ПЛАНУ». Не рахуй сам — цитуй.
<b>Вердикт:</b> 2-3 речення прямо, без моралі.
<b>📋 План на наступний тиждень:</b> 3-4 пункти у форматі implementation intentions — день, час, дія («ср 18:30 — верх тіла»). Реалістично відносно журналу.
І ОБОВʼЯЗКОВО заповни targets числами з цього плану (білок, сон, силові/тиждень, зона 2), щоб код міг рахувати виконання.`,
      messages: [{ role: 'user', content: `Звіт за ${days} днів.` }],
    });

    const reply = parsed ? await persistTurn(userId, parsed) : text;
    log({ level: 'info', action: 'health_report_run', userId, details: { days, rows: ctx.rows.length } });
    if (reply) void storeTurn(userId, 'assistant', `[звіт ${days} дн] ${reply.slice(0, 1200)}`);
    return reply || null;
  } catch (err) {
    log({ level: 'error', action: 'health_report_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Pure + exported for tests: what the evening cron should do. */
export function nudgeDecision(todayCount: number, priorDaysCount: number): 'digest' | 'nudge' | 'silent' {
  if (todayCount > 0) return 'digest';
  if (priorDaysCount > 0) return 'nudge';
  return 'silent';
}

/** Daily 20:45 digest. */
export async function runHealthDaily(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const todayStartISO = startOfDayUtcISO(config.timezone, todayInTz(config.timezone));
  const todayCut = new Date(todayStartISO).getTime();
  const ctx = await gatherCoachContext(userId, config.timezone, 7);
  // Oura rows arrive on their own schedule; the nudge is about whether ANDRII
  // engaged, so only his own entries count as "today has data".
  const today = ctx.rows.filter((r) => r.logged_at.getTime() >= todayCut && r.source !== 'oura');
  const prior = ctx.rows.filter((r) => r.source !== 'oura').length - today.length;

  const decision = nudgeDecision(today.length, prior);
  if (decision === 'silent') return null;
  if (decision === 'nudge') {
    return '🥗 <b>Пульс тіла:</b> за сьогодні жодного запису — ні їжі, ні тренування, ні ваги. День без даних = день, який я не можу покращити. Кинь хоч фото вечері.';
  }

  try {
    const { parsed, text } = await callModel(client, {
      model: MODELS.FAST,
      effort: EFFORT.FAST,
      maxTokens: 4000,
      forceTool: false,
      instructions: `Вечірній міні-дайджест дня (~600 символів). kind не потрібен — просто текст:
🥗 <b>Пульс тіла · сьогодні</b>
Що зʼїв (≈сумарні калорії/білок, якщо є), тренування, вага. Один рядок: день відносно цілей (цитуй блок «ВИКОНАННЯ ПЛАНУ»). Один чесний вердикт + ОДНА конкретна дія на завтра з прив'язкою до часу. Категорії без записів — одним словом «не логував».

${ctx.block}

СЬОГОДНІШНІ ЗАПИСИ:
${serializeHealthRows(today, config.timezone)}`,
      messages: [{ role: 'user', content: 'Дайджест дня.' }],
    });
    const out = parsed?.reply ?? text;
    log({ level: 'info', action: 'health_daily_run', userId, details: { today: today.length, prior } });
    return out || null;
  } catch (err) {
    log({ level: 'error', action: 'health_daily_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Morning check-in 07:45 — sets the day's focus BEFORE the day happens. */
export async function runMorningCheckin(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const ctx = await gatherCoachContext(userId, config.timezone, 7);
  if (Object.keys(ctx.profile).length === 0 && ctx.rows.length === 0 && ctx.targets.length === 0) return null;

  const weekday = new Date().toLocaleDateString('uk-UA', { weekday: 'long', timeZone: config.timezone });
  try {
    const { parsed, text } = await callModel(client, {
      model: MODELS.FAST,
      effort: EFFORT.FAST,
      maxTokens: 3000,
      forceTool: false,
      instructions: `Ранковий чек-ін (~400 символів, сьогодні ${weekday}):
🌅 <b>Пульс тіла · фокус дня</b>
Якщо в блоці «СИГНАЛИ» є hrv_drop / rhr_spike / temp_deviation — почни з нього і скоригуй навантаження на сьогодні (легше, зона 2 замість силового). Далі: що з цілей припадає на сьогодні. Один рядок про вчора (тільки якщо вчорашні дані Є). ОДНА конкретна ціль на сьогодні з часом. Без води і без моралі.

${ctx.block}`,
      messages: [{ role: 'user', content: 'Ранковий чек-ін.' }],
    });
    const out = parsed?.reply ?? text;
    log({ level: 'info', action: 'health_morning_run', userId, details: { rows: ctx.rows.length, triggers: ctx.triggers.length } });
    return out || null;
  } catch (err) {
    log({ level: 'error', action: 'health_morning_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Event-driven check. Runs a few times a day and stays SILENT unless the data
 *  itself says something — a coach that only speaks on a timer is a calendar. */
export async function runTriggerCheck(config: AppConfig, userId: number): Promise<string | null> {
  const client = makeClient(config);
  if (!client) return null;

  const ctx = await gatherCoachContext(userId, config.timezone, 14);
  const severity = peakSeverity(ctx.triggers);
  // 'info' triggers are worth mentioning inside a report, never worth a push.
  if (severity !== 'alert' && severity !== 'nudge') return null;

  try {
    const { parsed, text } = await callModel(client, {
      model: MODELS.FAST,
      effort: EFFORT.FAST,
      maxTokens: 3000,
      forceTool: false,
      instructions: `Код виявив сигнал у даних і саме тому ти пишеш ЗАРАЗ, поза розкладом. Одне повідомлення, ≤400 символів:
- назви факт із блоку «СИГНАЛИ» його ж числами (не вигадуй своїх);
- поясни одним реченням, що це означає;
- дай ОДНУ конкретну дію на сьогодні.
Без вступів і без моралі. Якщо сигналів кілька — візьми найважливіший.

${ctx.block}`,
      messages: [{ role: 'user', content: 'Сигнал.' }],
    });
    const out = parsed?.reply ?? text;
    log({ level: 'info', action: 'trigger_check_fired', userId, details: { severity, codes: ctx.triggers.map((t) => t.code) } });
    return out || null;
  } catch (err) {
    log({ level: 'error', action: 'trigger_check_error', details: { error: String(err).slice(0, 200) } });
    return null;
  }
}
