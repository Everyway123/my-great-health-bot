// The canonical event store. Every health fact — from Telegram, from Oura, from
// a lab PDF — lands here as an immutable row and is never mutated afterwards.
// Everything derived (daily metrics, stats, trends, adherence) is computed from
// these rows and can be thrown away and rebuilt.
//
// Still hermes.health_log, still the shared Railway pg: everything Andrii logged
// before the split stays exactly where it was.

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

export type EventSource = 'telegram' | 'oura' | 'import';

export interface HealthRow {
  id: number;
  user_id: number;
  kind: HealthKind;
  content: string;
  data: Record<string, unknown>;
  logged_at: Date;
  source: EventSource;
}

export interface LogHealthOptions {
  source?: EventSource;
  /** Stable upstream identifier. A second insert with the same key is a no-op —
   *  this is what makes re-syncing Oura safe. */
  dedupKey?: string;
  loggedAt?: Date;
}

/** Persist one health fact. Null when pg is absent/failed OR when the row was a
 *  duplicate (dedupKey already present) — callers must not treat null as
 *  "analyzed but unsaved" without checking `source`. */
export async function logHealth(
  userId: number,
  kind: HealthKind,
  content: string,
  data: Record<string, unknown> = {},
  opts: LogHealthOptions = {},
): Promise<number | null> {
  if (!content || content.trim().length === 0) return null;
  const p = getPool();
  if (!p) return null;
  try {
    const res = await p.query<{ id: number }>(
      `insert into hermes.health_log (user_id, kind, content, data, source, dedup_key, logged_at)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))
       on conflict do nothing
       returning id`,
      [
        userId,
        kind,
        content.slice(0, 2000),
        data,
        opts.source ?? 'telegram',
        opts.dedupKey ?? null,
        opts.loggedAt ?? null,
      ],
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
      `select id, user_id, kind, content, data, logged_at, source
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
  if (typeof d.hrv_ms === 'number') parts.push(`HRV ${d.hrv_ms} мс`);
  if (Array.isArray(d.sets)) parts.push(`${(d.sets as unknown[]).length} підх.`);
  return parts.length ? ' · ' + parts.join(' · ') : '';
}

/** Prompt-friendly serialization — one line per fact, explicit «[немає записів]»
 *  marker when empty so the LLM can't fake gaps. Oura-sourced rows are tagged so
 *  the coach can tell measured data from self-reported. */
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
    const src = r.source === 'oura' ? ' ⌚' : '';
    return `[${stamp}] (${label}${src}) ${r.content.slice(0, 300)}${dataSummary(r.data ?? {})}`;
  });
  return lines.join('\n');
}
