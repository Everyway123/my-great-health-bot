import { describe, it, expect } from 'vitest';
import { dataSummary, serializeHealthRows, HealthRow } from '../src/store.js';

const TZ = 'Europe/Lisbon';

const row = (kind: HealthRow['kind'], content: string, data: Record<string, unknown> = {}): HealthRow => ({
  id: 1,
  user_id: 42,
  kind,
  content,
  data,
  logged_at: new Date('2026-08-01T12:30:00Z'),
});

describe('dataSummary', () => {
  it('formats meal calories + macros', () => {
    const s = dataSummary({ calories: 520, protein_g: 24, fat_g: 34, carbs_g: 28 });
    expect(s).toContain('≈520 ккал');
    expect(s).toContain('Б24/Ж34/В28');
  });
  it('formats weight, sleep and duration', () => {
    expect(dataSummary({ weight_kg: 91.2 })).toContain('91.2 кг');
    expect(dataSummary({ sleep_h: 6.5 })).toContain('сон 6.5 год');
    expect(dataSummary({ duration_min: 45 })).toContain('45 хв');
  });
  it('empty for unknown data', () => {
    expect(dataSummary({})).toBe('');
  });
});

describe('serializeHealthRows', () => {
  it('explicit «[немає записів]» marker when empty (anti-hallucination contract)', () => {
    expect(serializeHealthRows([], TZ)).toBe('[немає записів]');
  });
  it('one line per row with Ukrainian kind label', () => {
    const out = serializeHealthRows([row('meal', 'Омлет', { calories: 520 }), row('weight', 'Вага', { weight_kg: 91.2 })], TZ);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(їжа)');
    expect(lines[1]).toContain('(вага)');
  });
  it('survives a null data field', () => {
    const r = { ...row('note', 'Ціль 88 кг'), data: null as unknown as Record<string, unknown> };
    expect(serializeHealthRows([r], TZ)).toContain('Ціль 88 кг');
  });
});
