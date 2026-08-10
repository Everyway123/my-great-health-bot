import { describe, it, expect } from 'vitest';
import { exerciseKey, estimate1RM, computePRs, nextProgression, hardSetCount, ExerciseSet } from '../src/domain/strength.js';

const set = (exercise: string, weightKg: number | null, reps: number | null, day: string, rpe: number | null = null): ExerciseSet => ({
  exerciseKey: exerciseKey(exercise),
  exerciseRaw: exercise,
  weightKg,
  reps,
  rpe,
  performedAt: new Date(`${day}T18:00:00Z`),
});

describe('exerciseKey', () => {
  it('collapses spelling and case variants into one series', () => {
    expect(exerciseKey('Жим лежачи')).toBe(exerciseKey('жим  лежачи'));
    expect(exerciseKey('Bench Press')).toBe('bench_press');
  });
});

describe('estimate1RM', () => {
  it('returns the weight itself for a single', () => {
    expect(estimate1RM(100, 1)).toBe(100);
  });

  it('scales with reps (Epley)', () => {
    expect(estimate1RM(100, 10)).toBeCloseTo(133.3, 1);
  });

  it('is zero for nonsense input', () => {
    expect(estimate1RM(0, 5)).toBe(0);
    expect(estimate1RM(100, 0)).toBe(0);
  });
});

describe('computePRs', () => {
  it('finds the best estimated 1RM, not the heaviest bar', () => {
    const prs = computePRs([
      set('присід', 100, 5, '2026-01-01'), // e1RM 116.7
      set('присід', 110, 1, '2026-01-08'), // e1RM 110
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0].bestWeightKg).toBe(100);
    expect(prs[0].bestReps).toBe(5);
  });

  it('reports the most recent session separately from the record', () => {
    const prs = computePRs([set('присід', 120, 5, '2026-01-01'), set('присід', 80, 5, '2026-02-01')]);
    expect(prs[0].bestWeightKg).toBe(120);
    expect(prs[0].lastWeightKg).toBe(80);
  });

  it('skips sets with no load or reps', () => {
    expect(computePRs([set('присід', null, null, '2026-01-01')])).toHaveLength(0);
  });
});

describe('nextProgression (double progression)', () => {
  const range = { min: 8, max: 12 };

  it('adds weight once every set hits the top of the range', () => {
    const advice = nextProgression([set('жим', 60, 12, '2026-01-01'), set('жим', 60, 12, '2026-01-01')], range);
    expect(advice?.action).toBe('add_weight');
    expect(advice?.nextWeightKg).toBe(62.5);
    expect(advice?.nextReps).toBe(8);
  });

  it('holds the weight while chasing reps', () => {
    const advice = nextProgression([set('жим', 60, 10, '2026-01-01'), set('жим', 60, 9, '2026-01-01')], range);
    expect(advice?.action).toBe('add_reps');
    expect(advice?.nextWeightKg).toBe(60);
  });

  it('deloads when clearly under the floor', () => {
    const advice = nextProgression([set('жим', 80, 5, '2026-01-01')], range);
    expect(advice?.action).toBe('deload');
    expect(advice?.nextWeightKg).toBe(72);
  });

  it('judges the session by its worst working set, not its best', () => {
    const advice = nextProgression([set('жим', 60, 12, '2026-01-01'), set('жим', 60, 8, '2026-01-01')], range);
    expect(advice?.action).toBe('add_reps');
  });

  it('returns null with nothing to go on', () => {
    expect(nextProgression([], range)).toBeNull();
  });
});

describe('hardSetCount', () => {
  it('counts unlogged-RPE sets as working sets', () => {
    const counts = hardSetCount([set('тяга', 100, 5, '2026-01-01'), set('тяга', 100, 5, '2026-01-01', 9)]);
    expect(counts.get(exerciseKey('тяга'))).toBe(2);
  });

  it('excludes explicitly easy sets', () => {
    const counts = hardSetCount([set('тяга', 40, 10, '2026-01-01', 4)]);
    expect(counts.get(exerciseKey('тяга'))).toBeUndefined();
  });
});
