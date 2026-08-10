// Typed targets. Everything the coach measures adherence against lives here as
// a validated number — never as prose in the profile jsonb, because code has to
// divide by these and `target_weight_kg: "88 кг"` would silently poison every
// percentage downstream.

import { getPool } from './store.js';
import { log } from './logger.js';

export type Cadence = 'day' | 'week';

export interface TargetSpec {
  key: string;
  label: string;
  unit: string;
  cadence: Cadence;
  min: number;
  max: number;
  /** true when exceeding the target is the good direction (protein, steps);
   *  false when staying under it is (alcohol) */
  higherIsBetter: boolean;
}

/** The closed set of things we know how to score. An unknown key is rejected
 *  rather than stored — a target nothing can measure is worse than none. */
export const TARGET_SPECS: TargetSpec[] = [
  { key: 'protein_g_per_day', label: 'Білок', unit: 'г/день', cadence: 'day', min: 30, max: 400, higherIsBetter: true },
  { key: 'kcal_per_day', label: 'Калорії', unit: 'ккал/день', cadence: 'day', min: 800, max: 6000, higherIsBetter: false },
  { key: 'steps_per_day', label: 'Кроки', unit: '/день', cadence: 'day', min: 1000, max: 40000, higherIsBetter: true },
  { key: 'sleep_h_per_night', label: 'Сон', unit: 'год/ніч', cadence: 'day', min: 4, max: 12, higherIsBetter: true },
  { key: 'strength_sessions_per_week', label: 'Силові', unit: '/тиждень', cadence: 'week', min: 0, max: 14, higherIsBetter: true },
  { key: 'zone2_min_per_week', label: 'Зона 2', unit: 'хв/тиждень', cadence: 'week', min: 0, max: 1200, higherIsBetter: true },
  { key: 'vo2max_sessions_per_week', label: 'VO2max-інтервали', unit: '/тиждень', cadence: 'week', min: 0, max: 7, higherIsBetter: true },
  { key: 'alcohol_units_per_week', label: 'Алкоголь', unit: 'од./тиждень', cadence: 'week', min: 0, max: 60, higherIsBetter: false },
  { key: 'weight_kg', label: 'Цільова вага', unit: 'кг', cadence: 'day', min: 35, max: 250, higherIsBetter: false },
];

const SPEC_BY_KEY = new Map(TARGET_SPECS.map((s) => [s.key, s]));

export const targetSpec = (key: string): TargetSpec | undefined => SPEC_BY_KEY.get(key);

export interface Target {
  key: string;
  value: number;
  unit: string;
  cadence: Cadence;
}

export interface ValidationResult {
  accepted: Target[];
  rejected: Array<{ key: string; reason: string }>;
}

/** Pure. Coerces "88", 88, "88 кг" → 88; rejects unknown keys and out-of-range
 *  values so a model hallucination can't set protein to 4000 g/day. */
export function validateTargets(raw: Record<string, unknown>): ValidationResult {
  const accepted: Target[] = [];
  const rejected: Array<{ key: string; reason: string }> = [];

  for (const [key, rawValue] of Object.entries(raw)) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) {
      rejected.push({ key, reason: 'невідомий показник' });
      continue;
    }
    let value: number;
    if (typeof rawValue === 'number') {
      value = rawValue;
    } else if (typeof rawValue === 'string') {
      const m = rawValue.replace(',', '.').match(/-?\d+(\.\d+)?/);
      if (!m) {
        rejected.push({ key, reason: 'не число' });
        continue;
      }
      value = Number(m[0]);
    } else {
      rejected.push({ key, reason: 'не число' });
      continue;
    }
    if (!Number.isFinite(value)) {
      rejected.push({ key, reason: 'не число' });
      continue;
    }
    if (value < spec.min || value > spec.max) {
      rejected.push({ key, reason: `поза діапазоном ${spec.min}–${spec.max}` });
      continue;
    }
    accepted.push({ key, value, unit: spec.unit, cadence: spec.cadence });
  }
  return { accepted, rejected };
}

export async function saveTargets(userId: number, targets: Target[]): Promise<boolean> {
  const p = getPool();
  if (!p || targets.length === 0) return false;
  try {
    await p.query(
      `insert into hermes.health_target (user_id, key, value, unit, cadence, updated_at)
       select $1, k, v, u, c, now()
         from unnest($2::text[], $3::double precision[], $4::text[], $5::text[]) as t(k, v, u, c)
       on conflict (user_id, key)
       do update set value = excluded.value, unit = excluded.unit,
                     cadence = excluded.cadence, updated_at = now()`,
      [
        userId,
        targets.map((t) => t.key),
        targets.map((t) => t.value),
        targets.map((t) => t.unit),
        targets.map((t) => t.cadence),
      ],
    );
    return true;
  } catch (err) {
    log({ level: 'error', action: 'targets_save_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

export async function getTargets(userId: number): Promise<Target[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query<{ key: string; value: string; unit: string; cadence: string }>(
      'select key, value, unit, cadence from hermes.health_target where user_id = $1 order by key',
      [userId],
    );
    return res.rows.map((r) => ({
      key: r.key,
      value: Number(r.value),
      unit: r.unit,
      cadence: r.cadence === 'week' ? 'week' : 'day',
    }));
  } catch (err) {
    log({ level: 'error', action: 'targets_get_error', details: { error: String(err).slice(0, 200) } });
    return [];
  }
}

export async function deleteTarget(userId: number, key: string): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query('delete from hermes.health_target where user_id = $1 and key = $2', [userId, key]);
    return true;
  } catch {
    return false;
  }
}

export function serializeTargets(targets: Target[]): string {
  if (targets.length === 0) {
    return '[цілей ще не задано — коли Андрій погодить план, збережи їх через targets у відповіді]';
  }
  return targets
    .map((t) => {
      const spec = SPEC_BY_KEY.get(t.key);
      return `- ${spec?.label ?? t.key}: ${t.value} ${t.unit}`;
    })
    .join('\n');
}
