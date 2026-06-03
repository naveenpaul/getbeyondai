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
 * Connect / inspect the org's ZoomInfo BYO-key connector.
 *
 *   POST /connectors/zoominfo/account → validate (ping) + persist encrypted;
 *                                       201 { id, status:'connected' }
 *   GET  /connectors/zoominfo/account → { connected, status? }
 *
 * Per-org BYO (clientId + clientSecret), mirroring Snov. ZoomInfo is the second
 * contacts-with-emails source: given a company name it returns people + enriched
 * (credit-consuming) emails. The waterfall tries ZoomInfo before Snov by default
 * (better verification for the verified-chase).
 *
 * The adapter is injected (not the singleton) so unit tests stub `ping` without
 * hitting ZoomInfo. Credentials are persisted only through CredentialManager,
 * which encrypts at the boundary (invariant #6).
 */

export const ZOOMINFO_SOURCE_ADAPTER = Symbol('ZOOMINFO_SOURCE_ADAPTER');

export interface ZoomInfoPinger {
  ping(creds: DecryptedCredentials): Promise<PingResult>;
}

const ConnectZoomInfoSchema = z.object({
  clientId: z.string().min(1, 'clientId is required'),
  clientSecret: z.string().min(1, 'clientSecret is required'),
});

export interface ZoomInfoAccountStatusResponse {
  connected: boolean;
  status?: string;
}

export interface ConnectZoomInfoResponse {
  id: string;
  status: 'connected';
}

@Controller('connectors/zoominfo')
@UseGuards(AuthGuard)
export class ZoomInfoConnectController {
  private readonly prisma: PrismaService;
  private readonly credentials: CredentialManager;
  private readonly adapter: ZoomInfoPinger;

  // Explicit @Inject + manual assignment — see CLAUDE.md "NestJS DI pitfall".
  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialManager) credentials: CredentialManager,
    @Inject(ZOOMINFO_SOURCE_ADAPTER) adapter: ZoomInfoPinger,
  ) {
    this.prisma = prisma;
    this.credentials = credentials;
    this.adapter = adapter;
  }

  @Get('account')
  async status(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ZoomInfoAccountStatusResponse> {
    const account = await this.prisma.connectorAccount.findUnique({
      where: { orgId_kind: { orgId: user.orgId, kind: 'zoominfo' } },
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
  ): Promise<ConnectZoomInfoResponse> {
    const parsed = ConnectZoomInfoSchema.safeParse(body);
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
    const ping = await this.adapter.ping(creds);
    if (!ping.ok) {
      throw new BadRequestException(
        `ZoomInfo rejected the credentials${ping.error ? `: ${ping.error}` : ''}`,
      );
    }

    const id = await this.credentials.persistInitialCredentials({
      orgId: user.orgId,
      kind: 'zoominfo',
      authMode: 'byo_key',
      creds,
    });
    return { id, status: 'connected' };
  }
}
