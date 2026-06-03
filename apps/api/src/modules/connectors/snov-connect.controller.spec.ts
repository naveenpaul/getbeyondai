import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { DecryptedCredentials, PingResult } from '@getbeyond/shared';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import type { CredentialManager } from './credential-manager';
import {
  SnovConnectController,
  type SnovPinger,
} from './snov-connect.controller';

/**
 * Unit tests for the Snov connect controller. Deps are stubbed (no DI, no
 * network) — we cover validation, credential-rejection, persistence, and
 * status. Explicit vitest imports — `globals: false`.
 */

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
  controller: SnovConnectController;
  persistSpy: ReturnType<typeof vi.fn>;
  findUniqueSpy: ReturnType<typeof vi.fn>;
} {
  const findUniqueSpy = vi.fn(async () => opts.account ?? null);
  const prisma = {
    connectorAccount: { findUnique: findUniqueSpy },
  } as unknown as PrismaService;

  const persistSpy = vi.fn(opts.persist ?? (async () => 'acct-new'));
  const credentials = {
    persistInitialCredentials: persistSpy,
  } as unknown as CredentialManager;

  const adapter: SnovPinger = {
    ping: opts.ping ?? (async () => ({ ok: true, scopes: [] })),
  };

  return {
    controller: new SnovConnectController(prisma, credentials, adapter),
    persistSpy,
    findUniqueSpy,
  };
}

describe('SnovConnectController.connect', () => {
  it('validates the credentials, persists them, and returns connected', async () => {
    const { controller, persistSpy } = makeController({});
    const res = await controller.connect(
      { clientId: 'cid', clientSecret: 'csecret' },
      USER,
    );

    expect(res).toEqual({ id: 'acct-new', status: 'connected' });
    expect(persistSpy).toHaveBeenCalledWith({
      orgId: 'org-1',
      kind: 'snov',
      authMode: 'byo_key',
      creds: { clientId: 'cid', clientSecret: 'csecret' },
    });
  });

  it('rejects a missing clientSecret with 400 before any vendor call', async () => {
    const ping = vi.fn(async () => ({ ok: true, scopes: [] }));
    const { controller, persistSpy } = makeController({ ping });
    await expect(
      controller.connect({ clientId: 'cid' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ping).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing clientId with 400', async () => {
    const { controller, persistSpy } = makeController({});
    await expect(
      controller.connect({ clientSecret: 'csecret' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('rejects credentials Snov refuses, without persisting', async () => {
    const { controller, persistSpy } = makeController({
      ping: async () => ({ ok: false, scopes: [], error: 'bad creds' }),
    });
    await expect(
      controller.connect({ clientId: 'cid', clientSecret: 'nope' }, USER),
    ).rejects.toThrow(/Snov rejected the credentials: bad creds/);
    expect(persistSpy).not.toHaveBeenCalled();
  });
});

describe('SnovConnectController.status', () => {
  it('reports connected with the account status', async () => {
    const { controller } = makeController({ account: { status: 'active' } });
    expect(await controller.status(USER)).toEqual({
      connected: true,
      status: 'active',
    });
  });

  it('reports not connected when no account exists', async () => {
    const { controller } = makeController({ account: null });
    expect(await controller.status(USER)).toEqual({ connected: false });
  });
});
