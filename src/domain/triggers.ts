// Rule engine: the coach reacts to what the data says, not only to the clock.
//
// Fixed crons ask "what time is it". A real coach asks "what changed". HRV down
// 20% against your own baseline is a reason to move today's squat session; two
// missed days in a row is the moment a habit dies. Both are cheap `if`s over
// data we already have — the model's job is to say it well, not to notice it.
//
// Every rule is pure and returns FACTS, never phrasing.

import { METRIC } from './metrics.js';

export type TriggerCode =
  | 'hrv_drop'
  | 'rhr_spike'
  | 'temp_deviation'
  | 'missed_twice'
  | 'sleep_debt'
  | 'weight_jump'
  | 'irregular_sleep'
  | 'lab_followup'
  | 'streak';

export type Severity = 'info' | 'nudge' | 'alert';

export interface Trigger {
  code: TriggerCode;
  severity: Severity;
  /** Machine facts. The model turns these into a sentence; it must not invent
   *  numbers that aren't here. */
  facts: Record<string, number | string>;
  /** One-line statement of the situation, in case the LLM is unavailable. */
  fallback: string;
}

export interface TriggerInput {
  /** day -> metric -> value, oldest day first when iterated in sorted order */
  byDay: Map<string, Map<string, number>>;
  /** local dates (YYYY-MM-DD) that have at least one user-logged event */
  loggedDays: Set<string>;
  /** local dates in the window, oldest first */
  days: string[];
  sleepTargetH: number | null;
  sri: number | null;
  /** flagged (out-of-range) markers and how long ago they were drawn */
  staleFlaggedMarkers: Array<{ name: string; daysAgo: number }>;
}

const seriesOf = (input: TriggerInput, metric: string): Array<{ day: string; value: number }> =>
  input.days
    .map((day) => ({ day, value: input.byDay.get(day)?.get(metric) }))
    .filter((r): r is { day: string; value: number } => typeof r.value === 'number');

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d;

/** Baseline = everything except the most recent reading, so "today vs my usual"
 *  is not contaminated by today. */
function latestVsBaseline(
  series: Array<{ day: string; value: number }>,
  minBaselineDays: number,
): { latest: number; baseline: number; day: string } | null {
  if (series.length < minBaselineDays + 1) return null;
  const latest = series[series.length - 1];
  const baseline = mean(series.slice(0, -1).map((r) => r.value));
  if (!Number.isFinite(baseline) || baseline === 0) return null;
  return { latest: latest.value, baseline: round(baseline, 1), day: latest.day };
}

export function evaluateTriggers(input: TriggerInput): Trigger[] {
  const out: Trigger[] = [];

  // 1. HRV collapse against personal baseline — the single best "back off today"
  //    signal a ring can give. Threshold is intentionally generous (20%);
  //    day-to-day HRV noise is large and a twitchy rule gets ignored.
  const hrv = latestVsBaseline(seriesOf(input, METRIC.HRV_MS), 6);
  if (hrv && hrv.latest < hrv.baseline * 0.8) {
    out.push({
      code: 'hrv_drop',
      severity: 'alert',
      facts: { hrv: round(hrv.latest), baseline: hrv.baseline, dropPct: Math.round((1 - hrv.latest / hrv.baseline) * 100) },
      fallback: `HRV ${round(hrv.latest)} мс проти базових ${hrv.baseline} — тіло не відновилось.`,
    });
  }

  // 2. Resting heart rate spike — often the first sign of illness, alcohol or
  //    real overreaching, and it moves before subjective feeling does.
  const rhr = latestVsBaseline(seriesOf(input, METRIC.RHR_BPM), 6);
  if (rhr && rhr.latest >= rhr.baseline + 5) {
    out.push({
      code: 'rhr_spike',
      severity: 'nudge',
      facts: { rhr: round(rhr.latest), baseline: rhr.baseline, delta: round(rhr.latest - rhr.baseline) },
      fallback: `Пульс спокою ${round(rhr.latest)} проти базових ${rhr.baseline}.`,
    });
  }

  // 3. Body-temperature deviation — Oura's own illness precursor.
  const temp = seriesOf(input, METRIC.TEMP_DEV_C);
  const lastTemp = temp[temp.length - 1];
  if (lastTemp && lastTemp.value >= 0.5) {
    out.push({
      code: 'temp_deviation',
      severity: 'alert',
      facts: { deviation: round(lastTemp.value, 2) },
      fallback: `Температура тіла на +${round(lastTemp.value, 2)}°C вище твоєї норми.`,
    });
  }

  // 4. Never miss twice. One skipped day is noise; two in a row is where a habit
  //    actually dies, and it is the cheapest intervention point that exists.
  const recent = input.days.slice(-3);
  if (recent.length >= 2 && input.loggedDays.size > 0) {
    const lastTwo = recent.slice(-2);
    const bothEmpty = lastTwo.every((d) => !input.loggedDays.has(d));
    if (bothEmpty) {
      out.push({
        code: 'missed_twice',
        severity: 'nudge',
        facts: { days: 2 },
        fallback: 'Два дні поспіль без жодного запису.',
      });
    }
  }

  // 5. Sleep debt across the recent window.
  if (input.sleepTargetH) {
    const sleep = seriesOf(input, METRIC.SLEEP_H).slice(-5);
    const short = sleep.filter((r) => r.value < input.sleepTargetH! - 1);
    if (sleep.length >= 3 && short.length >= 3) {
      const debt = round(short.reduce((acc, r) => acc + (input.sleepTargetH! - r.value), 0), 1);
      out.push({
        code: 'sleep_debt',
        severity: 'alert',
        facts: { nights: short.length, debtH: debt, target: input.sleepTargetH },
        fallback: `${short.length} ноч(і) з останніх ${sleep.length} нижче цілі — борг ${debt} год.`,
      });
    }
  }

  // 6. Weight jump week over week. Fast gains are water/glycogen far more often
  //    than fat, so this is a "check what changed", not an alarm.
  const weight = seriesOf(input, METRIC.WEIGHT_KG);
  if (weight.length >= 2) {
    const last = weight[weight.length - 1];
    const weekAgo = weight.find((r) => r.day <= shiftDay(last.day, -6)) ?? weight[0];
    const delta = round(last.value - weekAgo.value, 1);
    if (Math.abs(delta) >= 1.5) {
      out.push({
        code: 'weight_jump',
        severity: 'info',
        facts: { delta, from: weekAgo.value, to: last.value },
        fallback: `Вага ${weekAgo.value} → ${last.value} кг (${delta > 0 ? '+' : ''}${delta}).`,
      });
    }
  }

  // 7. Irregular sleep timing — the thing that predicts more than duration does.
  if (input.sri !== null && input.sri < 60) {
    out.push({
      code: 'irregular_sleep',
      severity: 'nudge',
      facts: { sri: input.sri },
      fallback: `Регулярність сну ${input.sri}/100 — доби надто різні між собою.`,
    });
  }

  // 8. A marker was out of range and never rechecked.
  for (const m of input.staleFlaggedMarkers) {
    if (m.daysAgo >= 90) {
      out.push({
        code: 'lab_followup',
        severity: 'info',
        facts: { marker: m.name, daysAgo: m.daysAgo },
        fallback: `${m.name} був поза нормою ${m.daysAgo} дн тому і відтоді не перевірявся.`,
      });
    }
  }

  return out;
}

/** YYYY-MM-DD arithmetic without pulling in a date library. */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function serializeTriggers(triggers: Trigger[]): string {
  if (triggers.length === 0) return '';
  const lines = ['=== СИГНАЛИ (виявлено кодом — це причина написати саме зараз) ==='];
  for (const t of triggers) {
    lines.push(`- [${t.severity}] ${t.code}: ${t.fallback} ${JSON.stringify(t.facts)}`);
  }
  lines.push('=== КІНЕЦЬ СИГНАЛІВ ===');
  return lines.join('\n');
}

/** Highest severity present — decides whether a proactive message is worth
 *  interrupting the day for. */
export function peakSeverity(triggers: Trigger[]): Severity | null {
  if (triggers.some((t) => t.severity === 'alert')) return 'alert';
  if (triggers.some((t) => t.severity === 'nudge')) return 'nudge';
  if (triggers.length > 0) return 'info';
  return null;
}
