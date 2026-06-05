import type { DecryptedCredentials } from '@getbeyond/shared';
import type { CandidateCompany } from '../sourcing/sourcing-provider';
import type {
  PdlCompanyEnrichParams,
  PdlCompanyRecord,
} from '../adapters/pdl/pdl.source';
import {
  mergeEnrichment,
  type CompanyEnrichmentProvider,
} from './enrichment-provider';

/**
 * Company-enrichment provider backed by People Data Labs. The orchestrator runs
 * it over the sourced pool before qualification; it resolves each company by
 * identity (name + domain) and fills the firmographic nulls a CSV/ContactList
 * pool leaves behind (domain, linkedin, headcount) — keeping richer PDL signals
 * (industry, location) as provenance in `raw.pdl`. Funding stage is left null:
 * PDL Company Enrichment doesn't carry it, so the Researcher derives + cites it.
 *
 * Boundary: lives in the connectors layer and talks to the concrete PDL adapter
 * (vendor SDK quarantined there, invariant #5). Bound per run with the org's
 * decrypted creds + the ConnectorAccount id (for breaker reporting). It does NOT
 * catch vendor faults — the orchestrator owns the best-effort policy (one throw
 * degrades the whole pass to "no enrichment"), so the provider stays honest.
 */

/** The slice of the PDL adapter this provider needs (eases testing). */
export interface PdlCompanyEnricher {
  enrichCompany(
    params: PdlCompanyEnrichParams,
  ): Promise<PdlCompanyRecord | null>;
}

/** The slice of CredentialManager used to report vendor health (breaker). */
export interface VendorHealthReporter {
  reportVendorFailure(
    accountId: string,
    kind: 'server_5xx' | 'auth_invalid',
  ): Promise<void>;
  reportVendorSuccess(accountId: string): void;
}

export class PdlEnrichmentProvider implements CompanyEnrichmentProvider {
  readonly name = 'pdl';

  private readonly adapter: PdlCompanyEnricher;
  private readonly creds: DecryptedCredentials;
  private readonly accountId: string;
  private readonly health: VendorHealthReporter;

  constructor(
    adapter: PdlCompanyEnricher,
    creds: DecryptedCredentials,
    accountId: string,
    health: VendorHealthReporter,
  ) {
    this.adapter = adapter;
    this.creds = creds;
    this.accountId = accountId;
    this.health = health;
  }

  async enrich(company: CandidateCompany): Promise<CandidateCompany> {
    // Nothing the consumed fields need — skip the (billable) lookup. This is the
    // common case on the Apollo/ZoomInfo path, where the source already returned
    // full firmographics; the CSV/ContactList path (all null) always proceeds.
    if (
      company.domain !== null &&
      company.linkedinUrl !== null &&
      company.employeeCount !== null
    ) {
      return company;
    }

    const record = await this.adapter.enrichCompany({
      creds: this.creds,
      name: company.name,
      domain: company.domain,
      onVendorFailure: (kind) =>
        this.health.reportVendorFailure(this.accountId, kind),
      onVendorSuccess: () => this.health.reportVendorSuccess(this.accountId),
    });
    // No confident match — leave the candidate untouched for the Researcher.
    if (!record) return company;

    return mergeEnrichment(company, {
      domain: record.domain,
      linkedinUrl: record.linkedinUrl,
      employeeCount: record.employeeCount,
      // PDL has no funding-stage field; the Researcher derives + cites it.
      raw: { pdl: record.raw },
    });
  }
}
