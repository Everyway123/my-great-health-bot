// Durable coach memory — ONE jsonb profile per user: height, injuries,
// preferences, anything long-lived and unstructured the coach must never
// re-ask. The model maintains it itself via `profile_updates`.
//
// NOTE: numeric goals no longer live here. Anything code has to divide by
// (protein/day, sleep target, sessions/week) is a typed row in health_target —
// see targets.ts. The profile is for prose facts, not arithmetic inputs.

import { getPool } from './store.js';
import { log } from './logger.js';

export async function getProfile(userId: number): Promise<Record<string, unknown>> {
  const p = getPool();
  if (!p) return {};
  try {
    const res = await p.query<{ data: Record<string, unknown> }>(
      'select data from hermes.health_profile where user_id = $1',
      [userId],
    );
    return res.rows[0]?.data ?? {};
  } catch (err) {
    log({ level: 'error', action: 'profile_get_error', details: { error: String(err).slice(0, 200) } });
    return {};
  }
}

export async function saveProfile(userId: number, data: Record<string, unknown>): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query(
      `insert into hermes.health_profile (user_id, data, updated_at)
       values ($1, $2, now())
       on conflict (user_id) do update set data = $2, updated_at = now()`,
      [userId, data],
    );
    return true;
  } catch (err) {
    log({ level: 'error', action: 'profile_save_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

/** Pure merge of model-emitted updates into the existing profile:
 *  top-level assign; explicit null DELETES a key (how the model forgets). */
export function mergeProfile(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Prompt block. Explicit empty-marker so the coach ASKS instead of assuming. */
export function serializeProfile(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return '[профіль порожній — коуч ще нічого не знає; питай і запамʼятовуй через profile_updates]';
  const lines = keys.sort().map((k) => `- ${k}: ${JSON.stringify(data[k])}`);
  return lines.join('\n');
}
