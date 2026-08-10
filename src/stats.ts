// Adherence numbers computed in CODE, not by the LLM — the model narrates and
// judges, but every count/average/trend it cites comes from here. This is the
// anti-hallucination rule applied to arithmetic. Everything pure + tested.

import { HealthRow } from './store.js';

export interface HealthStats {
  days: number;           // window size
  mealDays: number;       // distinct local dates with ≥1 meal log
  avgCalPerMealDay: number | null; // mean of daily calorie sums over meal-days that have numbers
  avgProteinPerMealDay: number | null;
  workoutCount: number;
  workoutMin: number;     // summed duration where logged
  strengthSessions: number; // distinct days with logged sets
  sleepDays: number;
  avgSleepH: number | null;
  weightFirst: number | null; // earliest weight in window
  weightLast: number | null;  // latest weight in window
  labsCount: number;
  alcoholUnits: number;
}

const localDate = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function computeStats(rows: HealthRow[], tz: string, days: number): HealthStats {
  const calByDay = new Map<string, number>();
  const proteinByDay = new Map<string, number>();
  const mealDays = new Set<string>();
  const strengthDays = new Set<string>();
  let workoutCount = 0;
  let workoutMin = 0;
  const sleepVals: number[] = [];
  const sleepDays = new Set<string>();
  let weightFirst: number | null = null;
  let weightLast: number | null = null;
  let labsCount = 0;
  let alcoholUnits = 0;

  for (const r of rows) {
    const day = localDate(r.logged_at, tz);
    const d = (r.data ?? {}) as Record<string, unknown>;
    const alcohol = numOf(d.alcohol_units);
    if (alcohol !== null) alcoholUnits += alcohol;

    switch (r.kind) {
      case 'meal': {
        mealDays.add(day);
        const cal = numOf(d.calories);
        if (cal !== null) calByDay.set(day, (calByDay.get(day) ?? 0) + cal);
        const protein = numOf(d.protein_g);
        if (protein !== null) proteinByDay.set(day, (proteinByDay.get(day) ?? 0) + protein);
        break;
      }
      case 'workout': {
        workoutCount++;
        const dur = numOf(d.duration_min);
        if (dur !== null) workoutMin += dur;
        if (Array.isArray(d.sets) && d.sets.length > 0) strengthDays.add(day);
        break;
      }
      case 'sleep': {
        const h = numOf(d.sleep_h);
        if (h !== null) {
          sleepVals.push(h);
          sleepDays.add(day);
        }
        break;
      }
      case 'weight': {
        const w = numOf(d.weight_kg);
        if (w !== null) {
          if (weightFirst === null) weightFirst = w; // rows arrive oldest-first
          weightLast = w;
        }
        break;
      }
      case 'labs':
        labsCount++;
        break;
    }
  }

  const avg = (m: Map<string, number>): number | null => {
    const vals = [...m.values()];
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  return {
    days,
    mealDays: mealDays.size,
    avgCalPerMealDay: avg(calByDay),
    avgProteinPerMealDay: avg(proteinByDay),
    workoutCount,
    workoutMin,
    strengthSessions: strengthDays.size,
    sleepDays: sleepDays.size,
    avgSleepH: sleepVals.length ? Math.round((sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) * 10) / 10 : null,
    weightFirst,
    weightLast,
    labsCount,
    alcoholUnits: Math.round(alcoholUnits * 10) / 10,
  };
}

/** Per-day nutrition and body weight derived from events, in the same shape as
 *  wearable metrics so adherence can score both from one map. */
export function nutritionByDay(rows: HealthRow[], tz: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const put = (day: string, metric: string, value: number, add: boolean) => {
    const m = out.get(day) ?? new Map<string, number>();
    m.set(metric, add ? (m.get(metric) ?? 0) + value : value);
    out.set(day, m);
  };
  for (const r of rows) {
    const day = localDate(r.logged_at, tz);
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (r.kind === 'meal') {
      const cal = numOf(d.calories);
      if (cal !== null) put(day, 'kcal_in', cal, true);
      const protein = numOf(d.protein_g);
      if (protein !== null) put(day, 'protein_g', protein, true);
    }
    if (r.kind === 'weight') {
      const w = numOf(d.weight_kg);
      if (w !== null) put(day, 'weight_kg', w, false);
    }
  }
  return out;
}

/** Local dates on which Andrii logged something himself. Oura-sourced rows do
 *  NOT count: the ring syncing overnight is not him engaging with the coach,
 *  and treating it as engagement would silence the nudge that matters. */
export function loggedDays(rows: HealthRow[], tz: string): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.source === 'oura') continue;
    out.add(localDate(r.logged_at, tz));
  }
  return out;
}

/** Prompt block — honest «не логував» for every missing dimension. */
export function serializeStats(s: HealthStats): string {
  const lines = [`=== СТАТИСТИКА ЗА ${s.days} ДН (пораховано кодом — цитуй ЦІ числа) ===`];
  lines.push(
    s.mealDays > 0
      ? `Їжа: логував ${s.mealDays} дн${s.avgCalPerMealDay !== null ? `, ≈${s.avgCalPerMealDay} ккал/день` : ' (без калорій)'}${s.avgProteinPerMealDay !== null ? `, білок ≈${s.avgProteinPerMealDay} г/день` : ''} (по днях із записами)`
      : 'Їжа: не логував',
  );
  lines.push(
    s.workoutCount > 0
      ? `Тренування: ${s.workoutCount}${s.workoutMin ? ` · ${s.workoutMin} хв сумарно` : ''}${s.strengthSessions ? ` · силових із підходами: ${s.strengthSessions}` : ''}`
      : 'Тренування: нуль',
  );
  lines.push(s.avgSleepH !== null ? `Сон (із журналу): ≈${s.avgSleepH} год у середньому (${s.sleepDays} дн)` : 'Сон: не логував');
  lines.push(
    s.weightFirst !== null && s.weightLast !== null
      ? `Вага: ${s.weightFirst} → ${s.weightLast} кг`
      : 'Вага: не логував',
  );
  if (s.alcoholUnits > 0) lines.push(`Алкоголь: ${s.alcoholUnits} од. сумарно`);
  if (s.labsCount > 0) lines.push(`Аналізи: ${s.labsCount} запис(и) у вікні`);
  lines.push('=== КІНЕЦЬ СТАТИСТИКИ ===');
  return lines.join('\n');
}
