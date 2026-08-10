// Small timezone-day helpers — everything here is pure. «Сьогодні» must be from
// LOCAL midnight, not a rolling 24h window — otherwise yesterday's 21:30 dinner
// lands in today's 20:45 digest.

/** Whole-hour offset of `tz` from UTC on the given `YYYY-MM-DD` (noon-anchored
 *  so DST edges resolve to the day's prevailing offset). */
export function offsetHours(tz: string, date: string): number {
  const d = new Date(`${date}T12:00:00Z`);
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 3_600_000);
}

/** Today's calendar date in `tz` as `YYYY-MM-DD` (en-CA gives ISO order). */
export function todayInTz(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

/** Local calendar date of an arbitrary instant. */
export function localDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

/** UTC instant of local midnight that starts `date` in `tz`, as ISO string. */
export function startOfDayUtcISO(tz: string, date: string): string {
  const off = offsetHours(tz, date);
  const ms = new Date(`${date}T00:00:00Z`).getTime() - off * 3_600_000;
  return new Date(ms).toISOString();
}

/** `YYYY-MM-DD` shifted by whole days. */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** The last `n` local dates ending today, oldest first. */
export function lastNDays(tz: string, n: number, now = new Date()): string[] {
  const today = todayInTz(tz, now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDay(today, -i));
  return out;
}
