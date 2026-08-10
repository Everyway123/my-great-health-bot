import { describe, it, expect } from 'vitest';
import { nudgeDecision } from '../src/coach.js';

describe('nudgeDecision', () => {
  it('summarizes a day that has entries', () => {
    expect(nudgeDecision(3, 10)).toBe('digest');
  });

  it('nudges someone who has the habit but skipped today', () => {
    expect(nudgeDecision(0, 5)).toBe('nudge');
  });

  it('stays silent rather than nagging a user who has never engaged', () => {
    expect(nudgeDecision(0, 0)).toBe('silent');
  });
});
