import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { DecryptedCredentials, PingResult } from '@getbeyond/shared';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import type { CredentialManager } from './credential-manager';
import {
  ZoomInfoConnectController,
  type ZoomInfoPinger,
} from './zoominfo-connect.controller';

const USER: CurrentUserPayload = {
  userId: 'u1',
  orgId: 'org-1',
  email: 'a@b.com',
  role: 'owner',
};

function makeController(opts: {
  ping?: (creds: DecryptedCredentials) => Promise<PingResult>;
  persist?: (args: unknown) => Promise<string>;
  account?: { status: string } | null;
}): {
  controller: ZoomInfoConnectController;
  persistSpy: ReturnType<typeof vi.fn>;
} {
  const prisma = {
    connectorAccount: { findUnique: vi.fn(async () => opts.account ?? null) },
  } as unknown as PrismaService;
  const persistSpy = vi.fn(opts.persist ?? (async () => 'acct-new'));
  const credentials = {
    persistInitialCredentials: persistSpy,
  } as unknown as CredentialManager;
  const adapter: ZoomInfoPinger = {
    ping: opts.ping ?? (async () => ({ ok: true, scopes: [] })),
  };
  return {
    controller: new ZoomInfoConnectController(prisma, credentials, adapter),
    persistSpy,
  };
}

describe('ZoomInfoConnectController.connect', () => {
  it('validates, persists, and returns connected', async () => {
    const { controller, persistSpy } = makeController({});
    const res = await controller.connect(
      { clientId: 'cid', clientSecret: 'csec' },
      USER,
    );
    expect(res).toEqual({ id: 'acct-new', status: 'connected' });
    expect(persistSpy).toHaveBeenCalledWith({
      orgId: 'org-1',
      kind: 'zoominfo',
      authMode: 'byo_key',
      creds: { clientId: 'cid', clientSecret: 'csec' },
    });
  });

  it('rejects missing fields with 400 before any vendor call', async () => {
    const ping = vi.fn(async () => ({ ok: true, scopes: [] }));
    const { controller, persistSpy } = makeController({ ping });
    await expect(
      controller.connect({ clientId: 'cid' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ping).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('rejects credentials ZoomInfo refuses, without persisting', async () => {
    const { controller, persistSpy } = makeController({
      ping: async () => ({ ok: false, scopes: [], error: 'bad creds' }),
    });
    await expect(
      controller.connect({ clientId: 'cid', clientSecret: 'no' }, USER),
    ).rejects.toThrow(/ZoomInfo rejected the credentials: bad creds/);
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

describe('ZoomInfoConnectController.status', () => {
  it('reports connected with status', async () => {
    const { controller } = makeController({ account: { status: 'active' } });
    expect(await controller.status(USER)).toEqual({
      connected: true,
      status: 'active',
    });
  });
  it('reports not connected when no account', async () => {
    const { controller } = makeController({ account: null });
    expect(await controller.status(USER)).toEqual({ connected: false });
  });
});
