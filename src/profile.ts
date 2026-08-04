// Durable coach memory — ONE jsonb profile per user: height, target weight,
// injuries, preferences, accepted weekly plan, anything long-lived the coach
// must never re-ask. The model maintains it itself: any turn can emit
// `profile_updates` in the JSON contract («запам'ятай: зріст 183» → merged
// here). Self-healing table, same pattern as the rest.

import { getPool } from './store.js';
import { log } from './logger.js';

let ensured = false;

async function ensureTable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (ensured) return true;
  try {
    await p.query(`
      create table if not exists hermes.health_profile (
        user_id    bigint primary key,
        data       jsonb not null default '{}',
        updated_at timestamptz not null default now()
      )`);
    ensured = true;
    return true;
  } catch (err) {
    log({ level: 'error', action: 'profile_table_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

export async function getProfile(userId: number): Promise<Record<string, unknown>> {
  if (!(await ensureTable())) return {};
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
  if (!(await ensureTable())) return false;
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
