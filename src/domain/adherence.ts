// Adherence — the plan scored against reality, in code.
//
// Process over outcome: «4 тренування цього тижня» is something Andrii
// controls; «−1 кг» is not. So every target is scored on what he did, and the
// overall number is the mean of the per-target ratios — one blown target
// doesn't zero the week, and one overachieved target doesn't hide a blown one
// (ratios are clamped at 1).

import { Target, targetSpec } from '../targets.js';
import { METRIC } from './metrics.js';

export interface Actuals {
  /** day -> metric -> value */
  byDay: Map<string, Map<string, number>>;
  strengthSessions: number;
  zone2Min: number;
  vo2maxSessions: number;
  alcoholUnits: number;
  daysInWindow: number;
}

export interface TargetScore {
  key: string;
  label: string;
  target: number;
  actual: number | null;
  unit: string;
  /** 0..1, clamped; null when there is no data to score against */
  ratio: number | null;
  met: boolean;
  /** days with data, for per-day targets */
  daysMeasured: number;
}

export interface AdherenceReport {
  scores: TargetScore[];
  /** 0..100; null when nothing could be measured */
  overall: number | null;
  measured: number;
  unmeasured: string[];
}

const avgOf = (byDay: Map<string, Map<string, number>>, metric: string): { avg: number; days: number } | null => {
  const vals: number[] = [];
  for (const day of byDay.values()) {
    const v = day.get(metric);
    if (typeof v === 'number') vals.push(v);
  }
  if (vals.length === 0) return null;
  return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, days: vals.length };
};

const METRIC_FOR_TARGET: Record<string, string> = {
  protein_g_per_day: METRIC.PROTEIN_G,
  kcal_per_day: METRIC.KCAL_IN,
  steps_per_day: METRIC.STEPS,
  sleep_h_per_night: METRIC.SLEEP_H,
  weight_kg: METRIC.WEIGHT_KG,
};

function actualFor(target: Target, a: Actuals): { value: number; days: number } | null {
  const metric = METRIC_FOR_TARGET[target.key];
  if (metric) {
    const r = avgOf(a.byDay, metric);
    return r ? { value: Math.round(r.avg * 10) / 10, days: r.days } : null;
  }
  switch (target.key) {
    case 'strength_sessions_per_week':
      return { value: a.strengthSessions, days: a.daysInWindow };
    case 'zone2_min_per_week':
      return { value: a.zone2Min, days: a.daysInWindow };
    case 'vo2max_sessions_per_week':
      return { value: a.vo2maxSessions, days: a.daysInWindow };
    case 'alcohol_units_per_week':
      return { value: a.alcoholUnits, days: a.daysInWindow };
    default:
      return null;
  }
}

/** Pure. Weekly-cadence targets are pro-rated to the window so a 3-day window
 *  isn't scored against a 7-day goal. */
export function computeAdherence(targets: Target[], actuals: Actuals): AdherenceReport {
  const scores: TargetScore[] = [];
  const unmeasured: string[] = [];

  for (const t of targets) {
    const spec = targetSpec(t.key);
    if (!spec) continue;
    // A body-weight goal is an outcome, not a process — it is reported
    // elsewhere and deliberately excluded from the adherence score.
    if (t.key === 'weight_kg') continue;

    const actual = actualFor(t, actuals);
    const scaled =
      spec.cadence === 'week' ? (t.value * Math.min(actuals.daysInWindow, 7 * 4)) / 7 : t.value;

    if (!actual) {
      unmeasured.push(spec.label);
      scores.push({
        key: t.key,
        label: spec.label,
        target: Math.round(scaled * 10) / 10,
        actual: null,
        unit: spec.unit,
        ratio: null,
        met: false,
        daysMeasured: 0,
      });
      continue;
    }

    let ratio: number;
    if (spec.higherIsBetter) {
      ratio = scaled > 0 ? actual.value / scaled : 1;
    } else {
      // Under-the-cap targets score 1 while at or below the cap and decay
      // linearly to 0 at double the cap.
      ratio = scaled > 0 ? Math.max(0, 2 - actual.value / scaled) : actual.value === 0 ? 1 : 0;
    }
    const clamped = Math.max(0, Math.min(1, ratio));
    scores.push({
      key: t.key,
      label: spec.label,
      target: Math.round(scaled * 10) / 10,
      actual: actual.value,
      unit: spec.unit,
      ratio: Math.round(clamped * 100) / 100,
      met: clamped >= 0.95,
      daysMeasured: actual.days,
    });
  }

  const scored = scores.filter((s) => s.ratio !== null);
  const overall =
    scored.length > 0
      ? Math.round((scored.reduce((acc, s) => acc + (s.ratio ?? 0), 0) / scored.length) * 100)
      : null;

  return { scores, overall, measured: scored.length, unmeasured };
}

export function serializeAdherence(r: AdherenceReport, days: number): string {
  if (r.scores.length === 0) return '';
  const lines = [`=== ВИКОНАННЯ ПЛАНУ ЗА ${days} ДН (пораховано кодом — цитуй ЦІ числа) ===`];
  lines.push(r.overall !== null ? `Загалом: ${r.overall}% (по ${r.measured} вимірюваних цілях)` : 'Загалом: нема що міряти');
  for (const s of r.scores) {
    if (s.actual === null) {
      lines.push(`- ${s.label}: ціль ${s.target} ${s.unit} · ФАКТУ НЕМА (не логував / не виміряно)`);
      continue;
    }
    lines.push(
      `- ${s.label}: ${s.actual} з ${s.target} ${s.unit} · ${Math.round((s.ratio ?? 0) * 100)}% ${s.met ? '✅' : '❌'}`,
    );
  }
  lines.push('=== КІНЕЦЬ ВИКОНАННЯ ===');
  return lines.join('\n');
}
