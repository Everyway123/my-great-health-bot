import { describe, it, expect } from 'vitest';
import {
  buildSleepMask,
  circularMeanMinutes,
  circularSdMinutes,
  computeRegularity,
  sleepDebtH,
  formatClock,
  regularityVerdict,
} from '../src/domain/sleep.js';

const DAY = 86_400_000;
const H = 3_600_000;
const start = Date.parse('2026-01-01T00:00:00Z');

/** Identical 23:00 → 07:00 nights covering days 0..n-1 in full.
 *  Starts one night BEFORE the window so day 0 has its morning sleep too —
 *  otherwise the first day is a half-night by construction and even a perfectly
 *  regular sleeper scores below 100. */
const perfectNights = (n: number) =>
  Array.from({ length: n + 1 }, (_, k) => {
    const i = k - 1;
    return { start: start + i * DAY + 23 * H, end: start + (i + 1) * DAY + 7 * H };
  });

describe('buildSleepMask', () => {
  it('marks exactly the asleep minutes', () => {
    const mask = buildSleepMask([{ start: start + 1 * H, end: start + 3 * H }], start, 1);
    expect(mask.length).toBe(1440);
    expect(mask[59]).toBe(0);
    expect(mask[60]).toBe(1);
    expect(mask[179]).toBe(1);
    expect(mask[180]).toBe(0);
  });

  it('ignores inverted and non-finite intervals', () => {
    const mask = buildSleepMask([{ start: start + 3 * H, end: start + 1 * H }, { start: NaN, end: 1 }], start, 1);
    expect(mask.every((v) => v === 0)).toBe(true);
  });
});

describe('computeRegularity', () => {
  it('scores identical days at 100', () => {
    const r = computeRegularity(perfectNights(7), start, 7, 0);
    expect(r.sri).toBe(100);
    expect(r.bedtimeSdMin).toBe(0);
    expect(r.avgDurationH).toBe(8);
  });

  it('drops when bedtime swings by hours', () => {
    const chaotic = Array.from({ length: 7 }, (_, i) => {
      const shift = i % 2 === 0 ? 0 : 5 * H; // alternate 23:00 and 04:00
      return { start: start + i * DAY + 23 * H + shift, end: start + i * DAY + 23 * H + shift + 8 * H };
    });
    const r = computeRegularity(chaotic, start, 7, 0);
    expect(r.sri).not.toBeNull();
    expect(r.sri!).toBeLessThan(60);
    expect(r.bedtimeSdMin!).toBeGreaterThan(60);
  });

  it('does not count blank nights as agreement', () => {
    // Two real nights at the start, then five nights with no ring data at all.
    // Naively comparing every day pair would call the empty stretch "regular".
    const sparse = perfectNights(2);
    const r = computeRegularity(sparse, start, 7, 0);
    expect(r.daysWithSleep).toBeLessThanOrEqual(3);
    expect(r.sri).not.toBe(100);
  });

  it('returns nulls for an empty window', () => {
    const r = computeRegularity([], start, 7, 0);
    expect(r.sri).toBeNull();
    expect(r.avgDurationH).toBeNull();
  });
});

describe('circular statistics', () => {
  it('averages across midnight correctly', () => {
    // 23:40 and 00:20 → midnight, not 12:00.
    expect(circularMeanMinutes([23 * 60 + 40, 20])).toBe(0);
  });

  it('reports zero spread for identical times', () => {
    expect(circularSdMinutes([1380, 1380, 1380])).toBe(0);
  });

  it('needs at least two points for a spread', () => {
    expect(circularSdMinutes([600])).toBeNull();
  });
});

describe('sleepDebtH', () => {
  it('counts shortfalls only, never credit for a long night', () => {
    expect(sleepDebtH([6, 6, 10], 7.5)).toBe(3);
  });
});

describe('presentation', () => {
  it('formats minutes as a clock', () => {
    expect(formatClock(1380)).toBe('23:00');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(null)).toBe('—');
  });

  it('describes regularity honestly when there is no data', () => {
    expect(regularityVerdict(null)).toContain('замало');
  });
});
