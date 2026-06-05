import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { DecryptedCredentials, PingResult } from '@getbeyond/shared';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { DeploymentMode } from '../../common/deployment';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import type { CredentialManager } from './credential-manager';
import {
  PdlConnectController,
  type PdlPinger,
} from './pdl-connect.controller';

/**
 * Unit tests for the PDL connect controller. Deps are stubbed (no DI, no
 * network) — we cover validation, key-rejection, persistence, and status.
 * Unlike Apollo, PDL is allowed in every deployment mode (incl. Cloud).
 * Explicit vitest imports — `globals: false`.
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
  mode?: DeploymentMode;
}): {
  controller: PdlConnectController;
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

  const adapter: PdlPinger = {
    ping: opts.ping ?? (async () => ({ ok: true, scopes: [] })),
  };

  return {
    controller: new PdlConnectController(
      prisma,
      credentials,
      adapter,
      opts.mode ?? 'self_host',
    ),
    persistSpy,
    findUniqueSpy,
  };
}

describe('PdlConnectController.connect', () => {
  it('validates the key, persists it, and returns connected', async () => {
    const { controller, persistSpy } = makeController({});
    const res = await controller.connect({ apiKey: 'secret-key' }, USER);

    expect(res).toEqual({ id: 'acct-new', status: 'connected' });
    expect(persistSpy).toHaveBeenCalledWith({
      orgId: 'org-1',
      kind: 'pdl',
      authMode: 'byo_key',
      creds: { apiKey: 'secret-key' },
    });
  });

  it('rejects a missing/blank apiKey with 400 before any vendor call', async () => {
    const ping = vi.fn(async () => ({ ok: true, scopes: [] }));
    const { controller, persistSpy } = makeController({ ping });
    await expect(controller.connect({ apiKey: '' }, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ping).not.toHaveBeenCalled();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('rejects a key PDL refuses, without persisting', async () => {
    const { controller, persistSpy } = makeController({
      ping: async () => ({ ok: false, scopes: [], error: 'bad key' }),
    });
    await expect(
      controller.connect({ apiKey: 'nope' }, USER),
    ).rejects.toThrow(/PDL rejected the API key: bad key/);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('connects on Cloud too (PDL is not self-host-gated)', async () => {
    const { controller, persistSpy } = makeController({ mode: 'cloud' });
    const res = await controller.connect({ apiKey: 'secret-key' }, USER);
    expect(res).toEqual({ id: 'acct-new', status: 'connected' });
    expect(persistSpy).toHaveBeenCalled();
  });
});

describe('PdlConnectController.status', () => {
  it('reports connected with the account status', async () => {
    const { controller } = makeController({ account: { status: 'active' } });
    expect(await controller.status(USER)).toEqual({
      available: true,
      connected: true,
      status: 'active',
    });
  });

  it('reports not connected when no account exists', async () => {
    const { controller } = makeController({ account: null });
    expect(await controller.status(USER)).toEqual({
      available: true,
      connected: false,
    });
  });

  it('reports available on Cloud (no self-host gate)', async () => {
    const { controller } = makeController({ mode: 'cloud', account: null });
    expect(await controller.status(USER)).toEqual({
      available: true,
      connected: false,
    });
  });
});
