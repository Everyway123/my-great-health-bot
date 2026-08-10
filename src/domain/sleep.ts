// Sleep regularity — the highest-value / lowest-cost thing we can compute.
//
// Regularity of sleep timing predicts mortality more strongly than sleep
// DURATION does (Windred et al., SLEEP 2024), and almost no consumer tool
// reports it. We have bedtime_start / bedtime_end per session from the ring, so
// the real Sleep Regularity Index is computable, not just a proxy.
//
// SRI (Phillips et al., Sci Rep 2017): the percentage of time points at which a
// person is in the same state (asleep / awake) 24 hours apart, rescaled to
// [-100, 100]. 100 = perfectly identical days; 0 = no better than chance.
//
// Everything here is pure and tested. Caveat worth knowing: the minute grid is
// absolute, so the two DST switches each year inject a one-hour artefact into
// the window that contains them. Not worth modelling for a personal coach.

const MIN = 60_000;
const DAY_MIN = 1440;

export interface SleepSession {
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
}

/** Minute-resolution asleep mask over `days` days starting at `windowStartMs`. */
export function buildSleepMask(sessions: SleepSession[], windowStartMs: number, days: number): Uint8Array {
  const total = days * DAY_MIN;
  const mask = new Uint8Array(total);
  for (const s of sessions) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) continue;
    const from = Math.max(0, Math.floor((s.start - windowStartMs) / MIN));
    const to = Math.min(total, Math.ceil((s.end - windowStartMs) / MIN));
    for (let i = from; i < to; i++) mask[i] = 1;
  }
  return mask;
}

export interface RegularityResult {
  /** -100..100; null when the window has fewer than 2 usable days */
  sri: number | null;
  daysWithSleep: number;
  /** circular mean bedtime, minutes from local midnight (may exceed 1440 when
   *  the habitual bedtime is after midnight — kept for display) */
  meanBedtimeMin: number | null;
  meanWaketimeMin: number | null;
  /** circular standard deviation in minutes — the "how much do I drift" number */
  bedtimeSdMin: number | null;
  waketimeSdMin: number | null;
  avgDurationH: number | null;
}

const TWO_PI = Math.PI * 2;

/** Circular mean of minute-of-day values → minutes in [0, 1440). */
export function circularMeanMinutes(values: number[]): number | null {
  if (values.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const v of values) {
    const a = (TWO_PI * (((v % DAY_MIN) + DAY_MIN) % DAY_MIN)) / DAY_MIN;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  const angle = Math.atan2(y / values.length, x / values.length);
  const m = ((angle / TWO_PI) * DAY_MIN + DAY_MIN) % DAY_MIN;
  return Math.round(m);
}

/** Circular standard deviation in minutes. 0 = identical every day. */
export function circularSdMinutes(values: number[]): number | null {
  if (values.length < 2) return null;
  let x = 0;
  let y = 0;
  for (const v of values) {
    const a = (TWO_PI * (((v % DAY_MIN) + DAY_MIN) % DAY_MIN)) / DAY_MIN;
    x += Math.cos(a);
    y += Math.sin(a);
  }
  const r = Math.sqrt(x * x + y * y) / values.length;
  if (r <= 0) return null;
  if (r >= 1) return 0;
  const sdRad = Math.sqrt(-2 * Math.log(r));
  return Math.round((sdRad / TWO_PI) * DAY_MIN);
}

const minuteOfDay = (ms: number, tzOffsetMin: number): number => {
  const local = ms + tzOffsetMin * MIN;
  return Math.floor(local / MIN) % DAY_MIN;
};

/**
 * @param windowStartMs epoch ms of local midnight starting the window
 * @param tzOffsetMin   minutes east of UTC, used only for minute-of-day stats
 */
export function computeRegularity(
  sessions: SleepSession[],
  windowStartMs: number,
  days: number,
  tzOffsetMin: number,
): RegularityResult {
  const usable = sessions.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  const empty: RegularityResult = {
    sri: null,
    daysWithSleep: 0,
    meanBedtimeMin: null,
    meanWaketimeMin: null,
    bedtimeSdMin: null,
    waketimeSdMin: null,
    avgDurationH: null,
  };
  if (usable.length === 0 || days < 2) return empty;

  const mask = buildSleepMask(usable, windowStartMs, days);

  // Only compare pairs of days where at least one of the two has a recording:
  // two blank nights agreeing that the user was "awake" is not regularity, it
  // is missing data, and counting it would inflate SRI toward 100.
  const dayHasData = new Array<boolean>(days).fill(false);
  for (let d = 0; d < days; d++) {
    for (let i = d * DAY_MIN; i < (d + 1) * DAY_MIN; i++) {
      if (mask[i]) {
        dayHasData[d] = true;
        break;
      }
    }
  }

  let agree = 0;
  let total = 0;
  for (let d = 0; d + 1 < days; d++) {
    if (!dayHasData[d] || !dayHasData[d + 1]) continue;
    const base = d * DAY_MIN;
    for (let i = 0; i < DAY_MIN; i++) {
      total++;
      if (mask[base + i] === mask[base + DAY_MIN + i]) agree++;
    }
  }

  const bedMinutes = usable.map((s) => minuteOfDay(s.start, tzOffsetMin));
  const wakeMinutes = usable.map((s) => minuteOfDay(s.end, tzOffsetMin));
  const durations = usable.map((s) => (s.end - s.start) / 3_600_000);

  return {
    sri: total > 0 ? Math.round((200 * agree) / total - 100) : null,
    daysWithSleep: dayHasData.filter(Boolean).length,
    meanBedtimeMin: circularMeanMinutes(bedMinutes),
    meanWaketimeMin: circularMeanMinutes(wakeMinutes),
    bedtimeSdMin: circularSdMinutes(bedMinutes),
    waketimeSdMin: circularSdMinutes(wakeMinutes),
    avgDurationH: Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10,
  };
}

/** Hours of sleep owed against a nightly target, counting only shortfalls. */
export function sleepDebtH(durationsH: number[], targetH: number): number {
  const debt = durationsH.reduce((acc, h) => acc + Math.max(0, targetH - h), 0);
  return Math.round(debt * 10) / 10;
}

export const formatClock = (min: number | null): string => {
  if (min === null) return '—';
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Plain-language verdict. Thresholds are deliberately coarse: the point is a
 *  direction to act on, not false precision. */
export function regularityVerdict(sri: number | null): string {
  if (sri === null) return 'даних замало';
  if (sri >= 85) return 'дуже стабільний ритм';
  if (sri >= 75) return 'стабільний ритм';
  if (sri >= 60) return 'помірний дрейф';
  return "ритм плаває — це б'є по відновленню сильніше, ніж окрема коротка ніч";
}

export function serializeRegularity(r: RegularityResult, targetH: number | null): string {
  if (r.sri === null && r.daysWithSleep === 0) return '';
  const lines = ['=== РЕГУЛЯРНІСТЬ СНУ (пораховано кодом) ==='];
  lines.push(
    `- Sleep Regularity Index: ${r.sri ?? '—'}/100 (${regularityVerdict(r.sri)}) — наскільки однакові доби між собою`,
  );
  lines.push(
    `- Відбій: у середньому ${formatClock(r.meanBedtimeMin)}, розкид ±${r.bedtimeSdMin ?? '—'} хв`,
  );
  lines.push(`- Підйом: у середньому ${formatClock(r.meanWaketimeMin)}, розкид ±${r.waketimeSdMin ?? '—'} хв`);
  if (r.avgDurationH !== null) {
    lines.push(
      `- Тривалість: ${r.avgDurationH} год у середньому за ${r.daysWithSleep} ноч${r.daysWithSleep === 1 ? 'і' : 'ей'}${targetH ? ` (ціль ${targetH})` : ''}`,
    );
  }
  lines.push('=== КІНЕЦЬ РЕГУЛЯРНОСТІ ===');
  return lines.join('\n');
}
