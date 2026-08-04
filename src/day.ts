// Small timezone-day helpers — everything here is pure. (Ported from Hermes
// core/day.ts.) «Сьогодні» must be from LOCAL midnight, not a rolling 24h
// window — otherwise yesterday's 21:30 dinner lands in today's 20:45 digest.

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

/** UTC instant of local midnight that starts `date` in `tz`, as ISO string. */
export function startOfDayUtcISO(tz: string, date: string): string {
  const off = offsetHours(tz, date);
  const ms = new Date(`${date}T00:00:00Z`).getTime() - off * 3_600_000;
  return new Date(ms).toISOString();
}
