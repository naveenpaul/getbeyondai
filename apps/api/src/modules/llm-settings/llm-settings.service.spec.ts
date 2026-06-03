import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { Provider } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { LlmCredentialManager } from '../teammates/runtime/llm-credential-manager';
import { LlmAuthError } from '../teammates/runtime/llm-types';
import type { KeyVerifier } from './key-verifier';
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
  load: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
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
    load: overrides?.load ?? vi.fn(async () => null),
    // Default: key verifies cleanly. Tests override to throw LlmAuthError etc.
    verify: overrides?.verify ?? vi.fn(async () => undefined),
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
    load: mocks.load,
  } as unknown as LlmCredentialManager;

  const verifier = { verify: mocks.verify } as unknown as KeyVerifier;

  return {
    service: new LlmSettingsService(prisma, credentials, verifier),
    mocks,
  };
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

  it('returns all known teammates, merging configured rows over anthropic defaults', async () => {
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

    // researcher reflects its row; the other known teammates default to
    // anthropic so the UI can still route them to a provider.
    expect(result.teammates).toEqual([
      {
        teammate: 'researcher',
        provider: 'openai',
        modelPrimary: 'gpt-4.1',
        modelFast: 'gpt-4.1-mini',
      },
      {
        teammate: 'sdr-drafter',
        provider: 'anthropic',
        modelPrimary: 'claude-sonnet-4-6',
        modelFast: 'claude-haiku-4-5-20251001',
      },
      {
        teammate: 'prospect-search-orchestrator',
        provider: 'anthropic',
        modelPrimary: 'claude-sonnet-4-6',
        modelFast: 'claude-haiku-4-5-20251001',
      },
    ]);
    expect(mocks.configFindMany).toHaveBeenCalledWith({
      where: { orgId: 'org-1' },
      orderBy: { teammate: 'asc' },
    });
  });

  it('exposes the per-provider model defaults so the client can repopulate on provider change', async () => {
    const { service } = makeService();

    const result = await service.getSettings('org-1');

    // Source of truth is the server constant — the client reads this rather
    // than hardcoding model ids of its own.
    expect(result.providerDefaults).toEqual(PROVIDER_DEFAULT_MODELS);
    expect(result.providerDefaults.openai).toEqual({
      modelPrimary: 'gpt-4.1',
      modelFast: 'gpt-4.1-mini',
    });
    expect(result.providerDefaults.anthropic).toEqual({
      modelPrimary: 'claude-sonnet-4-6',
      modelFast: 'claude-haiku-4-5-20251001',
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

  it('verifies the key before persisting (so a stored key authenticated once)', async () => {
    const verify = vi.fn(async () => undefined);
    const save = vi.fn(async () => undefined);
    const { service } = makeService({ verify, save });

    await service.saveCredential('org-1', 'openai', 'sk-good');

    expect(verify).toHaveBeenCalledWith('openai', 'sk-good');
    expect(save).toHaveBeenCalled();
  });

  it('rejects a key the provider refuses (auth error) and does NOT store it', async () => {
    const verify = vi.fn(async () => {
      throw new LlmAuthError('openai');
    });
    const save = vi.fn(async () => undefined);
    const { service } = makeService({ verify, save });

    await expect(
      service.saveCredential('org-1', 'openai', 'sk-bad'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('still stores the key on a transient (non-auth) verify failure (no outage lockout)', async () => {
    const verify = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    const save = vi.fn(async () => undefined);
    const { service } = makeService({ verify, save });

    const result = await service.saveCredential('org-1', 'openai', 'sk-ok');

    expect(save).toHaveBeenCalled();
    expect(result).toEqual({ provider: 'openai', configured: true });
  });
});

describe('LlmSettingsService.testCredential', () => {
  it('returns ok:true when the stored key verifies', async () => {
    const load = vi.fn(async () => 'sk-stored');
    const verify = vi.fn(async () => undefined);
    const { service } = makeService({ load, verify });

    const result = await service.testCredential('org-1', 'openai');

    expect(load).toHaveBeenCalledWith('org-1', Provider.openai);
    expect(verify).toHaveBeenCalledWith('openai', 'sk-stored');
    expect(result).toEqual({ provider: 'openai', ok: true, error: null });
  });

  it('returns ok:false with an auth message when the stored key is rejected', async () => {
    const load = vi.fn(async () => 'sk-revoked');
    const verify = vi.fn(async () => {
      throw new LlmAuthError('anthropic');
    });
    const { service } = makeService({ load, verify });

    const result = await service.testCredential('org-1', 'anthropic');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected|authentication/i);
  });

  it('distinguishes a transient failure from an invalid key', async () => {
    const load = vi.fn(async () => 'sk-ok');
    const verify = vi.fn(async () => {
      throw new Error('provider overloaded');
    });
    const { service } = makeService({ load, verify });

    const result = await service.testCredential('org-1', 'openai');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('provider overloaded');
  });

  it('returns ok:false (not a throw) when no key is configured', async () => {
    const load = vi.fn(async () => null);
    const verify = vi.fn();
    const { service } = makeService({ load, verify });

    const result = await service.testCredential('org-1', 'openai');

    expect(result).toEqual({
      provider: 'openai',
      ok: false,
      error: 'No key is configured for this provider.',
    });
    // No key → never probes the provider.
    expect(verify).not.toHaveBeenCalled();
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

  // Root-fix: the write chokepoint rejects a provider↔model mismatch, so the
  // state that silently failed prospect search runs can never be persisted.
  it('rejects a primary model that does not belong to the provider (openai + claude-*)', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    await expect(
      service.saveRouting('org-1', {
        teammate: 'prospect-search-orchestrator',
        provider: 'openai',
        modelPrimary: 'claude-sonnet-4-6',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Must not persist the invalid row.
    expect(configUpsert).not.toHaveBeenCalled();
  });

  it('rejects a fast model that does not belong to the provider (anthropic + gpt-*)', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    await expect(
      service.saveRouting('org-1', {
        teammate: 'researcher',
        provider: 'anthropic',
        modelFast: 'gpt-4.1-mini',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(configUpsert).not.toHaveBeenCalled();
  });

  it('accepts a matching override and a forward-compatible new model in the family', async () => {
    const configUpsert = upsertEcho();
    const { service } = makeService({ configUpsert });

    // gpt-5-future isn't a known id but matches the openai namespace → allowed.
    const result = await service.saveRouting('org-1', {
      teammate: 'sdr-drafter',
      provider: 'openai',
      modelPrimary: 'gpt-5-future',
      modelFast: 'o3-mini',
    });

    expect(result.modelPrimary).toBe('gpt-5-future');
    expect(result.modelFast).toBe('o3-mini');
    expect(configUpsert).toHaveBeenCalled();
  });
});
