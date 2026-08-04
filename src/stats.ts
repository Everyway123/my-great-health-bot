// Adherence numbers computed in CODE, not by the LLM — the model narrates and
// judges, but every count/average/trend it cites comes from here. This is the
// anti-hallucination rule applied to arithmetic. Everything pure + tested.

import { HealthRow } from './store.js';

export interface HealthStats {
  days: number;           // window size
  mealDays: number;       // distinct local dates with ≥1 meal log
  avgCalPerMealDay: number | null; // mean of daily calorie sums over meal-days that have numbers
  workoutCount: number;
  workoutMin: number;     // summed duration where logged
  sleepDays: number;
  avgSleepH: number | null;
  weightFirst: number | null; // earliest weight in window
  weightLast: number | null;  // latest weight in window
  labsCount: number;
}

const localDate = (d: Date, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

export function computeStats(rows: HealthRow[], tz: string, days: number): HealthStats {
  const calByDay = new Map<string, number>();
  const mealDays = new Set<string>();
  let workoutCount = 0;
  let workoutMin = 0;
  const sleepVals: number[] = [];
  const sleepDays = new Set<string>();
  let weightFirst: number | null = null;
  let weightLast: number | null = null;
  let labsCount = 0;

  for (const r of rows) {
    const day = localDate(r.logged_at, tz);
    const d = (r.data ?? {}) as Record<string, unknown>;
    switch (r.kind) {
      case 'meal': {
        mealDays.add(day);
        if (typeof d.calories === 'number') calByDay.set(day, (calByDay.get(day) ?? 0) + d.calories);
        break;
      }
      case 'workout': {
        workoutCount++;
        if (typeof d.duration_min === 'number') workoutMin += d.duration_min;
        break;
      }
      case 'sleep': {
        if (typeof d.sleep_h === 'number') {
          sleepVals.push(d.sleep_h);
          sleepDays.add(day);
        }
        break;
      }
      case 'weight': {
        if (typeof d.weight_kg === 'number') {
          if (weightFirst === null) weightFirst = d.weight_kg; // rows arrive oldest-first
          weightLast = d.weight_kg;
        }
        break;
      }
      case 'labs':
        labsCount++;
        break;
    }
  }

  const calDays = [...calByDay.values()];
  return {
    days,
    mealDays: mealDays.size,
    avgCalPerMealDay: calDays.length ? Math.round(calDays.reduce((a, b) => a + b, 0) / calDays.length) : null,
    workoutCount,
    workoutMin,
    sleepDays: sleepDays.size,
    avgSleepH: sleepVals.length ? Math.round((sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) * 10) / 10 : null,
    weightFirst,
    weightLast,
    labsCount,
  };
}

/** Prompt block — honest «не логував» for every missing dimension. */
export function serializeStats(s: HealthStats): string {
  const lines = [`=== СТАТИСТИКА ЗА ${s.days} ДН (пораховано кодом — цитуй ЦІ числа) ===`];
  lines.push(
    s.mealDays > 0
      ? `Їжа: логував ${s.mealDays} дн${s.avgCalPerMealDay !== null ? `, ≈${s.avgCalPerMealDay} ккал/день (по днях із записами)` : ' (без калорій)'}`
      : 'Їжа: не логував',
  );
  lines.push(
    s.workoutCount > 0
      ? `Тренування: ${s.workoutCount}${s.workoutMin ? ` · ${s.workoutMin} хв сумарно` : ''}`
      : 'Тренування: нуль',
  );
  lines.push(s.avgSleepH !== null ? `Сон: ≈${s.avgSleepH} год у середньому (${s.sleepDays} дн)` : 'Сон: не логував');
  lines.push(
    s.weightFirst !== null && s.weightLast !== null
      ? `Вага: ${s.weightFirst} → ${s.weightLast} кг`
      : 'Вага: не логував',
  );
  if (s.labsCount > 0) lines.push(`Аналізи: ${s.labsCount} запис(и) у вікні`);
  lines.push('=== КІНЕЦЬ СТАТИСТИКИ ===');
  return lines.join('\n');
}
