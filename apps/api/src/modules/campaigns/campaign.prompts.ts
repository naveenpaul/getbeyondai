import type { IcpCriteria } from '../connectors/sourcing/sourcing-provider';

/**
 * Campaign orchestrator prompts.
 *
 * Two LLM steps in the campaign pipeline route through `callModel` (invariant
 * #3): ICP derivation from the wins list, and per-candidate fit scoring against
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

export const ICP_DERIVATION_SYSTEM_PROMPT = `You are getbeyond ai's campaign ICP analyst.

Given a founder's stated goal and a sample of their closed-won accounts (the
"wins"), infer the Ideal Customer Profile the campaign should source lookalikes
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
  return `Campaign goal:
${goal}

Closed-won accounts (the wins to find lookalikes of):
${winLines}

Derive the ICP as STRICT JSON per the system instructions.`;
}

export const CANDIDATE_SCORING_SYSTEM_PROMPT = `You are getbeyond ai's campaign fit scorer.

Given the campaign's Ideal Customer Profile (ICP) and a researched brief about a
single candidate company (with cited facts), score how well the candidate matches
the ICP and explain why in one or two sentences.

Ground your reasoning in the brief. Do not invent facts the brief does not state.
A candidate the brief barely supports should score low, not high.

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

Score the candidate's fit to the ICP as STRICT JSON per the system instructions.`;
}
