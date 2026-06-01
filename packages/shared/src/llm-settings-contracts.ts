/**
 * LLM settings HTTP contracts (BYO-key configuration).
 *
 * MIT (@getbeyond/shared) so the web client + extension bind without AGPL.
 * Lets a cloud org bring its own provider key and route teammates to a
 * provider/model. The API NEVER returns a stored key — only whether one is
 * configured. Self-hosters configure via env (LLM_ALLOW_ENV_FALLBACK); this
 * surface reports whether that fallback is active.
 */

export type LlmProviderName = 'anthropic' | 'openai';

/** Whether the org has a stored key for a provider (never the key itself). */
export interface LlmProviderStatus {
  provider: LlmProviderName;
  configured: boolean;
}

/** Per-teammate provider + model routing (OrgTeammateConfig). */
export interface TeammateRoutingConfig {
  teammate: string;
  provider: LlmProviderName;
  modelPrimary: string;
  modelFast: string;
}

// ─── GET /settings/llm ──────────────────────────────────────────────

export interface LlmSettingsResponse {
  providers: LlmProviderStatus[];
  teammates: TeammateRoutingConfig[];
  /** True when the self-host env fallback is active (LLM_ALLOW_ENV_FALLBACK). */
  envFallbackEnabled: boolean;
}

// ─── POST /settings/llm/credentials ─────────────────────────────────
//
// Stores (seals) the org's key for a provider. Identity from the session.

export interface SaveLlmCredentialRequest {
  provider: LlmProviderName;
  apiKey: string;
}

export interface SaveLlmCredentialResponse {
  provider: LlmProviderName;
  configured: true;
}

// ─── PUT /settings/llm/routing ──────────────────────────────────────
//
// Routes a teammate to a provider + models (upsert OrgTeammateConfig).

export interface SaveLlmRoutingRequest {
  teammate: string;
  provider: LlmProviderName;
  /** Optional model overrides; the server applies provider defaults if omitted. */
  modelPrimary?: string;
  modelFast?: string;
}
