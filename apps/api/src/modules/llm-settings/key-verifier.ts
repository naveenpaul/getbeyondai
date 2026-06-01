import { Injectable } from '@nestjs/common';
import type { LlmProviderName } from '@getbeyond/shared';
import { createProvider } from '../teammates/runtime/providers/registry';

/**
 * Verifies a provider API key by making a 1-token "ping" through the normal
 * provider adapter.
 *
 * A bad/revoked key surfaces as `LlmAuthError` (the adapters normalize 401/403);
 * any other failure (network, overload, rate limit) propagates as its
 * `LlmProviderError` subtype, so callers can distinguish "the key is wrong" from
 * "couldn't reach the provider". This is its own injectable so the settings
 * service — and its unit tests — never touch the provider registry or vendor
 * SDKs directly (they mock this one method).
 *
 * Why a `createMessage` probe rather than a free "list models" call: the pinned
 * Anthropic SDK (0.30.x) exposes no models endpoint, so a 1-token message is the
 * lowest-common-denominator auth check across providers (≈ $0.00001 per call).
 */

/**
 * Cheap, currently-valid model per provider used ONLY for the auth probe — not
 * the org's routed model. If one of these is ever retired the probe degrades to
 * a non-auth error (reported as "couldn't verify", not "invalid key"), so a
 * stale entry never produces a false "invalid".
 */
const PROBE_MODEL: Record<LlmProviderName, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4.1-mini',
};

@Injectable()
export class KeyVerifier {
  /** Resolves if the key authenticates; throws the normalized provider error otherwise. */
  async verify(provider: LlmProviderName, apiKey: string): Promise<void> {
    const adapter = createProvider(provider, apiKey);
    await adapter.createMessage({
      model: PROBE_MODEL[provider],
      systemPrompt: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: 1,
    });
  }
}
