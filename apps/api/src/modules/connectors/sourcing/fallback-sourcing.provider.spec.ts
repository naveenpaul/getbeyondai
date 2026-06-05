import { describe, expect, it, vi } from 'vitest';
import { FallbackSourcingProvider } from './fallback-sourcing.provider';
import {
  SourcingUnavailableError,
  type CandidateCompany,
  type IcpCriteria,
  type SourcingProvider,
  type SourcingResult,
} from './sourcing-provider';

const ICP: IcpCriteria = {
  keywords: [],
  employeeCountMin: null,
  employeeCountMax: null,
  fundingStages: [],
  industries: [],
  locations: [],
};

function candidate(name: string): CandidateCompany {
  return {
    name,
    domain: null,
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: null,
    raw: {},
  };
}

/** A successful search that FOUND companies. */
function result(name: string): SourcingResult {
  return { candidates: [candidate(name)], summary: `${name}: ok` };
}

/** A successful search that found NOTHING (a valid "no matches" answer). */
function emptyResult(name: string): SourcingResult {
  return { candidates: [], summary: `${name}: no matches` };
}

/** A provider whose findCandidates does `impl`. */
function provider(name: string, impl: () => Promise<SourcingResult>): SourcingProvider {
  return { name, findCandidates: vi.fn(impl) };
}

describe('FallbackSourcingProvider', () => {
  it('throws if constructed with no providers', () => {
    expect(() => new FallbackSourcingProvider([])).toThrow(/at least one/);
  });

  it('exposes the primary provider name + the ordered list', () => {
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => result('pdl')),
      provider('apollo', async () => result('apollo')),
    ]);
    expect(fb.name).toBe('pdl');
    expect(fb.providers).toHaveLength(2);
  });

  it('uses the first provider that FINDS companies (no fall-through)', async () => {
    const apollo = provider('apollo', async () => result('apollo'));
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => result('pdl')),
      apollo,
    ]);
    const res = await fb.findCandidates(ICP);
    expect(res.summary).toBe('pdl: ok');
    expect(apollo.findCandidates).not.toHaveBeenCalled();
  });

  it('falls through to the next provider on a SourcingUnavailableError (the PDL-out-of-credits case)', async () => {
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => {
        throw new SourcingUnavailableError('PDL is out of search credits — top up PDL.');
      }),
      provider('apollo', async () => result('apollo')),
    ]);
    const res = await fb.findCandidates(ICP);
    expect(res.summary).toBe('apollo: ok');
  });

  it('falls through on an EMPTY result and returns the next provider that finds companies', async () => {
    const apollo = provider('apollo', async () => result('apollo'));
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => emptyResult('pdl')),
      apollo,
    ]);
    const res = await fb.findCandidates(ICP);
    expect(res.summary).toBe('apollo: ok');
    expect(apollo.findCandidates).toHaveBeenCalledOnce();
  });

  it('returns the first empty result when EVERY provider genuinely found nothing (none unavailable)', async () => {
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => emptyResult('pdl')),
      provider('zoominfo', async () => emptyResult('zoominfo')),
    ]);
    const res = await fb.findCandidates(ICP);
    // A true cross-source "no matches" — surfaced as the primary's empty result,
    // NOT an error (the user has nothing to fix).
    expect(res.candidates).toHaveLength(0);
    expect(res.summary).toBe('pdl: no matches');
  });

  it('surfaces the actionable error when one source is unavailable and the rest find nothing (the reported bug)', async () => {
    // PDL is out of credits (the only city-capable source); ZoomInfo runs but
    // returns nothing for the city goal. The user must NOT see a silent "0
    // results" — they should be told PDL is out of credits so they can fix it.
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => {
        throw new SourcingUnavailableError('PDL is out of search credits — top up PDL.');
      }),
      provider('zoominfo', async () => emptyResult('zoominfo')),
    ]);
    await expect(fb.findCandidates(ICP)).rejects.toThrow(/out of search credits/);
  });

  it('re-throws the LAST actionable error when every provider is unavailable', async () => {
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => {
        throw new SourcingUnavailableError('PDL out of credits.');
      }),
      provider('apollo', async () => {
        throw new SourcingUnavailableError('Reconnect Apollo.');
      }),
    ]);
    await expect(fb.findCandidates(ICP)).rejects.toThrow(/Reconnect Apollo/);
  });

  it('bubbles a non-SourcingUnavailableError immediately (no fall-through, pg-boss retries)', async () => {
    const apollo = provider('apollo', async () => result('apollo'));
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => {
        throw new Error('DB unreachable');
      }),
      apollo,
    ]);
    await expect(fb.findCandidates(ICP)).rejects.toThrow(/DB unreachable/);
    expect(apollo.findCandidates).not.toHaveBeenCalled();
  });
});
