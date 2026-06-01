import type { ProviderName } from './llm-types';

/**
 * Provider ↔ model integrity check (single source of truth for both the write
 * chokepoint — LlmSettingsService.saveRouting — and the run chokepoint —
 * LlmResolver.resolve).
 *
 * The root cause of "OpenAI route + claude-sonnet-4-6 model" silently failing
 * was that provider and model were stored as independent free-text with no
 * constraint between them. This enforces the constraint by NAMESPACE rather
 * than an exhaustive model catalog: a routed model id must start with one of
 * its provider's recognized prefixes.
 *
 * Why namespaces, not an allowlist of exact ids: it catches the real mistake
 * (a cross-provider id) while staying forward-compatible — new models in an
 * existing family (gpt-5, claude-5-haiku) still validate without a code change,
 * so we don't reintroduce the staleness of a hardcoded model list. A
 * valid-shaped-but-nonexistent id (e.g. "gpt-99") is NOT caught here by design;
 * that fails loudly at run time against the provider API.
 */
export const PROVIDER_MODEL_PREFIXES: Record<ProviderName, readonly string[]> = {
  anthropic: ['claude-'],
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-'],
};

/** True when `model`'s id belongs to `provider`'s namespace. */
export function isModelForProvider(
  provider: ProviderName,
  model: string,
): boolean {
  return PROVIDER_MODEL_PREFIXES[provider].some((prefix) =>
    model.startsWith(prefix),
  );
}

/**
 * Human-readable explanation for a rejected (provider, model) pair. Callers
 * throw their own framework-appropriate exception (BadRequest at the HTTP edge,
 * LlmProviderError at run time) with this message so the text stays consistent.
 */
export function modelMismatchMessage(
  provider: ProviderName,
  model: string,
  field = 'model',
): string {
  const prefixes = PROVIDER_MODEL_PREFIXES[provider].join(', ');
  return (
    `${field} "${model}" is not a ${provider} model ` +
    `(expected an id starting with: ${prefixes}). ` +
    `Pick a ${provider} model or change the provider.`
  );
}
