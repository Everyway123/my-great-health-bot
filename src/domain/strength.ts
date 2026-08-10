// Strength training as data, not prose.
//
// A coach that says "молодець" after a session is a cheerleader. A coach that
// says «жим 4×8×70, минулого разу 4×8×67.5 — наступний 72.5» is running
// progressive overload, which is the entire mechanism by which strength
// training works. That requires sets, and sets require code.
//
// Pure + tested.

export interface ExerciseSet {
  exerciseKey: string;
  exerciseRaw: string;
  weightKg: number | null;
  reps: number | null;
  rpe: number | null;
  performedAt: Date;
}

/** Normalized key so «жим лежачи», «Жим лежачі», «bench press» collapse into
 *  one exercise. Same idea as markerKey for labs. */
export const exerciseKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-zа-яїієґё0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, '_');

/** Epley estimated 1RM. The standard field formula; accurate enough under ~10
 *  reps, which is where working sets live. */
export function estimate1RM(weightKg: number, reps: number): number {
  if (weightKg <= 0 || reps <= 0) return 0;
  if (reps === 1) return weightKg;
  return Math.round(weightKg * (1 + reps / 30) * 10) / 10;
}

export interface ExercisePR {
  exerciseKey: string;
  exerciseRaw: string;
  bestE1RM: number;
  bestWeightKg: number;
  bestReps: number;
  achievedAt: Date;
  /** the most recent session's top set, for progression decisions */
  lastWeightKg: number | null;
  lastReps: number | null;
  lastAt: Date | null;
}

export function computePRs(sets: ExerciseSet[]): ExercisePR[] {
  const byKey = new Map<string, ExerciseSet[]>();
  for (const s of sets) {
    if (s.weightKg === null || s.reps === null || s.weightKg <= 0 || s.reps <= 0) continue;
    const list = byKey.get(s.exerciseKey) ?? [];
    list.push(s);
    byKey.set(s.exerciseKey, list);
  }

  const out: ExercisePR[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.performedAt.getTime() - b.performedAt.getTime());
    let best = sorted[0];
    let bestE = estimate1RM(best.weightKg!, best.reps!);
    for (const s of sorted) {
      const e = estimate1RM(s.weightKg!, s.reps!);
      if (e > bestE) {
        bestE = e;
        best = s;
      }
    }
    const lastAt = sorted[sorted.length - 1].performedAt;
    const lastSession = sorted.filter((s) => s.performedAt.getTime() === lastAt.getTime());
    const topOfLast = lastSession.reduce((a, b) => (estimate1RM(b.weightKg!, b.reps!) > estimate1RM(a.weightKg!, a.reps!) ? b : a));
    out.push({
      exerciseKey: key,
      exerciseRaw: best.exerciseRaw,
      bestE1RM: bestE,
      bestWeightKg: best.weightKg!,
      bestReps: best.reps!,
      achievedAt: best.performedAt,
      lastWeightKg: topOfLast.weightKg,
      lastReps: topOfLast.reps,
      lastAt,
    });
  }
  return out.sort((a, b) => b.bestE1RM - a.bestE1RM);
}

export interface ProgressionAdvice {
  exerciseKey: string;
  exerciseRaw: string;
  action: 'add_weight' | 'add_reps' | 'hold' | 'deload';
  nextWeightKg: number;
  nextReps: number;
  reason: string;
}

/** Double progression: hold the weight until every working set hits the top of
 *  the rep range, then add the smallest useful increment and drop back to the
 *  bottom of the range. Simple, self-correcting, and the reason most people who
 *  "train hard" still add nothing to the bar in a year.
 *
 *  `increment` defaults to 2.5 kg — the smallest jump most gyms' plates allow. */
export function nextProgression(
  lastSessionSets: ExerciseSet[],
  repRange: { min: number; max: number },
  increment = 2.5,
): ProgressionAdvice | null {
  const valid = lastSessionSets.filter((s) => s.weightKg !== null && s.reps !== null && s.reps > 0);
  if (valid.length === 0) return null;

  const weight = Math.max(...valid.map((s) => s.weightKg!));
  const working = valid.filter((s) => s.weightKg === weight);
  const reps = working.map((s) => s.reps!);
  const minReps = Math.min(...reps);
  const raw = working[0].exerciseRaw;
  const key = working[0].exerciseKey;

  if (minReps >= repRange.max) {
    return {
      exerciseKey: key,
      exerciseRaw: raw,
      action: 'add_weight',
      nextWeightKg: Math.round((weight + increment) * 10) / 10,
      nextReps: repRange.min,
      reason: `усі підходи дійшли до ${repRange.max} повторів — час додати вагу`,
    };
  }
  if (minReps < repRange.min) {
    // Two or more reps below the floor means the load is genuinely too heavy,
    // not just a bad day.
    if (minReps <= repRange.min - 2) {
      return {
        exerciseKey: key,
        exerciseRaw: raw,
        action: 'deload',
        nextWeightKg: Math.round(weight * 0.9 * 10) / 10,
        nextReps: repRange.min,
        reason: `не дотягнув до ${repRange.min} повторів — скинь ~10% і відбудуй`,
      };
    }
    return {
      exerciseKey: key,
      exerciseRaw: raw,
      action: 'hold',
      nextWeightKg: weight,
      nextReps: repRange.min,
      reason: 'тримай вагу, доганяй повтори',
    };
  }
  return {
    exerciseKey: key,
    exerciseRaw: raw,
    action: 'add_reps',
    nextWeightKg: weight,
    nextReps: Math.min(repRange.max, minReps + 1),
    reason: `та сама вага, ціль ${Math.min(repRange.max, minReps + 1)} повторів у всіх підходах`,
  };
}

/** Hard sets per exercise over the window. ~10 hard sets per muscle group per
 *  week is where the returns flatten; below that the session is maintenance. */
export function hardSetCount(sets: ExerciseSet[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sets) {
    // No RPE logged → count it. Andrii isn't logging easy warm-up sets by hand,
    // and demanding RPE for every set would kill the logging habit.
    const hard = s.rpe === null || s.rpe >= 7;
    if (!hard) continue;
    counts.set(s.exerciseKey, (counts.get(s.exerciseKey) ?? 0) + 1);
  }
  return counts;
}

const fmtDate = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export function serializeStrength(prs: ExercisePR[], hardSets: Map<string, number>, days: number): string {
  if (prs.length === 0) return '';
  const lines = [`=== СИЛОВІ ЗА ${days} ДН (пораховано кодом — цитуй ЦІ числа) ===`];
  for (const pr of prs.slice(0, 12)) {
    const sets = hardSets.get(pr.exerciseKey) ?? 0;
    const last =
      pr.lastWeightKg !== null && pr.lastReps !== null
        ? `останнє ${pr.lastWeightKg}кг×${pr.lastReps} (${fmtDate(pr.lastAt!)})`
        : 'останнє —';
    lines.push(
      `- ${pr.exerciseRaw}: ${last} · рекорд ${pr.bestWeightKg}кг×${pr.bestReps} ≈1ПМ ${pr.bestE1RM}кг (${fmtDate(pr.achievedAt)}) · ${sets} робочих підходів`,
    );
  }
  lines.push('=== КІНЕЦЬ СИЛОВИХ ===');
  return lines.join('\n');
}
