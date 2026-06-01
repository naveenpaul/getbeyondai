import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { LlmCredentialManager } from '../teammates/runtime/llm-credential-manager';
import {
  LlmSettingsService,
  PROVIDER_DEFAULT_MODELS,
  toPrismaProvider,
  toProviderName,
} from './llm-settings.service';

/**
 * LlmSettingsService unit tests — mocked PrismaService + LlmCredentialManager,
 * no DB and no real crypto. Explicit vitest imports (`globals: false`).
 *
 * Critical invariants under test:
 *   - GET maps `configured` per provider AND never reads/returns key bytes
 *     (the credential read uses an explicit `select` excluding `apiKey`).
 *   - saveCredential delegates to the manager (no plaintext echoed back).
 *   - saveRouting upserts on (orgId, teammate) and applies per-provider model
 *     defaults when omitted; explicit overrides win.
 *   - provider ↔ Prisma enum mapping is total + symmetric.
 */

interface ServiceMocks {
  credentialFindMany: ReturnType<typeof vi.fn>;
  configFindMany: ReturnType<typeof vi.fn>;
  configUpsert: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function makeService(overrides?: Partial<ServiceMocks>): {
  service: LlmSettingsService;
  mocks: ServiceMocks;
} {
  const mocks: ServiceMocks = {
    credentialFindMany: overrides?.credentialFindMany ?? vi.fn(async () => []),
    configFindMany: overrides?.configFindMany ?? vi.fn(async () => []),
    configUpsert: overrides?.configUpsert ?? vi.fn(),
    save: overrides?.save ?? vi.fn(async () => undefined),
  };

  const prisma = {
    orgLlmCredential: { findMany: mocks.credentialFindMany },
    orgTeammateConfig: {
      findMany: mocks.configFindMany,
      upsert: mocks.configUpsert,
    },
  } as unknown as PrismaService;

  const credentials = {
    save: mocks.save,
  } as unknown as LlmCredentialManager;

  return { service: new LlmSettingsService(prisma, credentials), mocks };
}

describe('toPrismaProvider / toProviderName', () => {
  it('maps the shared union to the Prisma enum and back symmetrically', () => {
    expect(toPrismaProvider('anthropic')).toBe(Provider.anthropic);
    expect(toPrismaProvider('openai')).toBe(Provider.openai);
    expect(toProviderName(Provider.anthropic)).toBe('anthropic');
    expect(toProviderName(Provider.openai)).toBe('openai');
  });
});

describe('LlmSettingsService.getSettings', () => {
  const ENV_FLAG = 'LLM_ALLOW_ENV_FALLBACK';
  const originalFlag = process.env[ENV_FLAG];

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[ENV_FLAG];
    } else {
      process.env[ENV_FLAG] = originalFlag;
    }
  });

  it('reports configured=true only for providers with a credential row', async () => {
    const { service, mocks } = makeService({
      credentialFindMany: vi.fn(async () => [{ provider: Provider.anthropic }]),
    });

    const result = await service.getSettings('org-1');

    expect(result.providers).toEqual([
      { provider: 'anthropic', configured: true },
      { provider: 'openai', configured: false },
    ]);
    // The credential read MUST be scoped to the org and MUST NOT select the
    // sealed key bytes — assert the explicit projection.
    expect(mocks.credentialFindMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1' },
      select: { provider: true },
    });
  });

  it('marks both providers configured when both rows exist', async () => {
    const { service } = makeService({
      credentialFindMany: vi.fn(async () => [
        { provider: Provider.anthropic },
        { provider: Provider.openai },
      ]),
    });

    const result = await service.getSettings('org-1');

    expect(result.providers).toEqual([
      { provider: 'anthropic', configured: true },
      { provider: 'openai', configured: true },
    ]);
  });

  it('never exposes key material — the result has no apiKey field anywhere', async () => {
    const { service } = makeService({
      credentialFindMany: vi.fn(async () => [{ provider: Provider.openai }]),
    });

    const result = await service.getSettings('org-1');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('key');
  });

  it('maps OrgTeammateConfig rows to TeammateRoutingConfig', async () => {
    const { service, mocks } = makeService({
      configFindMany: vi.fn(async () => [
        {
          teammate: 'researcher',
          provider: Provider.openai,
          modelPrimary: 'gpt-4.1',
          modelFast: 'gpt-4.1-mini',
        },
      ]),
    });

    const result = await service.getSettings('org-1');

    expect(result.teammates).toEqual([
      {
        teammate: 'researcher',
        provider: 'openai',
        modelPrimary: 'gpt-4.1',
        modelFast: 'gpt-4.1-mini',
      },
    ]);
    expect(mocks.configFindMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1' },
      orderBy: { teammate: 'asc' },
    });
  });

  it('returns envFallbackEnabled=true only when the flag is exactly "true"', async () => {
    process.env[ENV_FLAG] = 'true';
    const enabled = await makeService().service.getSettings('org-1');
    expect(enabled.envFallbackEnabled).toBe(true);

    process.env[ENV_FLAG] = 'false';
    const disabled = await makeService().service.getSettings('org-1');
    expect(disabled.envFallbackEnabled).toBe(false);

    delete process.env[ENV_FLAG];
    const unset = await makeService().service.getSettings('org-1');
    expect(unset.envFallbackEnabled).toBe(false);
  });
});

describe('LlmSettingsService.saveCredential', () => {
  it('delegates to the credential manager with the mapped enum and returns configured:true', async () => {
    const save = vi.fn(async () => undefined);
    const { service } = makeService({ save });

    const result = await service.saveCredential('org-1', 'openai', 'sk-secret');

    expect(save).toHaveBeenCalledWith('org-1', Provider.openai, 'sk-secret');
    expect(result).toEqual({ provider: 'openai', configured: true });
  });

  it('never echoes the apiKey back in the response', async () => {
    const { service } = makeService();
    const result = await service.saveCredential('org-1', 'anthropic', 'sk-leak');
    expect(JSON.stringify(result)).not.toContain('sk-leak');
  });
});

describe('LlmSettingsService.saveRouting', () => {
  function upsertEcho() {
    return vi.fn(
      async ({ create }: { create: Record<string, unknown> }) => create,
    );
  }

  it('upserts on (orgId, teammate) applying anthropic defaults when models omitted', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    const result = await service.saveRouting('org-1', {
      teammate: 'researcher',
      provider: 'anthropic',
    });

    expect(configUpsert).toHaveBeenCalledWith({
      where: { orgId_teammate: { orgId: 'org-1', teammate: 'researcher' } },
      create: {
        orgId: 'org-1',
        teammate: 'researcher',
        provider: Provider.anthropic,
        modelPrimary: PROVIDER_DEFAULT_MODELS.anthropic.modelPrimary,
        modelFast: PROVIDER_DEFAULT_MODELS.anthropic.modelFast,
      },
      update: {
        provider: Provider.anthropic,
        modelPrimary: PROVIDER_DEFAULT_MODELS.anthropic.modelPrimary,
        modelFast: PROVIDER_DEFAULT_MODELS.anthropic.modelFast,
      },
    });
    expect(result).toEqual({
      teammate: 'researcher',
      provider: 'anthropic',
      modelPrimary: PROVIDER_DEFAULT_MODELS.anthropic.modelPrimary,
      modelFast: PROVIDER_DEFAULT_MODELS.anthropic.modelFast,
    });
  });

  it('applies openai defaults when models omitted', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    const result = await service.saveRouting('org-1', {
      teammate: 'sdr',
      provider: 'openai',
    });

    expect(result).toEqual({
      teammate: 'sdr',
      provider: 'openai',
      modelPrimary: PROVIDER_DEFAULT_MODELS.openai.modelPrimary,
      modelFast: PROVIDER_DEFAULT_MODELS.openai.modelFast,
    });
  });

  it('honors explicit model overrides over the provider defaults', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    const result = await service.saveRouting('org-1', {
      teammate: 'researcher',
      provider: 'anthropic',
      modelPrimary: 'claude-custom-primary',
      modelFast: 'claude-custom-fast',
    });

    expect(result.modelPrimary).toBe('claude-custom-primary');
    expect(result.modelFast).toBe('claude-custom-fast');
  });

  it('returns the persisted row mapped back to TeammateRoutingConfig', async () => {
    const configUpsert = vi.fn(async () => ({
      teammate: 'researcher',
      provider: Provider.anthropic,
      modelPrimary: 'claude-sonnet-4-6',
      modelFast: 'claude-haiku-4-5-20251001',
    }));
    const { service } = makeService({ configUpsert });

    const result = await service.saveRouting('org-1', {
      teammate: 'researcher',
      provider: 'anthropic',
    });

    expect(result).toEqual({
      teammate: 'researcher',
      provider: 'anthropic',
      modelPrimary: 'claude-sonnet-4-6',
      modelFast: 'claude-haiku-4-5-20251001',
    });
  });
});
