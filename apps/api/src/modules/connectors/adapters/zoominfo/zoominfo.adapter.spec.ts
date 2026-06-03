import { describe, expect, it, vi } from 'vitest';
import type {
  DecryptedCredentials,
  NormalizedContact,
  SyncContactsParams,
} from '@getbeyond/shared';
import {
  ZoomInfoSourceAdapter,
  zoominfoSourceAdapter,
  type ZoomInfoClientLike,
  type ZoomInfoSourceConfig,
} from './zoominfo.adapter';
import { ZoomInfoAuthError, ZoomInfoServerError } from './zoominfo.source';

const CREDS: DecryptedCredentials = { clientId: 'cid', clientSecret: 'csec' };

/** A fake ZoomInfoClient: search returns ids per page, enrich returns matches. */
function fakeClient(opts: {
  pages?: Array<Array<{ id: number }>>;
  enrich?: (ids: number[]) => unknown[];
  ping?: { ok: boolean; error?: string };
  searchThrows?: unknown;
}): ZoomInfoClientLike & { searchCalls: () => number; enrichCalls: () => number } {
  let searchCalls = 0;
  let enrichCalls = 0;
  return {
    ping: async () => opts.ping ?? { ok: true },
    searchContacts: async (_attrs, page) => {
      searchCalls += 1;
      if (opts.searchThrows) throw opts.searchThrows;
      const idx = (page?.page ?? 1) - 1;
      return { data: opts.pages?.[idx] ?? [] };
    },
    enrichContacts: async (matches) => {
      enrichCalls += 1;
      const ids = matches.map((m) => m['personId'] as number);
      return { data: opts.enrich ? opts.enrich(ids) : [] };
    },
    searchCalls: () => searchCalls,
    enrichCalls: () => enrichCalls,
  };
}

function match(
  id: number,
  email: string | null,
  matchStatus: string,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    id,
    // Mirrors the live shape: company is nested, no linkedInUrl on the GTM plan.
    attributes: { email, firstName: 'Dana', lastName: 'Reed', jobTitle: 'VP', company: { id: 9, name: 'Acme' }, ...extra },
    meta: { matchStatus },
  };
}

function adapter(client: ZoomInfoClientLike, over: Partial<ConstructorParameters<typeof ZoomInfoSourceAdapter>[0]> = {}) {
  return new ZoomInfoSourceAdapter({ clientFactory: () => client, pageSize: 2, ...over });
}

function syncParams(
  config: ZoomInfoSourceConfig,
  overrides: Partial<SyncContactsParams<ZoomInfoSourceConfig>> = {},
): SyncContactsParams<ZoomInfoSourceConfig> {
  return {
    creds: CREDS,
    config,
    onVendorFailure: vi.fn(async () => {}),
    onVendorSuccess: vi.fn(),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<NormalizedContact>): Promise<NormalizedContact[]> {
  const out: NormalizedContact[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('ZoomInfoSourceAdapter — identity', () => {
  it('declares kind=zoominfo, authMode=byo_key', () => {
    const a = new ZoomInfoSourceAdapter();
    expect(a.kind).toBe('zoominfo');
    expect(a.authMode).toBe('byo_key');
  });
  it('exports a singleton', () => {
    expect(zoominfoSourceAdapter).toBeInstanceOf(ZoomInfoSourceAdapter);
  });
});

describe('ZoomInfoSourceAdapter — ping', () => {
  it('ok when the client validates', async () => {
    const result = await adapter(fakeClient({ ping: { ok: true } })).ping(CREDS);
    expect(result).toEqual({ ok: true, scopes: [] });
  });
  it('not ok (no creds leaked) when rejected', async () => {
    const result = await adapter(fakeClient({ ping: { ok: false, error: 'bad' } })).ping(CREDS);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('csec');
  });
});

describe('ZoomInfoSourceAdapter — credentials', () => {
  it('throws when clientId missing', async () => {
    const iter = adapter(fakeClient({})).syncContacts(
      syncParams({ companyName: 'Acme' }, { creds: { clientSecret: 'x' } }),
    );
    await expect(collect(iter)).rejects.toThrow(/clientId/);
  });
});

describe('ZoomInfoSourceAdapter — syncContacts', () => {
  it('searches by company, enriches personIds, and maps matches to contacts', async () => {
    const client = fakeClient({
      pages: [[{ id: 1 }, { id: 2 }]],
      enrich: (ids) =>
        ids.map((id) => match(id, `p${id}@acme.com`, id === 1 ? 'FULL_MATCH' : 'NO_MATCH')),
    });
    const contacts = await collect(
      adapter(client).syncContacts(syncParams({ companyName: 'Acme' })),
    );
    expect(contacts.map((c) => c.emailRaw)).toEqual(['p1@acme.com', 'p2@acme.com']);
    expect(contacts[0]!.emailVerification).toBe('verified'); // FULL_MATCH
    expect(contacts[1]!.emailVerification).toBe('unverified'); // NO_MATCH
    expect(contacts[0]!.title).toBe('VP');
    expect(contacts[0]!.company).toBe('Acme'); // nested attributes.company.name
    expect(contacts[0]!.linkedinUrl).toBeNull(); // not on the GTM plan
    expect(contacts[0]!.externalId).toBe('1');
  });

  it('skips matches with no email', async () => {
    const client = fakeClient({
      pages: [[{ id: 1 }, { id: 2 }]],
      enrich: (ids) => ids.map((id) => match(id, id === 1 ? 'p1@acme.com' : null, 'FULL_MATCH')),
    });
    const contacts = await collect(
      adapter(client).syncContacts(syncParams({ companyName: 'Acme' })),
    );
    expect(contacts.map((c) => c.emailRaw)).toEqual(['p1@acme.com']);
  });

  it('does not search when companyName is blank', async () => {
    const client = fakeClient({ pages: [[{ id: 1 }]] });
    const contacts = await collect(
      adapter(client).syncContacts(syncParams({ companyName: '   ' })),
    );
    expect(contacts).toEqual([]);
    expect(client.searchCalls()).toBe(0);
  });

  it('honours maxContacts', async () => {
    const client = fakeClient({
      pages: [[{ id: 1 }, { id: 2 }]],
      enrich: (ids) => ids.map((id) => match(id, `p${id}@acme.com`, 'FULL_MATCH')),
    });
    const contacts = await collect(
      adapter(client).syncContacts(syncParams({ companyName: 'Acme', maxContacts: 1 })),
    );
    expect(contacts).toHaveLength(1);
  });

  it('paginates until a short page', async () => {
    const client = fakeClient({
      pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }]],
      enrich: (ids) => ids.map((id) => match(id, `p${id}@acme.com`, 'FULL_MATCH')),
    });
    const contacts = await collect(
      adapter(client).syncContacts(syncParams({ companyName: 'Acme' })),
    );
    expect(contacts).toHaveLength(3);
    expect(client.searchCalls()).toBe(2); // page 1 (full) then page 2 (short → stop)
  });

  it('reports auth_invalid to the breaker on a ZoomInfoAuthError', async () => {
    const client = fakeClient({ searchThrows: new ZoomInfoAuthError('401') });
    const onVendorFailure = vi.fn(async () => {});
    const iter = adapter(client).syncContacts(
      syncParams({ companyName: 'Acme' }, { onVendorFailure }),
    );
    await expect(collect(iter)).rejects.toBeInstanceOf(ZoomInfoAuthError);
    expect(onVendorFailure).toHaveBeenCalledWith('auth_invalid');
  });

  it('reports server_5xx to the breaker on a ZoomInfoServerError', async () => {
    const client = fakeClient({ searchThrows: new ZoomInfoServerError('502') });
    const onVendorFailure = vi.fn(async () => {});
    const iter = adapter(client).syncContacts(
      syncParams({ companyName: 'Acme' }, { onVendorFailure }),
    );
    await expect(collect(iter)).rejects.toBeInstanceOf(ZoomInfoServerError);
    expect(onVendorFailure).toHaveBeenCalledWith('server_5xx');
  });
});
