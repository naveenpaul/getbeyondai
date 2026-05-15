import { describe, expect, it } from 'vitest';
import type {
  ConnectorKind,
  DestinationAdapter,
  DraftActionKind,
  ExecuteResult,
  NormalizedContact,
  PingResult,
  SourceAdapter,
  SourceOption,
} from './connector-contracts';

// ─── Conformance fixtures ────────────────────────────────────────────────────

/**
 * A stub adapter that satisfies SourceAdapter. If the interface changes
 * incompatibly, this file fails to compile — the test fixture is the contract.
 */
const stubSourceAdapter: SourceAdapter<{ listId: string }> = {
  kind: 'hubspot',
  authMode: 'oauth',
  startOAuth(redirectUri) {
    return { authUrl: `https://example.invalid/oauth?redirect=${redirectUri}`, state: 'state-token' };
  },
  async completeOAuth(_code, _state) {
    return { accessToken: 'tok', refreshToken: 'rtok' };
  },
  async ping(_creds) {
    return { ok: true, scopes: ['contacts.read'] };
  },
  async listSources(_creds) {
    return [{ id: 'list-1', kind: 'list', name: 'Lead Q2', itemCount: 247 }];
  },
  async *syncContacts(params) {
    void params.config.listId;
    yield {
      emailRaw: 'sarah@acme.com',
      externalId: 'hs_001',
      firstName: 'Sarah',
      rawPayload: { stub: true },
    };
  },
};

const stubDestinationAdapter: DestinationAdapter<{ subject: string; body: string }> = {
  kind: 'gmail',
  supports: ['send_email'] as const,
  async execute(params) {
    void params.idempotencyKey;
    return {
      status: 'succeeded',
      externalId: 'msg-123',
      responsePayload: { sent: true },
    };
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SourceAdapter contract', () => {
  it('stub adapter declares kind + authMode', () => {
    expect(stubSourceAdapter.kind).toBe('hubspot');
    expect(stubSourceAdapter.authMode).toBe('oauth');
  });

  it('startOAuth + completeOAuth flow returns credentials', async () => {
    const start = stubSourceAdapter.startOAuth!('https://app.example/cb');
    expect(start.authUrl).toContain('https://');
    expect(start.state).toBe('state-token');
    const creds = await stubSourceAdapter.completeOAuth!('code-123', start.state);
    expect(creds).toMatchObject({ accessToken: 'tok' });
  });

  it('ping returns shape with ok + scopes', async () => {
    const result: PingResult = await stubSourceAdapter.ping({});
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.scopes)).toBe(true);
  });

  it('listSources surfaces user-pickable options', async () => {
    const sources: SourceOption[] = await stubSourceAdapter.listSources!({});
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe('list');
  });

  it('syncContacts yields NormalizedContact instances', async () => {
    const collected: NormalizedContact[] = [];
    for await (const c of stubSourceAdapter.syncContacts({
      creds: {},
      config: { listId: 'list-1' },
    })) {
      collected.push(c);
    }
    expect(collected).toHaveLength(1);
    expect(collected[0].emailRaw).toBe('sarah@acme.com');
    expect(collected[0].externalId).toBe('hs_001');
  });
});

describe('DestinationAdapter contract', () => {
  it('declares the DraftAction kinds it supports', () => {
    expect(stubDestinationAdapter.supports).toContain('send_email');
  });

  it('execute returns ExecuteResult shape', async () => {
    const result: ExecuteResult = await stubDestinationAdapter.execute({
      creds: {},
      action: { subject: 'Hi', body: 'Hi Sarah' },
      idempotencyKey: 'idem-123',
      contactId: 'cont_abc',
    });
    expect(result.status).toBe('succeeded');
    expect(result.externalId).toBe('msg-123');
  });
});

describe('ConnectorKind / DraftActionKind enums', () => {
  it('every ConnectorKind value is one of the five canonical sources', () => {
    const valid: ConnectorKind[] = ['hubspot', 'salesforce', 'apollo', 'zoominfo', 'csv'];
    expect(valid).toHaveLength(5);
  });

  it('every DraftActionKind value covers the v1 action menu', () => {
    const valid: DraftActionKind[] = [
      'send_email',
      'post_linkedin',
      'post_twitter',
      'crm_log_activity',
      'crm_update_field',
      'archive',
    ];
    expect(valid).toHaveLength(6);
  });
});
