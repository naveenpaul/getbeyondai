import { describe, expect, it } from 'vitest';
import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';
import {
  CANDIDATE_SCORING_SYSTEM_PROMPT,
  ICP_DERIVATION_SYSTEM_PROMPT,
  buildCandidateScoringUserPrompt,
} from './prospect-search.prompts';

const ICP: IcpCriteria = {
  keywords: ['fintech'],
  employeeCountMin: null,
  employeeCountMax: 50,
  fundingStages: ['seed'],
  industries: [],
  locations: ['United Kingdom'],
};

describe('buildCandidateScoringUserPrompt', () => {
  it('includes the original goal, the ICP, the candidate, and the brief', () => {
    const prompt = buildCandidateScoringUserPrompt(
      'small funded UK companies',
      ICP,
      'Acme',
      'BRIEF_TEXT_HERE',
    );
    expect(prompt).toContain('small funded UK companies'); // the goal
    expect(prompt).toContain('Acme');
    expect(prompt).toContain('BRIEF_TEXT_HERE');
    expect(prompt).toContain('United Kingdom'); // the serialized ICP
  });

  it('surfaces source-confirmed firmographics as established evidence', () => {
    const prompt = buildCandidateScoringUserPrompt(
      'small funded UK companies',
      ICP,
      'Acme',
      'brief',
      { employeeCount: 8, fundingStage: 'seed' },
    );
    expect(prompt).toMatch(/Known firmographics/i);
    expect(prompt).toContain('Employee count: 8');
    expect(prompt).toContain('Funding stage: seed');
  });

  it('omits the firmographics block when nothing is known', () => {
    expect(
      buildCandidateScoringUserPrompt('g', ICP, 'Acme', 'brief', {
        employeeCount: null,
        fundingStage: null,
      }),
    ).not.toMatch(/Known firmographics/i);
    // ...and when no firmographics arg is passed at all.
    expect(
      buildCandidateScoringUserPrompt('g', ICP, 'Acme', 'brief'),
    ).not.toMatch(/Known firmographics/i);
  });
});

describe('CANDIDATE_SCORING_SYSTEM_PROMPT', () => {
  it('instructs strict scoring against ALL requirements (partial match → low)', () => {
    // Guards the fix for "everything scored 1.0 on location alone".
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/only SOME/i);
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/score.*low/i);
    // whitespace-tolerant: the prompt wraps "do NOT\n assume" across a line.
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/not\s+assume/i);
  });

  it('treats source firmographics as established (so thin briefs do not zero out good matches)', () => {
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/established/i);
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/firmographics/i);
  });
});

describe('ICP_DERIVATION_SYSTEM_PROMPT', () => {
  it('instructs translating intent to filterable proxies + always extracting keywords', () => {
    expect(ICP_DERIVATION_SYSTEM_PROMPT).toMatch(/employeeCountMax/);
    expect(ICP_DERIVATION_SYSTEM_PROMPT).toMatch(/fundingStages/);
    expect(ICP_DERIVATION_SYSTEM_PROMPT).toMatch(/proxy/i);
    expect(ICP_DERIVATION_SYSTEM_PROMPT).toMatch(/keywords/i);
  });
});
