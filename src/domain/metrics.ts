// Daily metrics — the derived layer. One row per (day, metric, source), always
// recomputable from events or re-fetchable from Oura, so an upsert is always
// safe and a re-sync never double-counts.

import { getPool } from '../store.js';
import { log } from '../logger.js';

/** Canonical metric keys. Adapters translate into these; nothing else. */
export const METRIC = {
  SLEEP_H: 'sleep_h',
  SLEEP_START_MIN: 'sleep_start_min', // minutes from local midnight, negative = before midnight
  SLEEP_END_MIN: 'sleep_end_min',
  SLEEP_EFFICIENCY: 'sleep_efficiency',
  SLEEP_SCORE: 'sleep_score',
  DEEP_H: 'deep_h',
  REM_H: 'rem_h',
  HRV_MS: 'hrv_ms',
  RHR_BPM: 'rhr_bpm',
  BREATH_RATE: 'breath_rate',
  READINESS: 'readiness',
  TEMP_DEV_C: 'temp_dev_c',
  STEPS: 'steps',
  ACTIVE_KCAL: 'active_kcal',
  TOTAL_KCAL: 'total_kcal',
  ZONE2_MIN: 'zone2_min',
  HIGH_ACTIVITY_MIN: 'high_activity_min',
  STRESS_HIGH_MIN: 'stress_high_min',
  RECOVERY_HIGH_MIN: 'recovery_high_min',
  VO2MAX: 'vo2max',
  SPO2_PCT: 'spo2_pct',
  WEIGHT_KG: 'weight_kg',
  KCAL_IN: 'kcal_in',
  PROTEIN_G: 'protein_g',
} as const;

export type MetricKey = (typeof METRIC)[keyof typeof METRIC];

export interface DailyMetric {
  day: string; // YYYY-MM-DD local
  metric: string;
  source: string;
  value: number;
  unit: string;
}

const UNITS: Record<string, string> = {
  [METRIC.SLEEP_H]: 'год',
  [METRIC.DEEP_H]: 'год',
  [METRIC.REM_H]: 'год',
  [METRIC.HRV_MS]: 'мс',
  [METRIC.RHR_BPM]: 'уд/хв',
  [METRIC.STEPS]: 'кроків',
  [METRIC.ACTIVE_KCAL]: 'ккал',
  [METRIC.TOTAL_KCAL]: 'ккал',
  [METRIC.KCAL_IN]: 'ккал',
  [METRIC.PROTEIN_G]: 'г',
  [METRIC.ZONE2_MIN]: 'хв',
  [METRIC.HIGH_ACTIVITY_MIN]: 'хв',
  [METRIC.STRESS_HIGH_MIN]: 'хв',
  [METRIC.RECOVERY_HIGH_MIN]: 'хв',
  [METRIC.WEIGHT_KG]: 'кг',
  [METRIC.SPO2_PCT]: '%',
  [METRIC.SLEEP_EFFICIENCY]: '%',
  [METRIC.TEMP_DEV_C]: '°C',
};

export const unitFor = (metric: string): string => UNITS[metric] ?? '';

/** Bulk upsert. Values that are not finite numbers are silently dropped —
 *  upstream nulls are normal (a night without the ring has no HRV). */
export async function upsertDailyMetrics(
  userId: number,
  source: string,
  rows: Array<{ day: string; metric: string; value: number | null | undefined }>,
): Promise<number> {
  const p = getPool();
  if (!p) return 0;
  const clean = rows.filter((r) => typeof r.value === 'number' && Number.isFinite(r.value)) as Array<{
    day: string;
    metric: string;
    value: number;
  }>;
  if (clean.length === 0) return 0;

  try {
    // One statement, unnested arrays — a 4-year backfill is thousands of rows
    // and a per-row round trip would take minutes.
    await p.query(
      `insert into hermes.health_daily_metric (user_id, day, metric, source, value, unit, updated_at)
       select $1, d::date, m, $2, v, u, now()
         from unnest($3::text[], $4::text[], $5::double precision[], $6::text[]) as t(d, m, v, u)
       on conflict (user_id, day, metric, source)
       do update set value = excluded.value, unit = excluded.unit, updated_at = now()`,
      [
        userId,
        source,
        clean.map((r) => r.day),
        clean.map((r) => r.metric),
        clean.map((r) => r.value),
        clean.map((r) => unitFor(r.metric)),
      ],
    );
    return clean.length;
  } catch (err) {
    log({ level: 'error', action: 'daily_metric_upsert_error', details: { error: String(err).slice(0, 200) } });
    return 0;
  }
}

export async function fetchDailyMetrics(userId: number, sinceDay: string, metrics?: string[]): Promise<DailyMetric[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const params: unknown[] = [userId, sinceDay];
    let filter = '';
    if (metrics && metrics.length > 0) {
      params.push(metrics);
      filter = 'and metric = any($3)';
    }
    const res = await p.query<{ day: Date; metric: string; source: string; value: string; unit: string }>(
      `select day, metric, source, value, unit
         from hermes.health_daily_metric
        where user_id = $1 and day >= $2 ${filter}
        order by day asc`,
      params,
    );
    return res.rows.map((r) => ({
      day: typeof r.day === 'string' ? r.day : r.day.toISOString().slice(0, 10),
      metric: r.metric,
      source: r.source,
      value: Number(r.value),
      unit: r.unit,
    }));
  } catch (err) {
    log({ level: 'error', action: 'daily_metric_fetch_error', details: { error: String(err).slice(0, 200) } });
    return [];
  }
}

/** day -> metric -> value. When two sources report the same metric on the same
 *  day, the measured one (a wearable) beats the self-reported one. */
export function indexByDay(rows: DailyMetric[]): Map<string, Map<string, number>> {
  const priority = (src: string) => (src === 'oura' ? 2 : 1);
  const seen = new Map<string, Map<string, string>>();
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const day = out.get(r.day) ?? new Map<string, number>();
    const srcs = seen.get(r.day) ?? new Map<string, string>();
    const prev = srcs.get(r.metric);
    if (prev === undefined || priority(r.source) >= priority(prev)) {
      day.set(r.metric, r.value);
      srcs.set(r.metric, r.source);
    }
    out.set(r.day, day);
    seen.set(r.day, srcs);
  }
  return out;
}

const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

export interface MetricSummary {
  metric: string;
  days: number;
  avg: number;
  min: number;
  max: number;
  last: number;
  /** avg of the most recent third vs the oldest third — direction of travel */
  trend: 'up' | 'down' | 'flat';
}

export function summarizeMetric(rows: DailyMetric[], metric: string): MetricSummary | null {
  const vals = rows.filter((r) => r.metric === metric).map((r) => r.value);
  if (vals.length === 0) return null;
  const third = Math.max(1, Math.floor(vals.length / 3));
  const head = vals.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const tail = vals.slice(-third).reduce((a, b) => a + b, 0) / third;
  const delta = tail - head;
  const scale = Math.abs(head) > 0 ? Math.abs(delta / head) : 0;
  return {
    metric,
    days: vals.length,
    avg: round(vals.reduce((a, b) => a + b, 0) / vals.length, 1),
    min: round(Math.min(...vals), 1),
    max: round(Math.max(...vals), 1),
    last: round(vals[vals.length - 1], 1),
    trend: scale < 0.03 ? 'flat' : delta > 0 ? 'up' : 'down',
  };
}

const LABELS: Record<string, string> = {
  [METRIC.SLEEP_H]: 'Сон',
  [METRIC.HRV_MS]: 'HRV (варіабельність пульсу)',
  [METRIC.RHR_BPM]: 'Пульс спокою',
  [METRIC.READINESS]: 'Готовність (Oura)',
  [METRIC.SLEEP_SCORE]: 'Оцінка сну (Oura)',
  [METRIC.STEPS]: 'Кроки',
  [METRIC.ACTIVE_KCAL]: 'Активні калорії',
  [METRIC.ZONE2_MIN]: 'Зона 2 (середня активність)',
  [METRIC.HIGH_ACTIVITY_MIN]: 'Висока інтенсивність',
  [METRIC.STRESS_HIGH_MIN]: 'Високий стрес',
  [METRIC.VO2MAX]: 'VO2max',
  [METRIC.SPO2_PCT]: 'SpO2',
  [METRIC.WEIGHT_KG]: 'Вага',
  [METRIC.TEMP_DEV_C]: 'Відхилення температури тіла',
  [METRIC.DEEP_H]: 'Глибокий сон',
  [METRIC.REM_H]: 'REM-сон',
};

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

/** Prompt block. Only metrics that actually have data appear — an absent line
 *  means "no measurement", never "zero". */
export function serializeMetrics(rows: DailyMetric[], days: number): string {
  const order = [
    METRIC.SLEEP_H,
    METRIC.HRV_MS,
    METRIC.RHR_BPM,
    METRIC.READINESS,
    METRIC.SLEEP_SCORE,
    METRIC.DEEP_H,
    METRIC.REM_H,
    METRIC.STEPS,
    METRIC.ZONE2_MIN,
    METRIC.HIGH_ACTIVITY_MIN,
    METRIC.ACTIVE_KCAL,
    METRIC.STRESS_HIGH_MIN,
    METRIC.SPO2_PCT,
    METRIC.VO2MAX,
    METRIC.WEIGHT_KG,
    METRIC.TEMP_DEV_C,
  ];
  const lines: string[] = [];
  for (const m of order) {
    const s = summarizeMetric(rows, m);
    if (!s) continue;
    const unit = unitFor(m);
    lines.push(
      `- ${LABELS[m] ?? m}: середнє ${s.avg}${unit ? ' ' + unit : ''} · останнє ${s.last} · діапазон ${s.min}–${s.max} · ${ARROW[s.trend]} (${s.days} дн з даними)`,
    );
  }
  if (lines.length === 0) return '';
  return [
    `=== ВИМІРЯНІ МЕТРИКИ ЗА ${days} ДН (з носимого пристрою, пораховано кодом — цитуй ЦІ числа) ===`,
    ...lines,
    '=== КІНЕЦЬ МЕТРИК ===',
  ].join('\n');
}
