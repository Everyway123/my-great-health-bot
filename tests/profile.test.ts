import { describe, it, expect } from 'vitest';
import { mergeProfile, serializeProfile } from '../src/profile.js';

describe('mergeProfile', () => {
  it('assigns new keys and overwrites existing ones', () => {
    const out = mergeProfile({ height_cm: 180 }, { height_cm: 183, target_weight_kg: 88 });
    expect(out).toEqual({ height_cm: 183, target_weight_kg: 88 });
  });

  it('null DELETES a key (how the model forgets)', () => {
    const out = mergeProfile({ injuries: 'коліно', height_cm: 183 }, { injuries: null });
    expect(out).toEqual({ height_cm: 183 });
  });

  it('does not mutate the existing object', () => {
    const existing = { a: 1 };
    mergeProfile(existing, { b: 2 });
    expect(existing).toEqual({ a: 1 });
  });
});

describe('serializeProfile', () => {
  it('explicit empty marker so the coach asks instead of assuming', () => {
    expect(serializeProfile({})).toContain('профіль порожній');
  });
  it('one line per key', () => {
    const out = serializeProfile({ height_cm: 183, goals: ['сила'] });
    expect(out).toContain('height_cm: 183');
    expect(out).toContain('goals: ["сила"]');
  });
});
