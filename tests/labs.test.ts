import { describe, it, expect } from 'vitest';
import { labsTrend, serializeLabsTrend, markerKey } from '../src/labs.js';
import { HealthRow } from '../src/store.js';

let id = 0;
const labsRow = (iso: string, markers: unknown[]): HealthRow => ({
  id: ++id,
  user_id: 42,
  kind: 'labs',
  content: 'Аналізи',
  data: { markers },
  logged_at: new Date(iso),
});

describe('markerKey', () => {
  it('collapses spelling variants of the same marker', () => {
    expect(markerKey('Vitamin D (25-OH)')).toBe(markerKey('vitamin d 25 oh'));
    expect(markerKey('Вітамін D')).toBe(markerKey('вітамін   d'));
  });
});

describe('labsTrend', () => {
  it('builds a per-marker series across draws, oldest-first', () => {
    const series = labsTrend([
      labsRow('2026-05-10T09:00:00Z', [{ name: 'Vitamin D', value: 28, unit: 'ng/ml', flag: 'low' }]),
      labsRow('2026-08-04T09:00:00Z', [{ name: 'Vitamin D', value: 41, unit: 'ng/ml', flag: 'ok' }]),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.value)).toEqual([28, 41]);
    expect(series[0].points[0].date).toBe('10.05.26');
  });

  it('keeps distinct markers separate and skips broken entries', () => {
    const series = labsTrend([
      labsRow('2026-08-04T09:00:00Z', [
        { name: 'ApoB', value: 1.1, unit: 'g/l', flag: 'high' },
        { name: 'HbA1c', value: 5.4, unit: '%', flag: 'ok' },
        { name: '', value: 9 },          // no name → skipped
        { name: 'Ferritin' },            // no value → skipped
      ]),
    ]);
    expect(series.map((s) => s.name).sort()).toEqual(['ApoB', 'HbA1c']);
  });

  it('ignores non-labs rows and labs rows without markers', () => {
    const meal: HealthRow = { id: ++id, user_id: 42, kind: 'meal', content: 'x', data: { calories: 1 }, logged_at: new Date() };
    expect(labsTrend([meal, labsRow('2026-08-04T09:00:00Z', undefined as unknown as unknown[])])).toEqual([]);
  });
});

describe('serializeLabsTrend', () => {
  it('empty series → empty string (block simply absent from the prompt)', () => {
    expect(serializeLabsTrend([])).toBe('');
  });

  it('shows trajectory with flags and marks single-point markers honestly', () => {
    const out = serializeLabsTrend(
      labsTrend([
        labsRow('2026-05-10T09:00:00Z', [{ name: 'Vitamin D', value: 28, unit: 'ng/ml', flag: 'low' }]),
        labsRow('2026-08-04T09:00:00Z', [
          { name: 'Vitamin D', value: 41, unit: 'ng/ml', flag: 'ok' },
          { name: 'ApoB', value: 1.1, unit: 'g/l', flag: 'high' },
        ]),
      ]),
    );
    expect(out).toContain('Vitamin D: 28 ng/ml↓ (10.05.26) → 41 ng/ml (04.08.26)');
    expect(out).toContain('ApoB: 1.1 g/l↑ (04.08.26) [один забір — тренду ще нема]');
  });
});
