import { describe, expect, it, vi } from 'vitest';
import { FallbackSourcingProvider } from './fallback-sourcing.provider';
import {
  SourcingUnavailableError,
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

function result(name: string): SourcingResult {
  return { candidates: [], summary: `${name}: ok` };
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

  it('uses the first provider when it succeeds (no fall-through)', async () => {
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

  it('treats an empty result as success — does NOT fall through on 0 matches', async () => {
    const zoom = provider('zoominfo', async () => result('zoominfo'));
    const fb = new FallbackSourcingProvider([
      provider('pdl', async () => ({ candidates: [], summary: 'pdl: no matches' })),
      zoom,
    ]);
    const res = await fb.findCandidates(ICP);
    expect(res.summary).toBe('pdl: no matches');
    expect(zoom.findCandidates).not.toHaveBeenCalled();
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
