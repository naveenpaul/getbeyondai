import { Inject, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { LlmCredentialManager } from './llm-credential-manager';
import type { LlmProvider } from './llm-provider';
import { LlmProviderError, type ProviderName } from './llm-types';
import { isModelForProvider, modelMismatchMessage } from './model-namespace';
import { createProvider } from './providers/registry';
import {
  resolveLlm,
  type ResolveLlmEnv,
  type TeammateRouting,
} from './resolve-llm';

/**
 * Nest service that turns the pure P4 resolution chain into a ready-to-use,
 * per-run provider (P5). At run start a teammate calls `resolve(orgId, teammate)`
 * and gets a provider bound to the resolved (org BYO or env) key + the models
 * to use — replacing the single env-built Anthropic singleton (`LLM_PROVIDER`).
 *
 * Capability fail-fast (plan #7): every teammate drives a tool-use loop, so a
 * resolved provider/model without tool-use support is rejected here, before any
 * spend, rather than failing mid-run.
 */

export interface ResolvedTeammateLlm {
  provider: LlmProvider;
  modelPrimary: string;
  modelFast: string;
  /** Where the key came from — for the audit log / debugging. */
  source: 'byo' | 'env';
}

@Injectable()
export class LlmResolver {
  private readonly prisma: PrismaService;
  private readonly credentials: LlmCredentialManager;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(LlmCredentialManager) credentials: LlmCredentialManager,
  ) {
    this.prisma = prisma;
    this.credentials = credentials;
  }

  async resolve(orgId: string, teammate: string): Promise<ResolvedTeammateLlm> {
    const resolved = await resolveLlm(
      {
        loadCredential: (org, provider) =>
          this.credentials.load(org, toPrismaProvider(provider)),
        loadTeammateRouting: (org, tm) => this.loadRouting(org, tm),
        env: readEnv(),
      },
      orgId,
      teammate,
    );

    // Namespace fail-fast: catch a provider↔model mismatch (e.g. a pre-existing
    // OpenAI route still pointing at a claude-* model) BEFORE any spend, with a
    // clear message — instead of an opaque provider 404 mid-run that the
    // orchestrator can only surface as a bare "failed". The write chokepoint
    // (saveRouting) blocks new bad rows; this guards rows saved before the
    // validation existed and any non-UI write path (env fallback, extension).
    for (const [field, model] of [
      ['modelPrimary', resolved.modelPrimary],
      ['modelFast', resolved.modelFast],
    ] as const) {
      if (!isModelForProvider(resolved.providerName, model)) {
        throw new LlmProviderError(
          modelMismatchMessage(resolved.providerName, model, field),
          resolved.providerName,
        );
      }
    }

    const provider = createProvider(resolved.providerName, resolved.apiKey);
    if (!provider.capabilities.toolUse) {
      throw new LlmProviderError(
        `Provider "${resolved.providerName}" (model ${resolved.modelPrimary}) ` +
          'does not support tool use, which every teammate requires.',
        resolved.providerName,
      );
    }

    return {
      provider,
      modelPrimary: resolved.modelPrimary,
      modelFast: resolved.modelFast,
      source: resolved.source,
    };
  }

  private async loadRouting(
    orgId: string,
    teammate: string,
  ): Promise<TeammateRouting | null> {
    const row = await this.prisma.orgTeammateConfig.findUnique({
      where: { orgId_teammate: { orgId, teammate } },
    });
    if (!row) return null;
    return {
      provider: toProviderName(row.provider),
      modelPrimary: row.modelPrimary,
      modelFast: row.modelFast,
    };
  }
}

/** Read the env snapshot for the self-host fallback once per resolve. */
function readEnv(): ResolveLlmEnv {
  return {
    allowFallback: process.env.LLM_ALLOW_ENV_FALLBACK === 'true',
    provider: parseProviderName(process.env.LLM_PROVIDER),
    modelPrimary: process.env.LLM_MODEL ?? null,
    modelFast: process.env.LLM_MODEL_FAST ?? null,
    apiKeyFor: (p) => process.env[`${p.toUpperCase()}_API_KEY`] ?? null,
  };
}

function parseProviderName(v: string | undefined): ProviderName | null {
  return v === 'anthropic' || v === 'openai' ? v : null;
}

function toPrismaProvider(p: ProviderName): Provider {
  return p === 'openai' ? Provider.openai : Provider.anthropic;
}

function toProviderName(p: Provider): ProviderName {
  return p === Provider.openai ? 'openai' : 'anthropic';
}
