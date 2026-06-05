import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { DecryptedCredentials, PingResult } from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEPLOYMENT_MODE,
  isPdlAllowed,
  type DeploymentMode,
} from '../../common/deployment';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { CredentialManager } from './credential-manager';

/**
 * Connect / inspect the org's PDL (People Data Labs) BYO-key connector.
 *
 *   POST /connectors/pdl/account  → validate the key (ping) + persist it
 *                                    encrypted; 201 { id, status:'connected' }
 *   GET  /connectors/pdl/account  → { available, connected, status? }
 *
 * Once connected, prospect searches auto-run a best-effort enrichment pass
 * (Stage 2.5) that backfills firmographics on sourced companies before
 * qualification (see prospect-search.worker buildEnrichmentProvider).
 *
 * Deployment gate: PDL is allowed in all modes today (`isPdlAllowed`), so
 * `available` is always true — but the gate is wired exactly like Apollo's so a
 * future ToS-driven flip to self-host-only needs no controller change. The
 * adapter is injected (not the module singleton) so unit tests can stub `ping`
 * without hitting PDL. The key is validated here but only ever persisted through
 * CredentialManager, which encrypts at the boundary (invariant #6).
 */

/** DI token for the PDL pinger (the real adapter in prod, a stub in tests). */
export const PDL_ENRICHMENT_ADAPTER = Symbol('PDL_ENRICHMENT_ADAPTER');

/** The slice of the PDL adapter this controller needs. */
export interface PdlPinger {
  ping(creds: DecryptedCredentials): Promise<PingResult>;
}

const ConnectPdlSchema = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
});

export interface PdlAccountStatusResponse {
  /** False only if PDL is ever gated off (today always true); the UI hides on false. */
  available: boolean;
  connected: boolean;
  /** ConnectorAccount.status when connected (active | expired | circuit_broken | …). */
  status?: string;
}

export interface ConnectPdlResponse {
  id: string;
  status: 'connected';
}

@Controller('connectors/pdl')
@UseGuards(AuthGuard)
export class PdlConnectController {
  private readonly prisma: PrismaService;
  private readonly credentials: CredentialManager;
  private readonly adapter: PdlPinger;
  private readonly deploymentMode: DeploymentMode;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall".
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentials: CredentialManager,
    @Inject(PDL_ENRICHMENT_ADAPTER) adapter: PdlPinger,
    @Inject(DEPLOYMENT_MODE) deploymentMode: DeploymentMode,
  ) {
    this.prisma = prisma;
    this.credentials = credentials;
    this.adapter = adapter;
    this.deploymentMode = deploymentMode;
  }

  @Get('account')
  async status(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PdlAccountStatusResponse> {
    const available = isPdlAllowed(this.deploymentMode);
    if (!available) {
      // Gated off: no account, connecting is forbidden — report unavailable so
      // the UI hides the affordance entirely (parity with Apollo on Cloud).
      return { available: false, connected: false };
    }
    const account = await this.prisma.connectorAccount.findUnique({
      where: { orgId_kind: { orgId: user.orgId, kind: 'pdl' } },
      select: { status: true },
    });
    return account
      ? { available: true, connected: true, status: account.status }
      : { available: true, connected: false };
  }

  @Post('account')
  @HttpCode(201)
  async connect(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ConnectPdlResponse> {
    if (!isPdlAllowed(this.deploymentMode)) {
      throw new ForbiddenException(
        'PDL enrichment is not available on this deployment.',
      );
    }
    const parsed = ConnectPdlSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const creds: DecryptedCredentials = { apiKey: parsed.data.apiKey };
    // Validate before persisting so the user gets immediate feedback on a bad
    // key rather than a silent no-op at the first prospect search run.
    const ping = await this.adapter.ping(creds);
    if (!ping.ok) {
      throw new BadRequestException(
        `PDL rejected the API key${ping.error ? `: ${ping.error}` : ''}`,
      );
    }

    const id = await this.credentials.persistInitialCredentials({
      orgId: user.orgId,
      kind: 'pdl',
      authMode: 'byo_key',
      creds,
    });
    return { id, status: 'connected' };
  }
}
