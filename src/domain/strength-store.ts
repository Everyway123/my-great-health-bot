// Persistence for exercise sets. Kept separate from strength.ts so all the
// progression maths stays pure and unit-testable without a database.

import { getPool } from '../store.js';
import { log } from '../logger.js';
import { ExerciseSet } from './strength.js';

export async function saveExerciseSets(userId: number, sets: ExerciseSet[], eventId: number | null): Promise<number> {
  const p = getPool();
  if (!p || sets.length === 0) return 0;
  try {
    const res = await p.query(
      `insert into hermes.health_exercise_set
         (user_id, performed_at, exercise_key, exercise_raw, weight_kg, reps, rpe, event_id)
       select $1, $2, k, r, w, rp, rpe, $3
         from unnest($4::text[], $5::text[], $6::double precision[], $7::integer[], $8::double precision[])
              as t(k, r, w, rp, rpe)`,
      [
        userId,
        sets[0].performedAt,
        eventId,
        sets.map((s) => s.exerciseKey),
        sets.map((s) => s.exerciseRaw),
        sets.map((s) => s.weightKg),
        sets.map((s) => s.reps),
        sets.map((s) => s.rpe),
      ],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    log({ level: 'error', action: 'exercise_set_save_error', details: { error: String(err).slice(0, 200) } });
    return 0;
  }
}

export async function fetchExerciseSets(userId: number, sinceISO: string): Promise<ExerciseSet[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query<{
      exercise_key: string;
      exercise_raw: string;
      weight_kg: string | null;
      reps: number | null;
      rpe: string | null;
      performed_at: Date;
    }>(
      `select exercise_key, exercise_raw, weight_kg, reps, rpe, performed_at
         from hermes.health_exercise_set
        where user_id = $1 and performed_at >= $2
        order by performed_at asc`,
      [userId, sinceISO],
    );
    return res.rows.map((r) => ({
      exerciseKey: r.exercise_key,
      exerciseRaw: r.exercise_raw,
      weightKg: r.weight_kg !== null ? Number(r.weight_kg) : null,
      reps: r.reps,
      rpe: r.rpe !== null ? Number(r.rpe) : null,
      performedAt: r.performed_at,
    }));
  } catch (err) {
    log({ level: 'error', action: 'exercise_set_fetch_error', details: { error: String(err).slice(0, 200) } });
    return [];
  }
}

/** Sets from the most recent session of one exercise — the input to the
 *  double-progression decision. */
export async function lastSessionSets(userId: number, key: string): Promise<ExerciseSet[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query<{ performed_at: Date }>(
      `select max(performed_at) as performed_at
         from hermes.health_exercise_set where user_id = $1 and exercise_key = $2`,
      [userId, key],
    );
    const at = res.rows[0]?.performed_at;
    if (!at) return [];
    const sets = await fetchExerciseSets(userId, new Date(at.getTime() - 6 * 3600_000).toISOString());
    return sets.filter((s) => s.exerciseKey === key);
  } catch {
    return [];
  }
}
