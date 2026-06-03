import { describe, expect, it } from 'vitest';
import type { ConnectorKind, NormalizedContact } from '@getbeyond/shared';
import {
  WaterfallSourcingService,
  waterfallSourcingService,
  type WaterfallConnector,
} from './waterfall-sourcing.service';

function contact(
  o: Partial<NormalizedContact> & { emailRaw: string },
): NormalizedContact {
  return {
    emailRaw: o.emailRaw,
    externalId: o.externalId ?? o.linkedinUrl ?? o.emailRaw,
    externalUrl: o.linkedinUrl ?? undefined,
    firstName: o.firstName ?? 'First',
    lastName: o.lastName ?? 'Last',
    title: o.title ?? 'Title',
    company: o.company ?? 'Co',
    linkedinUrl: o.linkedinUrl ?? null,
    emailVerification: o.emailVerification,
    rawPayload: o.rawPayload ?? {},
  };
}

/** A fake connector that yields a fixed list (or throws), tracking call count. */
function fake(
  kind: ConnectorKind,
  opts: { yield?: NormalizedContact[]; throw?: boolean; accountId?: string },
): { conn: WaterfallConnector; calls: () => number } {
  let count = 0;
  const conn: WaterfallConnector = {
    kind,
    accountId: opts.accountId ?? `${kind}-acct`,
    async *sourceForDomain() {
      count += 1;
      if (opts.throw) throw new Error('connector down');
      for (const c of opts.yield ?? []) yield c;
    },
  };
  return { conn, calls: () => count };
}

const svc = new WaterfallSourcingService();

describe('WaterfallSourcingService — identity', () => {
  it('exports a shared singleton', () => {
    expect(waterfallSourcingService).toBeInstanceOf(WaterfallSourcingService);
  });
});

describe('WaterfallSourcingService.sourceCompany', () => {
  it('runs connectors in priority order and merges by identity (better email + its provenance wins)', async () => {
    const a = fake('snov', {
      yield: [
        contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'unknown' }),
      ],
    });
    const b = fake('zoominfo', {
      yield: [
        contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'verified' }),
        contact({ emailRaw: 'p2@x.com', linkedinUrl: 'li/p2', emailVerification: 'verified' }),
      ],
    });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'verified',
      contactsPerCompany: 5,
    });
    const byLi = new Map(result.map((s) => [s.contact.linkedinUrl, s]));
    expect(byLi.get('li/p1')!.contact.emailVerification).toBe('verified'); // B upgraded A
    expect(byLi.get('li/p1')!.sourceKind).toBe('zoominfo'); // winning connector's provenance
    expect(byLi.get('li/p2')!.contact.emailVerification).toBe('verified');
    expect(result).toHaveLength(2);
  });

  it('stops early (saves the next connector) once verified cap is met', async () => {
    const a = fake('snov', {
      yield: [
        contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'verified' }),
        contact({ emailRaw: 'p2@x.com', linkedinUrl: 'li/p2', emailVerification: 'verified' }),
      ],
    });
    const b = fake('zoominfo', { yield: [contact({ emailRaw: 'p3@x.com' })] });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'verified',
      contactsPerCompany: 2,
    });
    expect(result).toHaveLength(2);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0); // satisfied by A → B never spent
  });

  it('chases verification: escalates to the next connector when unverified', async () => {
    const a = fake('snov', {
      yield: [contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'unverified' })],
    });
    const b = fake('zoominfo', {
      yield: [contact({ emailRaw: 'p1b@x.com', linkedinUrl: 'li/p1', emailVerification: 'verified' })],
    });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'verified',
      contactsPerCompany: 1,
    });
    expect(b.calls()).toBe(1); // A's unverified didn't satisfy → chased B
    expect(result).toHaveLength(1);
    expect(result[0]!.contact.emailVerification).toBe('verified');
    expect(result[0]!.sourceKind).toBe('zoominfo');
  });

  it('keeps the best unverified contact when no connector verifies (never drops)', async () => {
    const a = fake('snov', {
      yield: [contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'unverified' })],
    });
    const b = fake('zoominfo', {
      yield: [contact({ emailRaw: 'p1b@x.com', linkedinUrl: 'li/p1', emailVerification: 'unknown' })],
    });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'verified',
      contactsPerCompany: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.contact.emailVerification).toBe('unverified'); // unverified(1) > unknown(0)
    expect(result[0]!.sourceKind).toBe('snov');
  });

  it('returns empty when no connector yields a contact', async () => {
    const a = fake('snov', { yield: [] });
    const b = fake('zoominfo', { yield: [] });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {});
    expect(result).toEqual([]);
  });

  it('falls through a connector that throws (circuit-broken/down)', async () => {
    const a = fake('snov', { throw: true });
    const b = fake('zoominfo', {
      yield: [contact({ emailRaw: 'p1@x.com', emailVerification: 'verified' })],
    });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      contactsPerCompany: 5,
    });
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(result).toHaveLength(1);
  });

  it('caps results verified-first', async () => {
    const a = fake('snov', {
      yield: [
        contact({ emailRaw: 'u1@x.com', linkedinUrl: 'li/u1', emailVerification: 'unknown' }),
        contact({ emailRaw: 'v1@x.com', linkedinUrl: 'li/v1', emailVerification: 'verified' }),
        contact({ emailRaw: 'u2@x.com', linkedinUrl: 'li/u2', emailVerification: 'unknown' }),
      ],
    });
    const result = await svc.sourceCompany('x.com', [a.conn], {
      threshold: 'verified',
      contactsPerCompany: 2,
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.contact.emailVerification).toBe('verified'); // verified ranked first
  });

  it('skips a blank domain without calling connectors', async () => {
    const a = fake('snov', { yield: [contact({ emailRaw: 'p1@x.com' })] });
    const result = await svc.sourceCompany('   ', [a.conn], {});
    expect(result).toEqual([]);
    expect(a.calls()).toBe(0);
  });

  it("threshold 'any' stops at the cap regardless of verification", async () => {
    const a = fake('snov', {
      yield: [
        contact({ emailRaw: 'p1@x.com', linkedinUrl: 'li/p1', emailVerification: 'unknown' }),
        contact({ emailRaw: 'p2@x.com', linkedinUrl: 'li/p2', emailVerification: 'unknown' }),
      ],
    });
    const b = fake('zoominfo', { yield: [contact({ emailRaw: 'p3@x.com' })] });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'any',
      contactsPerCompany: 2,
    });
    expect(result).toHaveLength(2);
    expect(b.calls()).toBe(0); // 2 any-emails satisfied the cap → B skipped
  });

  it('merges by email when LinkedIn URL is absent', async () => {
    const a = fake('snov', {
      yield: [contact({ emailRaw: 'dup@x.com', emailVerification: 'unknown' })],
    });
    const b = fake('zoominfo', {
      yield: [contact({ emailRaw: 'dup@x.com', emailVerification: 'verified' })],
    });
    const result = await svc.sourceCompany('x.com', [a.conn, b.conn], {
      threshold: 'verified',
      contactsPerCompany: 5,
    });
    expect(result).toHaveLength(1); // same email → one contact
    expect(result[0]!.contact.emailVerification).toBe('verified');
  });
});
