import { describe, it, expect } from 'vitest';
import { computeAdherence, Actuals } from '../src/domain/adherence.js';
import { validateTargets } from '../src/targets.js';
import { evaluateTriggers, TriggerInput, peakSeverity } from '../src/domain/triggers.js';
import { checkCritical } from '../src/domain/safety.js';

const byDay = (rows: Record<string, Record<string, number>>): Map<string, Map<string, number>> =>
  new Map(Object.entries(rows).map(([day, metrics]) => [day, new Map(Object.entries(metrics))]));

const actuals = (over: Partial<Actuals> = {}): Actuals => ({
  byDay: new Map(),
  strengthSessions: 0,
  zone2Min: 0,
  vo2maxSessions: 0,
  alcoholUnits: 0,
  daysInWindow: 7,
  ...over,
});

describe('validateTargets', () => {
  it('coerces strings with units', () => {
    const r = validateTargets({ protein_g_per_day: '150 г' });
    expect(r.accepted[0].value).toBe(150);
  });

  it('rejects unknown keys instead of storing something nothing can score', () => {
    const r = validateTargets({ vibes_per_day: 5 });
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toContain('невідомий');
  });

  it('rejects physiologically absurd values', () => {
    const r = validateTargets({ protein_g_per_day: 4000, sleep_h_per_night: 7.5 });
    expect(r.accepted.map((t) => t.key)).toEqual(['sleep_h_per_night']);
    expect(r.rejected[0].reason).toContain('діапазон');
  });
});

describe('computeAdherence', () => {
  const targets = validateTargets({
    protein_g_per_day: 150,
    strength_sessions_per_week: 3,
    alcohol_units_per_week: 4,
  }).accepted;

  it('scores a met per-day target at 100%', () => {
    const r = computeAdherence(
      targets,
      actuals({ byDay: byDay({ '2026-01-01': { protein_g: 160 }, '2026-01-02': { protein_g: 150 } }), strengthSessions: 3 }),
    );
    const protein = r.scores.find((s) => s.key === 'protein_g_per_day')!;
    expect(protein.met).toBe(true);
    expect(protein.ratio).toBe(1);
  });

  it('caps overachievement so one big number cannot mask a missed target', () => {
    const r = computeAdherence(targets, actuals({ byDay: byDay({ '2026-01-01': { protein_g: 600 } }), strengthSessions: 0 }));
    expect(r.scores.find((s) => s.key === 'protein_g_per_day')!.ratio).toBe(1);
    expect(r.overall!).toBeLessThan(100);
  });

  it('scores under-the-cap targets in the opposite direction', () => {
    const met = computeAdherence(targets, actuals({ alcoholUnits: 2 }));
    const blown = computeAdherence(targets, actuals({ alcoholUnits: 8 }));
    expect(met.scores.find((s) => s.key === 'alcohol_units_per_week')!.met).toBe(true);
    expect(blown.scores.find((s) => s.key === 'alcohol_units_per_week')!.ratio).toBe(0);
  });

  it('pro-rates weekly targets to a shorter window', () => {
    const r = computeAdherence(targets, actuals({ daysInWindow: 7, strengthSessions: 3 }));
    expect(r.scores.find((s) => s.key === 'strength_sessions_per_week')!.target).toBe(3);
    const half = computeAdherence(targets, actuals({ daysInWindow: 3.5 as number, strengthSessions: 2 }));
    expect(half.scores.find((s) => s.key === 'strength_sessions_per_week')!.target).toBe(1.5);
  });

  it('reports missing data as missing rather than as a zero', () => {
    const r = computeAdherence(targets, actuals());
    const protein = r.scores.find((s) => s.key === 'protein_g_per_day')!;
    expect(protein.actual).toBeNull();
    expect(protein.ratio).toBeNull();
    expect(r.unmeasured).toContain('Білок');
  });
});

describe('evaluateTriggers', () => {
  const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];

  const base = (over: Partial<TriggerInput> = {}): TriggerInput => ({
    byDay: new Map(),
    loggedDays: new Set(days),
    days,
    sleepTargetH: 7.5,
    sri: 90,
    staleFlaggedMarkers: [],
    ...over,
  });

  it('fires on an HRV collapse against personal baseline', () => {
    const rows: Record<string, Record<string, number>> = {};
    days.slice(0, 7).forEach((d) => (rows[d] = { hrv_ms: 60 }));
    rows[days[7]] = { hrv_ms: 40 };
    const t = evaluateTriggers(base({ byDay: byDay(rows) }));
    const hrv = t.find((x) => x.code === 'hrv_drop');
    expect(hrv?.severity).toBe('alert');
    expect(hrv?.facts.dropPct).toBe(33);
  });

  it('stays quiet on normal HRV noise', () => {
    const rows: Record<string, Record<string, number>> = {};
    days.slice(0, 7).forEach((d) => (rows[d] = { hrv_ms: 60 }));
    rows[days[7]] = { hrv_ms: 55 };
    expect(evaluateTriggers(base({ byDay: byDay(rows) })).some((x) => x.code === 'hrv_drop')).toBe(false);
  });

  it('catches the second missed day, not the first', () => {
    const oneMissed = base({ loggedDays: new Set(days.slice(0, 7)) });
    expect(evaluateTriggers(oneMissed).some((t) => t.code === 'missed_twice')).toBe(false);
    const twoMissed = base({ loggedDays: new Set(days.slice(0, 6)) });
    expect(evaluateTriggers(twoMissed).some((t) => t.code === 'missed_twice')).toBe(true);
  });

  it('never nags someone who has never logged anything', () => {
    expect(evaluateTriggers(base({ loggedDays: new Set() })).some((t) => t.code === 'missed_twice')).toBe(false);
  });

  it('flags an irregular rhythm', () => {
    expect(evaluateTriggers(base({ sri: 45 })).some((t) => t.code === 'irregular_sleep')).toBe(true);
  });

  it('surfaces an abnormal marker that was never rechecked', () => {
    const t = evaluateTriggers(base({ staleFlaggedMarkers: [{ name: 'Вітамін D', daysAgo: 200 }] }));
    expect(t.some((x) => x.code === 'lab_followup')).toBe(true);
  });

  it('ranks severity so only real signals justify a push', () => {
    expect(peakSeverity([])).toBeNull();
    expect(peakSeverity(evaluateTriggers(base({ sri: 45 })))).toBe('nudge');
  });
});

describe('checkCritical', () => {
  it('catches a panic-level potassium', () => {
    const hits = checkCritical([{ markerKey: 'potassium', nameRaw: 'Калій', value: 6.9, unit: 'mmol/L' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].direction).toBe('high');
  });

  it('stays silent inside the range', () => {
    expect(checkCritical([{ markerKey: 'potassium', nameRaw: 'Калій', value: 4.2, unit: 'mmol/L' }])).toHaveLength(0);
  });

  it('does not compare across unit systems', () => {
    // 90 mg/dL glucose is normal; if the mmol/L rule matched it, it would read
    // as a wild hyperglycaemia and cry wolf.
    expect(checkCritical([{ markerKey: 'glucose', nameRaw: 'Глюкоза', value: 90, unit: 'mg/dL' }])).toHaveLength(0);
  });

  it('ignores non-numeric results', () => {
    expect(checkCritical([{ markerKey: 'potassium', nameRaw: 'Калій', value: null, unit: 'mmol/L' }])).toHaveLength(0);
  });
});
