/**
 * Sourcing abstraction (campaigns / lookalike discovery).
 *
 * A SourcingProvider produces a *candidate pool* of companies for a campaign's
 * orchestrator to qualify + rank against an ICP (derived from the user's wins).
 * It is the seam that keeps the orchestrator vendor-neutral:
 *
 *   - `ContactListSourcingProvider` (no key) — the pool is a ContactList the
 *     user imported (e.g. via CSV). Vendor-free; ships today.
 *   - (later) `ApolloSourcingProvider` / `ZoomInfoSourcingProvider` — translate
 *     the ICP into a firmographic search. The vendor SDK MUST live in
 *     `connectors/adapters/<vendor>/` per architecture invariant #5; this
 *     interface stays vendor-neutral so the orchestrator never imports an SDK.
 *
 * "pre-revenue" and exact headcount are never assumed here: a provider returns
 * whatever firmographics it actually has (structured for Apollo/ZoomInfo, mostly
 * null for a CSV pool), and the orchestrator's Researcher derives + cites the
 * rest from the web.
 */

/** A company surfaced as a candidate to qualify. */
export interface CandidateCompany {
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  /** Structured firmographics when the provider has them; null otherwise. */
  employeeCount: number | null;
  fundingStage: string | null;
  /** Opaque provider payload the qualifier/Researcher may draw on. */
  raw: Record<string, unknown>;
}

/** Provider-agnostic ICP, derived from the wins list + the stated goal. */
export interface IcpCriteria {
  keywords: string[];
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  fundingStages: string[];
  industries: string[];
  locations: string[];
}

export interface SourcingResult {
  candidates: CandidateCompany[];
  /**
   * One-line, human-readable account of what the provider did, surfaced to the
   * chat as a tool-call line (e.g. "Read 240 companies from your 'Q3 prospects'
   * list" or "Apollo search: 50 companies, 1-10 employees, seed stage").
   */
  summary: string;
}

export interface FindCandidatesOptions {
  /** Hard cap on candidates returned. Providers must honor it. */
  limit?: number;
}

/**
 * Thrown by the provider factory when a campaign's configured source can't be
 * used for a benign, user-fixable reason — e.g. the org hasn't connected Apollo,
 * or its key expired / tripped the circuit breaker. The orchestrator treats this
 * as a graceful "no candidates, here's what to do" outcome (it surfaces
 * `userMessage` on the stream and completes the campaign) rather than a hard
 * `campaign_failed`. Genuinely unexpected errors (DB down) must NOT use this —
 * they should bubble so pg-boss retries.
 */
export class SourcingUnavailableError extends Error {
  /** Short, action-oriented message safe to show the end user. */
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'SourcingUnavailableError';
    this.userMessage = userMessage;
  }
}

/** Produces a candidate pool for a campaign. One instance is bound per run. */
export interface SourcingProvider {
  /** Stable identifier surfaced in the connected-tools sidebar + audit log. */
  readonly name: string;
  findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult>;
}
