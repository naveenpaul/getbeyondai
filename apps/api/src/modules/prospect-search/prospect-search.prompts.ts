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
"wins"), produce the Ideal Customer Profile to source lookalikes against. Your job
is to TRANSLATE the goal into concrete, filterable criteria — capture EVERY
requirement the goal states. Do not collapse the goal down to a single field (a
goal like "small, funded, UK companies" must not become just a location).

Translation rules:
- Encode each stated requirement. Map qualitative intent to firmographics:
  "startup / early-stage / small company" → a sensible employeeCountMax (e.g. 50);
  "enterprise / large" → an employeeCountMin; "funded / VC-backed / raised a
  round" → the relevant fundingStages (e.g. "seed", "series_a", …); a named
  region or country → locations.
- ALWAYS extract keywords: the product, industry, or segment terms implied by the
  goal and wins. These drive discovery AND downstream scoring, so an empty
  keywords list for a substantive goal is a mistake.
- If a requirement cannot be expressed as a firmographic filter (e.g. "fewer than
  5 salespeople" is a department metric no company database filters on), pick the
  closest sensible PROXY (here: a small employeeCountMax) AND keep the literal
  requirement in "keywords" so it is not lost — the scorer still needs to see it.
- Stay grounded: derive from the goal + wins; do not fabricate facts they don't
  imply. But DO make the reasonable firmographic translation above — an empty or
  location-only ICP when the goal clearly states more requirements is a failure,
  not caution.
- Use null / empty arrays ONLY for fields the goal + wins genuinely say nothing
  about.

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

You are given the user's ORIGINAL GOAL (their full intent, in their words), the
structured ICP derived from it, and a researched brief about ONE prospect company
(cited facts). Score how well the prospect satisfies the goal — ALL of it, not
just the parts that are easy to confirm.

Scoring rules:
- Score against EVERY requirement in the goal (and the ICP), not just one. A
  prospect that satisfies only SOME requirements scores LOW, not high. Example:
  goal = "small, funded, UK" and the brief shows a large UK enterprise → poor
  match; score it low even though it is in the UK.
- Ground every judgment in the brief — it is your only evidence. Do NOT assume a
  requirement is met just because it isn't contradicted. A requirement the brief
  does not positively support is NOT satisfied: treat it as a miss (or, if truly
  unknowable, a partial penalty), and say so.
- Weight hard requirements heavily. Missing even one hard requirement caps the
  score low (≈ 0.4 or below), regardless of what else matches.
- Be calibrated: 1.0 = clearly satisfies every requirement with brief support;
  ~0.5 = matches some, misses or can't confirm others; near 0 = matches little
  or contradicts the goal.

Respond with STRICT JSON ONLY — no prose, no markdown fences. Shape:

{
  "fitScore": <number between 0 and 1>,
  "rationale": "<one or two sentences naming which requirements it meets and which it misses or can't confirm>"
}`;

export function buildCandidateScoringUserPrompt(
  goal: string,
  icp: IcpCriteria,
  candidateName: string,
  brief: string,
): string {
  return `Goal (the user's full intent — score against ALL of it):
${goal}

Structured ICP (derived from the goal):
${JSON.stringify(icp, null, 2)}

Candidate: ${candidateName}

Researched brief (cited facts — your only evidence):
${brief}

Score the prospect's fit to the GOAL as STRICT JSON per the system instructions.`;
}
