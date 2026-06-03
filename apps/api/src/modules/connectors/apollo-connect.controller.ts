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
  isApolloAllowed,
  type DeploymentMode,
} from '../../common/deployment';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { CredentialManager } from './credential-manager';

/**
 * Connect / inspect the org's Apollo BYO-key connector.
 *
 *   POST /connectors/apollo/account  → validate the key (ping) + persist it
 *                                       encrypted; 201 { id, status:'connected' }
 *   GET  /connectors/apollo/account  → { connected, status? }
 *
 * Once connected, prospect searches auto-discover companies from the derived ICP via
 * Apollo Organization Search (see prospect-search.worker buildSourcingProvider).
 *
 * The adapter is injected (not the module singleton) so unit tests can stub
 * `ping` without hitting Apollo. The key is validated here but only ever
 * persisted through CredentialManager, which encrypts at the boundary
 * (invariant #6) — this controller never touches the master key.
 */

/** DI token for the Apollo pinger (the real adapter in prod, a stub in tests). */
export const APOLLO_SOURCE_ADAPTER = Symbol('APOLLO_SOURCE_ADAPTER');

/** The slice of the Apollo adapter this controller needs. */
export interface ApolloPinger {
  ping(creds: DecryptedCredentials): Promise<PingResult>;
}

const ConnectApolloSchema = z.object({
  apiKey: z.string().min(1, 'apiKey is required'),
});

export interface ApolloAccountStatusResponse {
  /** False on Cloud — Apollo discovery is self-host-only; the UI hides on false. */
  available: boolean;
  connected: boolean;
  /** ConnectorAccount.status when connected (active | expired | circuit_broken | …). */
  status?: string;
}

export interface ConnectApolloResponse {
  id: string;
  status: 'connected';
}

@Controller('connectors/apollo')
@UseGuards(AuthGuard)
export class ApolloConnectController {
  private readonly prisma: PrismaService;
  private readonly credentials: CredentialManager;
  private readonly adapter: ApolloPinger;
  private readonly deploymentMode: DeploymentMode;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall".
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentials: CredentialManager,
    @Inject(APOLLO_SOURCE_ADAPTER) adapter: ApolloPinger,
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
  ): Promise<ApolloAccountStatusResponse> {
    const available = isApolloAllowed(this.deploymentMode);
    if (!available) {
      // On Cloud there's no Apollo account and connecting is forbidden; report
      // unavailable so the UI hides the affordance entirely.
      return { available: false, connected: false };
    }
    const account = await this.prisma.connectorAccount.findUnique({
      where: { orgId_kind: { orgId: user.orgId, kind: 'apollo' } },
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
  ): Promise<ConnectApolloResponse> {
    if (!isApolloAllowed(this.deploymentMode)) {
      // Apollo's API ToS only permit a self-hosted, own-key integration.
      throw new ForbiddenException(
        'Apollo discovery is available on self-hosted getbeyond only.',
      );
    }
    const parsed = ConnectApolloSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const creds: DecryptedCredentials = { apiKey: parsed.data.apiKey };
    // Validate before persisting so the user gets immediate feedback on a bad
    // key rather than a silent failure at the first prospect search run.
    const ping = await this.adapter.ping(creds);
    if (!ping.ok) {
      throw new BadRequestException(
        `Apollo rejected the API key${ping.error ? `: ${ping.error}` : ''}`,
      );
    }

    const id = await this.credentials.persistInitialCredentials({
      orgId: user.orgId,
      kind: 'apollo',
      authMode: 'byo_key',
      creds,
    });
    return { id, status: 'connected' };
  }
}
