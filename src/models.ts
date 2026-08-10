// SINGLE SOURCE for model ids and how hard each call should think.
//
// Three tiers instead of one, because the workloads are genuinely different:
// logging a fact is a cheap extraction that happens many times a day, while the
// weekly review is a slow, expensive read over months of context.
//
// Rotating a model = one edit here.
export const MODELS = {
  /** High-frequency, low-stakes: text facts, evening digest, morning check-in. */
  FAST: 'claude-sonnet-5',
  /** Vision: food photos, lab forms, tracker screenshots. Misreading a lab
   *  value is expensive, so this stays on the strongest model. */
  PRIMARY: 'claude-opus-5',
  /** Weekly and monthly analysis over the full context. */
  DEEP: 'claude-opus-5',
} as const;

/** `effort` controls thinking depth and total token spend. Adaptive thinking is
 *  left ON everywhere: with it disabled, Opus 5 can emit a tool call as plain
 *  text — the call silently never runs — which is precisely the failure mode we
 *  cannot afford now that every fact is logged through forced tool use. */
export const EFFORT = {
  FAST: 'low',
  PRIMARY: 'medium',
  DEEP: 'high',
} as const;
