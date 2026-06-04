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
});

describe('CANDIDATE_SCORING_SYSTEM_PROMPT', () => {
  it('instructs strict scoring against ALL requirements (partial match → low)', () => {
    // Guards the fix for "everything scored 1.0 on location alone".
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/only SOME/i);
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/score.*low/i);
    expect(CANDIDATE_SCORING_SYSTEM_PROMPT).toMatch(/not assume/i);
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
