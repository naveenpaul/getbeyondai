import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from '@prisma/client';
import { LlmResolver } from './llm-resolver';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import type { LlmCredentialManager } from './llm-credential-manager';

/**
 * LlmResolver glue: wires the (100%-tested) P4 chain to the real credential
 * manager + OrgTeammateConfig + env, then builds the per-run provider via the
 * registry. Prisma + manager mocked; createProvider is real (constructs the
 * adapter, no network). Explicit vitest imports — `globals: false`.
 */

function resolver(over: {
  routing?: {
    provider: Provider;
    modelPrimary: string;
    modelFast: string;
  } | null;
  load?: (orgId: string, provider: Provider) => Promise<string | null>;
}): LlmResolver {
  const prisma = {
    orgTeammateConfig: {
      findUnique: vi.fn(async () => over.routing ?? null),
    },
  } as unknown as PrismaService;
  const creds = {
    load: vi.fn(over.load ?? (async () => null)),
  } as unknown as LlmCredentialManager;
  return new LlmResolver(prisma, creds);
}

describe('LlmResolver', () => {
  const ORIG_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIG_ENV };
  });
  afterEach(() => {
    process.env = ORIG_ENV;
  });

  it('builds the org BYO provider for the teammate-routed provider + models', async () => {
    const r = resolver({
      routing: {
        provider: Provider.openai,
        modelPrimary: 'gpt-4.1',
        modelFast: 'gpt-4.1-mini',
      },
      load: async (_org, p) => (p === Provider.openai ? 'sk-openai' : null),
    });

    const out = await r.resolve('org-1', 'researcher');

    expect(out.provider.name).toBe('openai');
    expect(out.modelPrimary).toBe('gpt-4.1');
    expect(out.modelFast).toBe('gpt-4.1-mini');
    expect(out.source).toBe('byo');
    // Capability fail-fast passed → provider supports tool use.
    expect(out.provider.capabilities.toolUse).toBe(true);
  });

  it('falls back to the env provider when no routing/BYO and fallback is on', async () => {
    process.env.LLM_ALLOW_ENV_FALLBACK = 'true';
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';

    const r = resolver({ routing: null, load: async () => null });

    const out = await r.resolve('org-1', 'researcher');

    expect(out.provider.name).toBe('anthropic');
    expect(out.source).toBe('env');
  });

  it('blocks when nothing is configured and env fallback is off', async () => {
    process.env.LLM_ALLOW_ENV_FALLBACK = 'false';
    delete process.env.ANTHROPIC_API_KEY;

    const r = resolver({ routing: null, load: async () => null });

    await expect(r.resolve('org-1', 'researcher')).rejects.toThrow(
      /no llm credentials/i,
    );
  });

  // Defense-in-depth for the provider↔model root fix: a pre-existing bad row
  // (saved before the write-time guard) fails fast at resolve, BEFORE any spend,
  // with a clear message — instead of an opaque provider 404 mid-run.
  it('fails fast on a provider↔model mismatch (openai route + claude-* model)', async () => {
    const r = resolver({
      routing: {
        provider: Provider.openai,
        modelPrimary: 'claude-sonnet-4-6',
        modelFast: 'claude-haiku-4-5-20251001',
      },
      load: async (_org, p) => (p === Provider.openai ? 'sk-openai' : null),
    });

    await expect(r.resolve('org-1', 'prospect-search-orchestrator')).rejects.toThrow(
      /is not a openai model/i,
    );
  });
});
