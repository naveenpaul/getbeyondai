import type { CandidateCompany } from '../sourcing/sourcing-provider';

/**
 * Company-enrichment abstraction (prospect searches, Stage 2.5).
 *
 * A CompanyEnrichmentProvider backfills the firmographic skeleton of a sourced
 * `CandidateCompany` *before* qualification — so the Researcher gets a real
 * domain to search and the fit-scorer gets real headcount/firmographics instead
 * of scraped guesses. It is the seam that keeps the orchestrator vendor-neutral:
 *
 *   - `PdlEnrichmentProvider` (BYO key) — resolves the company by identity via
 *     People Data Labs and fills the nulls a CSV/ContactList pool leaves behind.
 *   - (later) other enrichment vendors implement the same one-method interface.
 *
 * Enrichment is an *enhancement*, never a gate: it fills `null` fields only and
 * never overwrites what the sourcing provider already returned (the source is
 * authoritative for what it filtered on). The orchestrator runs it best-effort —
 * a provider fault degrades to "no enrichment", never a failed search. The
 * vendor SDK MUST live in `connectors/adapters/<vendor>/` per invariant #5; this
 * interface stays vendor-neutral so the orchestrator never imports an SDK.
 */

/** A patch of resolved firmographics. Only present, non-null fields are applied. */
export interface CompanyEnrichmentPatch {
  domain?: string | null;
  linkedinUrl?: string | null;
  employeeCount?: number | null;
  fundingStage?: string | null;
  /**
   * Extra provenance (the full vendor record + signals like industry/location)
   * to fold into the candidate's `raw`, keyed by vendor so it can't collide with
   * the sourcing provider's own payload. The Researcher may draw on it.
   */
  raw?: Record<string, unknown>;
}

/** Backfills a sourced candidate's firmographics. One instance is bound per run. */
export interface CompanyEnrichmentProvider {
  /** Stable identifier surfaced in the connected-tools sidebar + audit log. */
  readonly name: string;
  enrich(company: CandidateCompany): Promise<CandidateCompany>;
}

/**
 * Apply an enrichment patch to a candidate, filling NULL fields only. Pure.
 *
 * The sourcing provider is authoritative for every field it returned — Apollo's
 * `employeeCount` is a filtered fact, not a guess — so enrichment never
 * overwrites a non-null value; it only fills the blanks (the CSV/ContactList
 * case). `raw` is shallow-merged so vendor-namespaced provenance accumulates.
 */
export function mergeEnrichment(
  base: CandidateCompany,
  patch: CompanyEnrichmentPatch,
): CandidateCompany {
  return {
    ...base,
    domain: base.domain ?? patch.domain ?? null,
    linkedinUrl: base.linkedinUrl ?? patch.linkedinUrl ?? null,
    employeeCount: base.employeeCount ?? patch.employeeCount ?? null,
    fundingStage: base.fundingStage ?? patch.fundingStage ?? null,
    raw: patch.raw ? { ...base.raw, ...patch.raw } : base.raw,
  };
}
