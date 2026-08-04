import { describe, it, expect } from 'vitest';
import { parseCoachJson, nudgeDecision } from '../src/coach.js';

describe('parseCoachJson', () => {
  it('parses a clean JSON object', () => {
    const p = parseCoachJson(
      '{"kind":"meal","title":"Омлет з авокадо","data":{"calories":520},"reply":"<b>Норм сніданок</b>"}',
    );
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('meal');
    expect(p!.data.calories).toBe(520);
  });

  it('strips ```json fences and surrounding prose (salvage)', () => {
    const raw = 'Ось аналіз:\n```json\n{"kind":"weight","title":"Вага 91.2","data":{"weight_kg":91.2},"reply":"ок"}\n```\nготово';
    const p = parseCoachJson(raw);
    expect(p).not.toBeNull();
    expect(p!.data.weight_kg).toBe(91.2);
  });

  it('accepts kind "other" (question/non-fact, nothing to store)', () => {
    const p = parseCoachJson('{"kind":"other","title":"","data":{},"reply":"За тиждень ≈14200 ккал"}');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('other');
  });

  it('passes profile_updates through, null when absent or empty', () => {
    const withUpdates = parseCoachJson(
      '{"kind":"other","title":"","data":{},"profile_updates":{"height_cm":183,"injuries":null},"reply":"ок"}',
    );
    expect(withUpdates!.profileUpdates).toEqual({ height_cm: 183, injuries: null });
    const without = parseCoachJson('{"kind":"meal","title":"x","data":{},"reply":"ок"}');
    expect(without!.profileUpdates).toBeNull();
    const empty = parseCoachJson('{"kind":"meal","title":"x","data":{},"profile_updates":{},"reply":"ок"}');
    expect(empty!.profileUpdates).toBeNull();
  });

  it('rejects invalid kind, missing reply, broken JSON, empty input', () => {
    expect(parseCoachJson('{"kind":"selfie","title":"x","data":{},"reply":"y"}')).toBeNull();
    expect(parseCoachJson('{"kind":"meal","title":"x","data":{}}')).toBeNull();
    expect(parseCoachJson('{"kind":"meal", broken')).toBeNull();
    expect(parseCoachJson('')).toBeNull();
  });
});

describe('nudgeDecision', () => {
  it('digest when today has entries', () => {
    expect(nudgeDecision(3, 0)).toBe('digest');
  });
  it('nudge when today is empty but the habit exists', () => {
    expect(nudgeDecision(0, 4)).toBe('nudge');
  });
  it('silent when the feature is unused', () => {
    expect(nudgeDecision(0, 0)).toBe('silent');
  });
});
