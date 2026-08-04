// Health log store — the durable spine. Writes to THE SAME table Hermes used
// (hermes.health_log in the shared Railway pg): everything Andrii logged before
// the split stays, and Hermes-side tooling can still read the journal if ever
// needed. Self-healing table (no migration system).

import pg from 'pg';
import { log } from './logger.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (pool) return pool;
  const conn = process.env.DATABASE_URL;
  if (!conn) return null;
  pool = new pg.Pool({
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err: Error) => {
    log({ level: 'error', action: 'pg_pool_error', details: { error: String(err) } });
  });
  return pool;
}

export type HealthKind = 'meal' | 'workout' | 'sleep' | 'weight' | 'labs' | 'wellbeing' | 'note';

export const HEALTH_KINDS: HealthKind[] = ['meal', 'workout', 'sleep', 'weight', 'labs', 'wellbeing', 'note'];

export interface HealthRow {
  id: number;
  user_id: number;
  kind: HealthKind;
  content: string;
  data: Record<string, unknown>;
  logged_at: Date;
}

let ensured = false;

export async function ensureHealthTable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (ensured) return true;
  try {
    await p.query('create schema if not exists hermes');
    await p.query(`
      create table if not exists hermes.health_log (
        id         serial primary key,
        user_id    bigint      not null,
        kind       text        not null,
        content    text        not null,
        data       jsonb       not null default '{}',
        logged_at  timestamptz not null default now()
      )`);
    ensured = true;
    return true;
  } catch (err) {
    log({ level: 'error', action: 'health_table_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

/** Persist one health fact. Null when pg is absent/failed — callers degrade to
 *  "analyzed but not stored" and must say so to the user. */
export async function logHealth(
  userId: number,
  kind: HealthKind,
  content: string,
  data: Record<string, unknown> = {},
): Promise<number | null> {
  if (!content || content.trim().length === 0) return null;
  if (!(await ensureHealthTable())) return null;
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query<{ id: number }>(
      `insert into hermes.health_log (user_id, kind, content, data)
       values ($1, $2, $3, $4) returning id`,
      [userId, kind, content.slice(0, 2000), data],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    log({ level: 'error', action: 'health_log_error', details: { kind, error: String(err).slice(0, 200) } });
    return null;
  }
}

/** Rows at/after `sinceISO`, oldest-first, optionally narrowed to `kinds`
 *  (labs need a year-long window while food needs days — one query shape for
 *  both). Never throws — [] on failure. */
export async function fetchHealthSince(userId: number, sinceISO: string, kinds?: HealthKind[]): Promise<HealthRow[]> {
  if (!(await ensureHealthTable())) return [];
  const p = getPool();
  if (!p) return [];
  try {
    const params: unknown[] = [userId, sinceISO];
    let kindFilter = '';
    if (kinds && kinds.length > 0) {
      params.push(kinds);
      kindFilter = 'and kind = any($3)';
    }
    const res = await p.query<HealthRow>(
      `select id, user_id, kind, content, data, logged_at
         from hermes.health_log
        where user_id = $1 and logged_at >= $2 ${kindFilter}
        order by logged_at asc`,
      params,
    );
    return res.rows;
  } catch (err) {
    log({ level: 'error', action: 'health_fetch_error', details: { error: String(err).slice(0, 200) } });
    return [];
  }
}

const KIND_LABELS: Record<HealthKind, string> = {
  meal: 'їжа',
  workout: 'тренування',
  sleep: 'сон',
  weight: 'вага',
  labs: 'аналізи',
  wellbeing: 'самопочуття',
  note: 'нотатка',
};

/** Compact summary of the well-known numeric fields in `data`. */
export function dataSummary(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof d.calories === 'number') parts.push(`≈${d.calories} ккал`);
  const hasMacro = ['protein_g', 'fat_g', 'carbs_g'].some((k) => typeof d[k] === 'number');
  if (hasMacro) {
    const n = (k: string) => (typeof d[k] === 'number' ? d[k] : '?');
    parts.push(`Б${n('protein_g')}/Ж${n('fat_g')}/В${n('carbs_g')}`);
  }
  if (typeof d.weight_kg === 'number') parts.push(`${d.weight_kg} кг`);
  if (typeof d.sleep_h === 'number') parts.push(`сон ${d.sleep_h} год`);
  if (typeof d.duration_min === 'number') parts.push(`${d.duration_min} хв`);
  return parts.length ? ' · ' + parts.join(' · ') : '';
}

/** Prompt-friendly serialization — one line per fact, explicit «[немає записів]»
 *  marker when empty so the LLM can't fake gaps. */
export function serializeHealthRows(rows: HealthRow[], timezone: string): string {
  if (rows.length === 0) return '[немає записів]';
  const lines = rows.map((r) => {
    const stamp = r.logged_at.toLocaleString('uk-UA', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const label = KIND_LABELS[r.kind] ?? r.kind;
    return `[${stamp}] (${label}) ${r.content.slice(0, 300)}${dataSummary(r.data ?? {})}`;
  });
  return lines.join('\n');
}
