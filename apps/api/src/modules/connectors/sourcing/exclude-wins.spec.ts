import { describe, expect, it } from 'vitest';
import { excludeWins, type WinKey } from './exclude-wins';
import type { CandidateCompany } from './sourcing-provider';

function candidate(
  name: string,
  domain: string | null = null,
): CandidateCompany {
  return {
    name,
    domain,
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: null,
    raw: {},
  };
}

const WINS: WinKey[] = [
  { name: 'Acme, Inc.', domain: 'https://www.acme.com' },
  { name: 'Globex' }, // name-only win (the common case)
];

describe('excludeWins', () => {
  it('suppresses a candidate matching a win by DOMAIN (despite a different name)', () => {
    const { kept, excluded } = excludeWins(
      [candidate('Acme Corporation', 'acme.com')],
      WINS,
    );
    expect(kept).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it('suppresses a candidate matching a win by NAME when no domain resolved', () => {
    const { kept, excluded } = excludeWins([candidate('GLOBEX', null)], WINS);
    expect(kept).toHaveLength(0);
    expect(excluded.map((c) => c.name)).toEqual(['GLOBEX']);
  });

  it('suppresses on name even when the win was stored with a legal suffix', () => {
    // win "Acme, Inc." → "acme"; candidate "Acme" → "acme" → match.
    const { kept } = excludeWins([candidate('Acme', null)], WINS);
    expect(kept).toHaveLength(0);
  });

  it('keeps a genuinely new company (no name or domain match)', () => {
    const { kept, excluded } = excludeWins(
      [candidate('Initech', 'initech.io')],
      WINS,
    );
    expect(kept.map((c) => c.name)).toEqual(['Initech']);
    expect(excluded).toHaveLength(0);
  });

  it('partitions a mixed batch correctly', () => {
    const { kept, excluded } = excludeWins(
      [
        candidate('Acme', 'acme.com'), // win (both)
        candidate('Initech', 'initech.io'), // new
        candidate('Globex Ltd', null), // win (name)
      ],
      WINS,
    );
    expect(kept.map((c) => c.name)).toEqual(['Initech']);
    expect(excluded.map((c) => c.name)).toEqual(['Acme', 'Globex Ltd']);
  });

  it('does not over-suppress when a win name normalizes to null (punctuation-only)', () => {
    const { kept } = excludeWins([candidate('Initech', 'initech.io')], [
      { name: '—', domain: null },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('returns everything kept for an empty wins set', () => {
    const cands = [candidate('Acme', 'acme.com'), candidate('Globex')];
    const { kept, excluded } = excludeWins(cands, []);
    expect(kept).toHaveLength(2);
    expect(excluded).toHaveLength(0);
  });
});
