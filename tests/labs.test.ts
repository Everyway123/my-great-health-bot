import { describe, it, expect } from 'vitest';
import { markerKey, toMarkerRows, serializeMarkerSeries, staleFlagged, latestReadings, MarkerSeries } from '../src/labs.js';
import { chunkRange, minutesFromLocalMidnight } from '../src/adapters/oura.js';
import { normalizeToolInput } from '../src/reason/schema.js';

describe('markerKey', () => {
  it('collapses the spellings of one marker into a single series', () => {
    const keys = ['Вітамін D', 'Vitamin D (25-OH)', '25(OH)D', 'vitamin d3'].map(markerKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps distinct markers distinct', () => {
    expect(markerKey('ApoB')).not.toBe(markerKey('Lp(a)'));
    expect(markerKey('ЛПНЩ')).toBe('ldl');
  });

  it('prefers the more specific alias', () => {
    // «СРБ високочутливий» is hs-CRP, a different marker from plain CRP.
    expect(markerKey('СРБ високочутливий')).toBe('hs_crp');
    expect(markerKey('СРБ')).toBe('crp');
  });

  it('still forms a stable key for an unknown marker', () => {
    expect(markerKey('Церулоплазмін')).toBe(markerKey('церулоплазмін'));
    expect(markerKey('')).toBe('');
  });
});

describe('toMarkerRows', () => {
  const at = new Date('2026-08-01T09:00:00Z');

  it('parses numeric values out of strings', () => {
    const rows = toMarkerRows([{ name: 'Вітамін D', value: '41,2', unit: 'ng/ml', flag: 'ok' }], at);
    expect(rows[0].valueNum).toBeCloseTo(41.2);
    expect(rows[0].valueText).toBeNull();
  });

  it('keeps qualitative results as text', () => {
    const rows = toMarkerRows([{ name: 'Кетони', value: 'негативно' }], at);
    expect(rows[0].valueNum).toBeNull();
    expect(rows[0].valueText).toBe('негативно');
  });

  it('drops nameless entries and duplicate markers from one draw', () => {
    const rows = toMarkerRows(
      [{ name: '', value: 1 }, { name: 'ApoB', value: 90 }, { name: 'apob', value: 91 }],
      at,
    );
    expect(rows).toHaveLength(1);
  });

  it('ignores a non-array payload', () => {
    expect(toMarkerRows('нема', at)).toEqual([]);
  });

  it('only accepts known flags', () => {
    expect(toMarkerRows([{ name: 'ApoB', value: 90, flag: 'катастрофа' }], at)[0].flag).toBe('');
  });
});

describe('marker series presentation', () => {
  const series: MarkerSeries[] = [
    {
      key: 'vitamin_d',
      name: 'Вітамін D',
      points: [
        { drawnAt: new Date('2025-05-10T00:00:00Z'), value: 28, unit: 'ng/ml', flag: 'low' },
        { drawnAt: new Date('2026-08-04T00:00:00Z'), value: 41, unit: 'ng/ml', flag: 'ok' },
      ],
    },
  ];

  it('renders the trajectory with dates', () => {
    const out = serializeMarkerSeries(series);
    expect(out).toContain('28 ng/ml↓ (10.05.25)');
    expect(out).toContain('41 ng/ml (04.08.26)');
  });

  it('says so when there is only one draw', () => {
    const single = [{ ...series[0], points: series[0].points.slice(0, 1) }];
    expect(serializeMarkerSeries(single)).toContain('тренду ще нема');
  });

  it('returns nothing for no markers', () => {
    expect(serializeMarkerSeries([])).toBe('');
  });

  it('reports the latest reading for the safety check', () => {
    expect(latestReadings(series)[0].value).toBe(41);
  });

  it('only chases markers whose latest value is out of range', () => {
    expect(staleFlagged(series, new Date('2026-08-10T00:00:00Z'))).toHaveLength(0);
    const stillLow = [{ ...series[0], points: [series[0].points[0]] }];
    expect(staleFlagged(stillLow, new Date('2026-08-10T00:00:00Z'))[0].daysAgo).toBeGreaterThan(400);
  });
});

describe('oura helpers', () => {
  it('splits a multi-year range into bounded chunks', () => {
    const chunks = chunkRange('2022-05-01', '2026-08-10', 90);
    expect(chunks.length).toBeGreaterThan(15);
    expect(chunks[0].start).toBe('2022-05-01');
    expect(chunks[chunks.length - 1].end).toBe('2026-08-10');
    // No gaps and no overlaps: every chunk starts the day after the last ended.
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = new Date(`${chunks[i - 1].end}T00:00:00Z`);
      prevEnd.setUTCDate(prevEnd.getUTCDate() + 1);
      expect(chunks[i].start).toBe(prevEnd.toISOString().slice(0, 10));
    }
  });

  it('returns nothing for an inverted range', () => {
    expect(chunkRange('2026-01-10', '2026-01-01')).toEqual([]);
  });

  it('reads bedtime as minutes from local midnight, negative before it', () => {
    expect(minutesFromLocalMidnight('2026-01-02T23:30:00+01:00', '2026-01-03')).toBe(-30);
    expect(minutesFromLocalMidnight('2026-01-03T07:15:00+01:00', '2026-01-03')).toBe(435);
  });

  it('refuses to guess when the offset is absent', () => {
    expect(minutesFromLocalMidnight('2026-01-03T07:15:00', '2026-01-03')).toBeNull();
  });
});

describe('normalizeToolInput', () => {
  it('accepts a well-formed tool call', () => {
    const p = normalizeToolInput({ kind: 'meal', title: 'Вечеря', reply: 'Ок', data: { calories: 600 } });
    expect(p?.kind).toBe('meal');
    expect(p?.data.calories).toBe(600);
  });

  it('rejects a call with no reply — an empty coach message is worse than none', () => {
    expect(normalizeToolInput({ kind: 'meal', title: 'x', reply: '  ' })).toBeNull();
  });

  it('treats empty update objects as absent', () => {
    const p = normalizeToolInput({ kind: 'other', title: '', reply: 'Ок', profile_updates: {}, targets: {} });
    expect(p?.profileUpdates).toBeNull();
    expect(p?.targets).toBeNull();
  });

  it('survives garbage', () => {
    expect(normalizeToolInput('nope')).toBeNull();
    expect(normalizeToolInput(null)).toBeNull();
  });
});
