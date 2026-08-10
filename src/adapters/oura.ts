// Oura adapter — the bot's eyes.
//
// Personal access tokens were retired in December 2025, so this is OAuth2
// authorization-code with refresh. That normally implies a public callback
// server; we don't have one and don't want one. Instead the code is carried by
// hand exactly once: the bot prints the authorize URL, Andrii approves in the
// browser, copies the `code` out of the redirect URL, and sends it back through
// Telegram. From then on the refresh token lives in pg and rotates itself.
//
// Pull, not webhooks: Oura recommends webhooks and they are the right end state,
// but they need an inbound HTTPS endpoint. A scheduled pull needs nothing, and
// at ~8 requests per sync against a 5000-per-5-minutes budget it is nowhere near
// any limit.

import { getPool } from '../store.js';
import { log } from '../logger.js';
import { logHealth } from '../store.js';
import { METRIC, upsertDailyMetrics } from '../domain/metrics.js';

const API = 'https://api.ouraring.com';
const AUTHORIZE = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN = 'https://api.ouraring.com/oauth/token';

/** Everything the coach can actually use. `email` is deliberately not requested. */
export const OURA_SCOPES = ['personal', 'daily', 'heartrate', 'workout', 'session', 'tag', 'spo2Daily'];

export interface OuraConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function ouraConfig(): OuraConfig | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  const redirectUri = process.env.OURA_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function authorizeUrl(cfg: OuraConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: OURA_SCOPES.join(' '),
    state,
  });
  return `${AUTHORIZE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`oura token ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as TokenResponse;
  if (!json.access_token || !json.refresh_token) throw new Error('oura token response missing fields');
  return json;
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
  lastSyncDay: string | null;
}

async function saveToken(userId: number, t: TokenResponse): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('no database — refusing to hold an Oura token only in memory');
  await p.query(
    `insert into hermes.oura_token (user_id, access_token, refresh_token, expires_at, scope, updated_at)
     values ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, now())
     on conflict (user_id) do update
       set access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = now()`,
    [userId, t.access_token, t.refresh_token, String(Math.max(60, t.expires_in || 86400)), t.scope ?? ''],
  );
}

export async function getStoredToken(userId: number): Promise<StoredToken | null> {
  const p = getPool();
  if (!p) return null;
  const res = await p.query<{
    access_token: string;
    refresh_token: string;
    expires_at: Date;
    scope: string;
    last_sync_day: Date | null;
  }>('select access_token, refresh_token, expires_at, scope, last_sync_day from hermes.oura_token where user_id = $1', [
    userId,
  ]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at,
    scope: r.scope,
    lastSyncDay: r.last_sync_day ? r.last_sync_day.toISOString().slice(0, 10) : null,
  };
}

export async function setLastSyncDay(userId: number, day: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p
    .query('update hermes.oura_token set last_sync_day = $2 where user_id = $1', [userId, day])
    .catch(() => {});
}

/** One-time: turn the copied `code` into a stored token pair. */
export async function linkAccount(cfg: OuraConfig, userId: number, code: string): Promise<void> {
  const t = await postToken({
    grant_type: 'authorization_code',
    code: code.trim(),
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });
  await saveToken(userId, t);
  log({ level: 'info', action: 'oura_linked', userId });
}

export async function unlinkAccount(userId: number): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query('delete from hermes.oura_token where user_id = $1', [userId]);
}

/** Refreshes 5 minutes before expiry. Oura rotates the refresh token on every
 *  exchange, so the new pair must be persisted or the link dies silently. */
export async function validAccessToken(cfg: OuraConfig, userId: number): Promise<string | null> {
  const stored = await getStoredToken(userId);
  if (!stored) return null;
  if (stored.expiresAt.getTime() - Date.now() > 5 * 60_000) return stored.accessToken;
  try {
    const t = await postToken({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    await saveToken(userId, t);
    log({ level: 'info', action: 'oura_token_refreshed', userId });
    return t.access_token;
  } catch (err) {
    log({ level: 'error', action: 'oura_refresh_failed', userId, details: { error: String(err).slice(0, 200) } });
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET one collection, following `next_token` to the end. Honours Retry-After
 *  on 429 rather than guessing a backoff. */
async function getCollection(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let nextToken: string | undefined;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams(params);
    if (nextToken) qs.set('next_token', nextToken);
    const res = await fetch(`${API}${path}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '5');
      await sleep(Math.min(60, Math.max(1, wait)) * 1000);
      continue;
    }
    if (res.status === 403) {
      // Scope not granted or subscription lapsed — a permanent per-endpoint
      // condition, not a reason to abort the whole sync.
      log({ level: 'warn', action: 'oura_forbidden', details: { path } });
      return out;
    }
    if (!res.ok) throw new Error(`oura ${path} ${res.status}: ${(await res.text()).slice(0, 160)}`);

    const json = (await res.json()) as { data?: Array<Record<string, unknown>>; next_token?: string | null };
    if (Array.isArray(json.data)) out.push(...json.data);
    if (!json.next_token) break;
    nextToken = json.next_token;
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const secToH = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round((n / 3600) * 100) / 100;
};
const secToMin = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n / 60);
};

/** Minutes from local midnight of the session's `day`, derived from the ISO
 *  offset Oura sends. Negative means the user went to bed before midnight. */
export function minutesFromLocalMidnight(iso: string, day: string): number | null {
  if (!iso || !day) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : iso.endsWith('Z') ? 0 : null;
  if (offsetMin === null) return null;
  const localMidnight = Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000;
  return Math.round((ts - localMidnight) / 60_000);
}

export interface SyncResult {
  days: number;
  events: number;
  metrics: number;
  errors: string[];
}

/** Fetch [startDay, endDay] and write events + daily metrics. Idempotent: every
 *  event carries a dedup key derived from Oura's own document id, and metrics
 *  upsert by (day, metric, source). Re-running a range is free of side effects,
 *  which is what makes both the nightly cron and the 4-year backfill safe. */
export async function syncRange(
  cfg: OuraConfig,
  userId: number,
  startDay: string,
  endDay: string,
): Promise<SyncResult> {
  const token = await validAccessToken(cfg, userId);
  if (!token) return { days: 0, events: 0, metrics: 0, errors: ['no valid Oura token'] };

  const range = { start_date: startDay, end_date: endDay };
  const errors: string[] = [];
  const metricRows: Array<{ day: string; metric: string; value: number | null }> = [];
  let events = 0;

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${label}: ${String(err).slice(0, 120)}`);
      return fallback;
    }
  };

  // --- sleep sessions: the richest single source we get -------------------
  const sleeps = await safe('sleep', () => getCollection(token, '/v2/usercollection/sleep', range), []);
  // Multiple periods per night are normal (naps, split sleep). Total per day is
  // the sum; timing and averages come from the longest period of that day.
  const byDaySleep = new Map<string, Array<Record<string, unknown>>>();
  for (const s of sleeps) {
    const day = str(s.day);
    if (!day) continue;
    if (str(s.type) === 'deleted') continue;
    byDaySleep.set(day, [...(byDaySleep.get(day) ?? []), s]);

    const id = str(s.id);
    const hours = secToH(s.total_sleep_duration);
    const stored = await logHealth(
      userId,
      'sleep',
      `Сон ${hours ?? '?'} год (Oura)`,
      {
        sleep_h: hours,
        bedtime_start: str(s.bedtime_start),
        bedtime_end: str(s.bedtime_end),
        hrv_ms: num(s.average_hrv),
        rhr_bpm: num(s.lowest_heart_rate),
        avg_hr: num(s.average_heart_rate),
        efficiency: num(s.efficiency),
        deep_h: secToH(s.deep_sleep_duration),
        rem_h: secToH(s.rem_sleep_duration),
        light_h: secToH(s.light_sleep_duration),
        awake_h: secToH(s.awake_time),
        breath_rate: num(s.average_breath),
        latency_min: secToMin(s.latency),
      },
      { source: 'oura', dedupKey: `oura:sleep:${id}`, loggedAt: new Date(Date.parse(str(s.bedtime_end)) || Date.now()) },
    );
    if (stored !== null) events++;
  }

  for (const [day, list] of byDaySleep) {
    const totalH = list.reduce((acc, s) => acc + (secToH(s.total_sleep_duration) ?? 0), 0);
    const longest = list.reduce((a, b) =>
      (num(b.total_sleep_duration) ?? 0) > (num(a.total_sleep_duration) ?? 0) ? b : a,
    );
    metricRows.push(
      { day, metric: METRIC.SLEEP_H, value: Math.round(totalH * 100) / 100 },
      { day, metric: METRIC.HRV_MS, value: num(longest.average_hrv) },
      { day, metric: METRIC.RHR_BPM, value: num(longest.lowest_heart_rate) },
      { day, metric: METRIC.SLEEP_EFFICIENCY, value: num(longest.efficiency) },
      { day, metric: METRIC.DEEP_H, value: secToH(longest.deep_sleep_duration) },
      { day, metric: METRIC.REM_H, value: secToH(longest.rem_sleep_duration) },
      { day, metric: METRIC.BREATH_RATE, value: num(longest.average_breath) },
      { day, metric: METRIC.SLEEP_START_MIN, value: minutesFromLocalMidnight(str(longest.bedtime_start), day) },
      { day, metric: METRIC.SLEEP_END_MIN, value: minutesFromLocalMidnight(str(longest.bedtime_end), day) },
    );
  }

  // --- daily scores -------------------------------------------------------
  for (const d of await safe('daily_sleep', () => getCollection(token, '/v2/usercollection/daily_sleep', range), [])) {
    const day = str(d.day);
    if (day) metricRows.push({ day, metric: METRIC.SLEEP_SCORE, value: num(d.score) });
  }
  for (const d of await safe('daily_readiness', () => getCollection(token, '/v2/usercollection/daily_readiness', range), [])) {
    const day = str(d.day);
    if (!day) continue;
    metricRows.push(
      { day, metric: METRIC.READINESS, value: num(d.score) },
      { day, metric: METRIC.TEMP_DEV_C, value: num(d.temperature_deviation) },
    );
  }
  for (const d of await safe('daily_activity', () => getCollection(token, '/v2/usercollection/daily_activity', range), [])) {
    const day = str(d.day);
    if (!day) continue;
    metricRows.push(
      { day, metric: METRIC.STEPS, value: num(d.steps) },
      { day, metric: METRIC.ACTIVE_KCAL, value: num(d.active_calories) },
      { day, metric: METRIC.TOTAL_KCAL, value: num(d.total_calories) },
      // MET-based, not heart-rate zones — a proxy for zone 2, labelled as such
      // everywhere it is shown.
      { day, metric: METRIC.ZONE2_MIN, value: secToMin(d.medium_activity_time) },
      { day, metric: METRIC.HIGH_ACTIVITY_MIN, value: secToMin(d.high_activity_time) },
    );
  }
  for (const d of await safe('daily_stress', () => getCollection(token, '/v2/usercollection/daily_stress', range), [])) {
    const day = str(d.day);
    if (!day) continue;
    metricRows.push(
      { day, metric: METRIC.STRESS_HIGH_MIN, value: secToMin(d.stress_high) },
      { day, metric: METRIC.RECOVERY_HIGH_MIN, value: secToMin(d.recovery_high) },
    );
  }
  for (const d of await safe('daily_spo2', () => getCollection(token, '/v2/usercollection/daily_spo2', range), [])) {
    const day = str(d.day);
    const pct = d.spo2_percentage as { average?: unknown } | undefined;
    if (day && pct) metricRows.push({ day, metric: METRIC.SPO2_PCT, value: num(pct.average) });
  }
  for (const d of await safe('vO2_max', () => getCollection(token, '/v2/usercollection/vO2_max', range), [])) {
    const day = str(d.day);
    if (day) metricRows.push({ day, metric: METRIC.VO2MAX, value: num(d.vo2_max) });
  }

  // --- workouts -----------------------------------------------------------
  for (const w of await safe('workout', () => getCollection(token, '/v2/usercollection/workout', range), [])) {
    const id = str(w.id);
    const start = Date.parse(str(w.start_datetime));
    const end = Date.parse(str(w.end_datetime));
    const durationMin = Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 60_000) : null;
    const activity = str(w.activity) || 'тренування';
    const stored = await logHealth(
      userId,
      'workout',
      `${activity} ${durationMin ?? '?'} хв (Oura)`,
      {
        type: activity,
        duration_min: durationMin,
        intensity: str(w.intensity),
        calories: num(w.calories),
        distance_m: num(w.distance),
        source_oura: str(w.source),
      },
      { source: 'oura', dedupKey: `oura:workout:${id}`, loggedAt: new Date(Number.isFinite(start) ? start : Date.now()) },
    );
    if (stored !== null) events++;
  }

  const metrics = await upsertDailyMetrics(userId, 'oura', metricRows);
  const days = new Set(metricRows.map((r) => r.day)).size;
  log({ level: 'info', action: 'oura_sync', userId, details: { startDay, endDay, days, events, metrics, errors: errors.length } });
  return { days, events, metrics, errors };
}

/** Split a long range into chunks Oura is comfortable with. Four years in one
 *  request is a bad idea; 90 days at a time is not. */
export function chunkRange(startDay: string, endDay: string, sizeDays = 90): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const end = new Date(`${endDay}T00:00:00Z`);
  let cursor = new Date(`${startDay}T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end) return out;
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + sizeDays - 1);
    const capped = chunkEnd > end ? end : chunkEnd;
    out.push({ start: cursor.toISOString().slice(0, 10), end: capped.toISOString().slice(0, 10) });
    cursor = new Date(capped);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Full history walk. Andrii has worn a ring since May 2022 — this is not
 *  "start collecting data", it is four years of sleep and HRV already sitting
 *  in Oura's cloud waiting to be read once. */
export async function backfill(
  cfg: OuraConfig,
  userId: number,
  startDay: string,
  endDay: string,
  onProgress?: (chunk: { start: string; end: string }, result: SyncResult) => void,
): Promise<SyncResult> {
  const total: SyncResult = { days: 0, events: 0, metrics: 0, errors: [] };
  for (const chunk of chunkRange(startDay, endDay)) {
    const r = await syncRange(cfg, userId, chunk.start, chunk.end);
    total.days += r.days;
    total.events += r.events;
    total.metrics += r.metrics;
    total.errors.push(...r.errors);
    onProgress?.(chunk, r);
    await sleep(300);
  }
  return total;
}
