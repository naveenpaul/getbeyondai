import { Inject, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import type {
  LlmProviderName,
  LlmProviderStatus,
  LlmSettingsResponse,
  SaveLlmCredentialResponse,
  TeammateRoutingConfig,
} from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LlmCredentialManager } from '../teammates/runtime/llm-credential-manager';
import { LLM_PROVIDER_NAMES } from './llm-settings.dto';

/**
 * LlmSettingsService — BYO-key configuration + teammate routing (P3 surface).
 *
 * Every method is scoped to an `orgId` the controller derives from the session
 * (never the body). The status endpoint reports ONLY whether a key exists — the
 * sealed key bytes never leave the credential layer (BYO-key isolation is a
 * REGRESSION-IF-BROKEN path).
 */

/**
 * Per-provider default model ids, applied when a routing request omits them.
 *
 * - anthropic: matches the OrgTeammateConfig schema defaults (claude-sonnet-4-6
 *   primary, claude-haiku-4-5-20251001 fast).
 * - openai: CONFIRM THESE. Chosen as current sensible defaults (gpt-4.1 primary,
 *   gpt-4.1-mini fast). The schema only defaults to the anthropic ids, so an
 *   openai routing row needs explicit model ids — these are the fallback when
 *   the request omits them.
 */
export const PROVIDER_DEFAULT_MODELS: Record<
  LlmProviderName,
  { modelPrimary: string; modelFast: string }
> = {
  anthropic: {
    modelPrimary: 'claude-sonnet-4-6',
    modelFast: 'claude-haiku-4-5-20251001',
  },
  openai: {
    modelPrimary: 'gpt-4.1',
    modelFast: 'gpt-4.1-mini',
  },
};

/** Self-host escape hatch: process-level env-key fallback toggle. */
const ENV_FALLBACK_FLAG = 'LLM_ALLOW_ENV_FALLBACK';

/** shared LlmProviderName → Prisma Provider enum. Total over the union. */
export function toPrismaProvider(name: LlmProviderName): Provider {
  return name === 'anthropic' ? Provider.anthropic : Provider.openai;
}

/** Prisma Provider enum → shared LlmProviderName. Total over the enum. */
export function toProviderName(provider: Provider): LlmProviderName {
  return provider === Provider.openai ? 'openai' : 'anthropic';
}

@Injectable()
export class LlmSettingsService {
  // Explicit field + @Inject + manual assignment (NOT param-property shorthand):
  // vitest/esbuild drops design:paramtypes metadata, so the shorthand injects
  // undefined under test. See getbeyond CLAUDE.md "NestJS DI — pitfall".
  private readonly prisma: PrismaService;
  private readonly credentials: LlmCredentialManager;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(LlmCredentialManager) credentials: LlmCredentialManager,
  ) {
    this.prisma = prisma;
    this.credentials = credentials;
  }

  /**
   * Full settings view for the org: which providers have a stored key (boolean
   * only — never the bytes), the teammate routing rows, and whether the
   * self-host env fallback is active.
   */
  async getSettings(orgId: string): Promise<LlmSettingsResponse> {
    const [credentialRows, configRows] = await Promise.all([
      this.prisma.orgLlmCredential.findMany({
        where: { orgId },
        // Explicit projection: the sealed `apiKey` bytes must never be loaded
        // into this read path. We only need the provider to mark `configured`.
        select: { provider: true },
      }),
      this.prisma.orgTeammateConfig.findMany({
        where: { orgId },
        orderBy: { teammate: 'asc' },
      }),
    ]);

    const configuredProviders = new Set(
      credentialRows.map((row) => row.provider),
    );

    const providers: LlmProviderStatus[] = LLM_PROVIDER_NAMES.map((name) => ({
      provider: name,
      configured: configuredProviders.has(toPrismaProvider(name)),
    }));

    const teammates: TeammateRoutingConfig[] = configRows.map((row) => ({
      teammate: row.teammate,
      provider: toProviderName(row.provider),
      modelPrimary: row.modelPrimary,
      modelFast: row.modelFast,
    }));

    return {
      providers,
      teammates,
      envFallbackEnabled: process.env[ENV_FALLBACK_FLAG] === 'true',
    };
  }

  /**
   * Seal + store (or rotate) the org's key for a provider. Delegates the crypto
   * + persistence to LlmCredentialManager; this method never touches the
   * plaintext beyond passing it through. Returns only the configured flag — the
   * key is never echoed back.
   */
  async saveCredential(
    orgId: string,
    provider: LlmProviderName,
    apiKey: string,
  ): Promise<SaveLlmCredentialResponse> {
    await this.credentials.save(orgId, toPrismaProvider(provider), apiKey);
    return { provider, configured: true };
  }

  /**
   * Upsert the org's routing for a teammate on (orgId, teammate). When model
   * ids are omitted, the per-provider defaults from PROVIDER_DEFAULT_MODELS
   * apply. Returns the resulting routing config.
   */
  async saveRouting(
    orgId: string,
    request: {
      teammate: string;
      provider: LlmProviderName;
      modelPrimary?: string;
      modelFast?: string;
    },
  ): Promise<TeammateRoutingConfig> {
    const defaults = PROVIDER_DEFAULT_MODELS[request.provider];
    const modelPrimary = request.modelPrimary ?? defaults.modelPrimary;
    const modelFast = request.modelFast ?? defaults.modelFast;
    const provider = toPrismaProvider(request.provider);

    const row = await this.prisma.orgTeammateConfig.upsert({
      where: { orgId_teammate: { orgId, teammate: request.teammate } },
      create: {
        orgId,
        teammate: request.teammate,
        provider,
        modelPrimary,
        modelFast,
      },
      update: {
        provider,
        modelPrimary,
        modelFast,
      },
    });

    return {
      teammate: row.teammate,
      provider: toProviderName(row.provider),
      modelPrimary: row.modelPrimary,
      modelFast: row.modelFast,
    };
  }
}
