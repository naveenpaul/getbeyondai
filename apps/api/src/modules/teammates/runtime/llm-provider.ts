import type {
  CreateMessageParams,
  CreateMessageResult,
  ProviderCapabilities,
} from './llm-types';

/**
 * The provider-neutral LLM driver (LLM provider abstraction — plan P1).
 *
 * Every model call in the teammate runtime ultimately goes through one
 * `LlmProvider.createMessage`. Concrete adapters live in `providers/`
 * (`AnthropicProvider`, later `OpenAIProvider`) and are the ONLY place a
 * vendor SDK is imported. A provider instance is built per AgentRun, bound to
 * the resolved (and, for BYO, decrypted) API key for that run's lifetime — so
 * the key is decrypted once and never appears in the per-call signature.
 *
 * Note on the chokepoint: `callModel()` still wraps every `createMessage`
 * call to enforce the per-run budget and write the ModelCall audit row.
 * `LlmProvider` is the swappable transport; `callModel` is the policy layer.
 */
export interface LlmProvider {
  /** Stable provider id ('anthropic' | 'openai') — surfaced in errors/audit. */
  readonly name: string;
  /** What this provider/model supports. Asserted at run start (fail-fast). */
  readonly capabilities: ProviderCapabilities;
  /** Make one model call, translating neutral params to/from the vendor API. */
  createMessage(params: CreateMessageParams): Promise<CreateMessageResult>;
}

/**
 * DI token for the per-run LLM provider.
 *
 * In P1 this resolves to a singleton `AnthropicProvider` built from env
 * (`ANTHROPIC_API_KEY`). In later phases a registry/resolver replaces the
 * singleton with a per-run, per-org provider bound to the resolved key.
 */
export const LLM_PROVIDER = Symbol.for('@getbeyond/llm-provider');
