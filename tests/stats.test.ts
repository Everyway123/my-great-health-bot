import { describe, it, expect } from 'vitest';
import { computeStats, serializeStats } from '../src/stats.js';
import { HealthRow } from '../src/store.js';

const TZ = 'Europe/Lisbon';

let id = 0;
const row = (kind: HealthRow['kind'], iso: string, data: Record<string, unknown> = {}): HealthRow => ({
  id: ++id,
  user_id: 42,
  kind,
  content: 'x',
  data,
  logged_at: new Date(iso),
});

describe('computeStats', () => {
  it('counts meal days and averages calories per LOGGED day only', () => {
    const s = computeStats(
      [
        row('meal', '2026-08-01T09:00:00Z', { calories: 500 }),
        row('meal', '2026-08-01T13:00:00Z', { calories: 700 }), // same day → 1200
        row('meal', '2026-08-02T09:00:00Z', { calories: 800 }),
      ],
      TZ,
      7,
    );
    expect(s.mealDays).toBe(2);
    expect(s.avgCalPerMealDay).toBe(1000); // (1200 + 800) / 2, NOT / 7
  });

  it('sums workouts, averages sleep, tracks weight first→last', () => {
    const s = computeStats(
      [
        row('workout', '2026-08-01T18:00:00Z', { duration_min: 45 }),
        row('workout', '2026-08-03T18:00:00Z', { duration_min: 60 }),
        row('sleep', '2026-08-02T07:00:00Z', { sleep_h: 6 }),
        row('sleep', '2026-08-03T07:00:00Z', { sleep_h: 8 }),
        row('weight', '2026-08-01T08:00:00Z', { weight_kg: 91.5 }),
        row('weight', '2026-08-04T08:00:00Z', { weight_kg: 90.8 }),
      ],
      TZ,
      7,
    );
    expect(s.workoutCount).toBe(2);
    expect(s.workoutMin).toBe(105);
    expect(s.avgSleepH).toBe(7);
    expect(s.weightFirst).toBe(91.5);
    expect(s.weightLast).toBe(90.8);
  });

  it('empty window → nulls and zeros, serialization stays honest', () => {
    const s = computeStats([], TZ, 7);
    expect(s.mealDays).toBe(0);
    expect(s.avgCalPerMealDay).toBeNull();
    expect(s.avgSleepH).toBeNull();
    const out = serializeStats(s);
    expect(out).toContain('Їжа: не логував');
    expect(out).toContain('Тренування: нуль');
    expect(out).toContain('Сон: не логував');
    expect(out).toContain('Вага: не логував');
  });
});
