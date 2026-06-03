import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { DecryptedCredentials, PingResult } from '@getbeyond/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { CredentialManager } from './credential-manager';

/**
 * Connect / inspect the org's Snov.io BYO-key connector.
 *
 *   POST /connectors/snov/account  → validate the credentials (ping) + persist
 *                                     them encrypted; 201 { id, status:'connected' }
 *   GET  /connectors/snov/account  → { connected, status? }
 *
 * Snov is the contacts-with-emails source: given company domains, it returns
 * prospects + (best-effort verified) emails. Unlike Apollo it is NOT gated to
 * self-host — Snov's API is built for SaaS integrations with caller-supplied
 * credentials. (Open follow-up: a formal Cloud ToS vet, tracked with the Apollo
 * §3 analysis; until then Cloud may surface Snov but we have not warranted it.)
 *
 * The adapter is injected (not the module singleton) so unit tests can stub
 * `ping` without hitting Snov. Credentials are validated here but only ever
 * persisted through CredentialManager, which encrypts at the boundary
 * (invariant #6) — this controller never touches the master key.
 */

/** DI token for the Snov pinger (the real adapter in prod, a stub in tests). */
export const SNOV_SOURCE_ADAPTER = Symbol('SNOV_SOURCE_ADAPTER');

/** The slice of the Snov adapter this controller needs. */
export interface SnovPinger {
  ping(creds: DecryptedCredentials): Promise<PingResult>;
}

const ConnectSnovSchema = z.object({
  clientId: z.string().min(1, 'clientId is required'),
  clientSecret: z.string().min(1, 'clientSecret is required'),
});

export interface SnovAccountStatusResponse {
  connected: boolean;
  /** ConnectorAccount.status when connected (active | expired | circuit_broken | …). */
  status?: string;
}

export interface ConnectSnovResponse {
  id: string;
  status: 'connected';
}

@Controller('connectors/snov')
@UseGuards(AuthGuard)
export class SnovConnectController {
  private readonly prisma: PrismaService;
  private readonly credentials: CredentialManager;
  private readonly adapter: SnovPinger;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS dependency
  // injection — pitfall".
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentials: CredentialManager,
    @Inject(SNOV_SOURCE_ADAPTER) adapter: SnovPinger,
  ) {
    this.prisma = prisma;
    this.credentials = credentials;
    this.adapter = adapter;
  }

  @Get('account')
  async status(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<SnovAccountStatusResponse> {
    const account = await this.prisma.connectorAccount.findUnique({
      where: { orgId_kind: { orgId: user.orgId, kind: 'snov' } },
      select: { status: true },
    });
    return account
      ? { connected: true, status: account.status }
      : { connected: false };
  }

  @Post('account')
  @HttpCode(201)
  async connect(
    @Body() body: unknown,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ConnectSnovResponse> {
    const parsed = ConnectSnovSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `request body validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }

    const creds: DecryptedCredentials = {
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
    };
    // Validate before persisting so the user gets immediate feedback on bad
    // credentials rather than a silent failure at the first sync.
    const ping = await this.adapter.ping(creds);
    if (!ping.ok) {
      throw new BadRequestException(
        `Snov rejected the credentials${ping.error ? `: ${ping.error}` : ''}`,
      );
    }

    const id = await this.credentials.persistInitialCredentials({
      orgId: user.orgId,
      kind: 'snov',
      authMode: 'byo_key',
      creds,
    });
    return { id, status: 'connected' };
  }
}
