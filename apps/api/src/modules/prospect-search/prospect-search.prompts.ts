import type { IcpCriteriaInput } from '@getbeyond/shared';
import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';

/**
 * ProspectSearch orchestrator prompts.
 *
 * Two LLM steps in the prospectSearch pipeline route through `callModel` (invariant
 * #3): ICP derivation from the wins list, and per-prospect fit scoring against
 * that ICP. Both are constrained to emit STRICT JSON so the orchestrator parses
 * a known shape — these are not freeform agent turns. Prompts live in source
 * for the trust positioning (users can read/fork/audit them).
 *
 * These steps are deliberately NOT tool-use loops: ICP synthesis and scoring
 * are single-shot reasoning over already-gathered context (the wins firmographics
 * and the Researcher's cited brief), so a plain `callModel` text turn is the
 * right shape — the fixed pipeline, not a planner.
 */

/** Firmographic seed pulled from one wins-list contact's company. */
export interface WinExample {
  company: string;
  title: string | null;
}

export const ICP_DERIVATION_SYSTEM_PROMPT = `You are getbeyond ai's prospectSearch ICP analyst.

Given a founder's stated goal and a sample of their closed-won accounts (the
"wins"), infer the Ideal Customer Profile the prospectSearch should source lookalikes
against.

Be conservative and concrete. Derive ONLY what the wins + goal actually support;
do not invent firmographics you have no basis for. When you cannot infer a field,
return an empty array or null for it rather than guessing.

Respond with STRICT JSON ONLY — no prose, no markdown fences. Shape:

{
  "summary": "<one-sentence description of the ICP a human can read>",
  "keywords": ["<industry / product / segment keyword>", ...],
  "employeeCountMin": <integer or null>,
  "employeeCountMax": <integer or null>,
  "fundingStages": ["seed", "series_a", ...],
  "industries": ["<industry>", ...],
  "locations": ["<region or country>", ...]
}`;

export function buildIcpDerivationUserPrompt(
  goal: string,
  wins: WinExample[],
  criteria?: IcpCriteriaInput | null,
): string {
  const winLines =
    wins.length === 0
      ? '(no wins-list accounts were available)'
      : wins
          .map(
            (w) =>
              `- ${w.company}${w.title ? ` (contact title: ${w.title})` : ''}`,
          )
          .join('\n');
  return `ProspectSearch goal:
${goal}

Closed-won accounts (the wins to find lookalikes of):
${winLines}
${buildConstraintsBlock(criteria)}
Derive the ICP as STRICT JSON per the system instructions.`;
}

/**
 * Render the user's explicit ICP constraints as a prompt block. These are HARD
 * requirements the model must honor in its summary + must not contradict. The
 * orchestrator ALSO overrides the structured fields deterministically after the
 * model responds (so the actual filter values are exactly what the user asked);
 * surfacing them here keeps the human-readable `summary` consistent with those
 * overrides. Only non-empty fields are listed; an all-empty input yields ''.
 */
function buildConstraintsBlock(criteria?: IcpCriteriaInput | null): string {
  if (!criteria) return '';
  const lines: string[] = [];
  if (criteria.industries?.length) {
    lines.push(`- Industries: ${criteria.industries.join(', ')}`);
  }
  if (criteria.keywords?.length) {
    lines.push(`- Keywords: ${criteria.keywords.join(', ')}`);
  }
  if (criteria.fundingStages?.length) {
    lines.push(`- Funding stages: ${criteria.fundingStages.join(', ')}`);
  }
  if (criteria.locations?.length) {
    lines.push(`- Locations: ${criteria.locations.join(', ')}`);
  }
  const min = criteria.employeeCountMin;
  const max = criteria.employeeCountMax;
  if (min != null || max != null) {
    const lo = min != null ? `${min}` : 'any';
    const hi = max != null ? `${max}` : 'any';
    lines.push(`- Employee count: ${lo}–${hi}`);
  }
  if (lines.length === 0) return '';
  return `
The user has specified these HARD ICP constraints — honor them in your summary
and do not contradict them:
${lines.join('\n')}
`;
}

export const CANDIDATE_SCORING_SYSTEM_PROMPT = `You are getbeyond ai's prospectSearch fit scorer.

Given the prospectSearch's Ideal Customer Profile (ICP) and a researched brief about a
single prospect company (with cited facts), score how well the prospect matches
the ICP and explain why in one or two sentences.

Ground your reasoning in the brief. Do not invent facts the brief does not state.
A prospect the brief barely supports should score low, not high.

Respond with STRICT JSON ONLY — no prose, no markdown fences. Shape:

{
  "fitScore": <number between 0 and 1>,
  "rationale": "<one or two sentence why-it-matches>"
}`;

export function buildCandidateScoringUserPrompt(
  icp: IcpCriteria,
  candidateName: string,
  brief: string,
): string {
  return `ICP:
${JSON.stringify(icp, null, 2)}

Candidate: ${candidateName}

Researched brief (cited facts):
${brief}

Score the prospect's fit to the ICP as STRICT JSON per the system instructions.`;
}
