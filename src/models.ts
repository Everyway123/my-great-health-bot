// SINGLE SOURCE for Anthropic model IDs (same rule as Hermes: hardcoded model
// strings scattered across files drift and 404 silently). Rotating a model =
// one edit here, probed against the real API first.
export const MODELS = {
  PRIMARY: 'claude-sonnet-4-6',
} as const;
