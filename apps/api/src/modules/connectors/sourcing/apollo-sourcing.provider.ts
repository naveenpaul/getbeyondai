import type {
  ApolloOrganization,
  ApolloOrgSearchCriteria,
  ApolloOrgSearchParams,
} from '../adapters/apollo/apollo.source';
import { SourcingUnavailableError } from './sourcing-provider';
import type {
  CandidateCompany,
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';

/**
 * Live company-discovery sourcing provider backed by Apollo's Organization
 * Search. The brain derives an ICP; this translates it into firmographic
 * criteria and streams matching *companies* (no email-credit burn) for the
 * orchestrator to qualify + rank. The Researcher then derives + cites the
 * signals Apollo can't (funding precision, "pre-revenue", etc.) from the web.
 *
 * Boundary: this lives in the connectors layer and talks to the concrete Apollo
 * adapter (vendor SDK quarantined there, invariant #5). It is bound per run with
 * the org's decrypted creds + the ConnectorAccount id (for breaker reporting).
 */

/** The slice of the Apollo adapter this provider needs (eases testing). */
export interface ApolloOrgSearcher {
  searchOrganizations(
    params: ApolloOrgSearchParams,
  ): AsyncIterable<ApolloOrganization>;
}

/** The slice of CredentialManager used to report vendor health (breaker). */
export interface VendorHealthReporter {
  reportVendorFailure(
    accountId: string,
    kind: 'server_5xx' | 'auth_invalid',
  ): Promise<void>;
  reportVendorSuccess(accountId: string): void;
}

/** Map the provider-agnostic ICP to Apollo Organization Search criteria. Pure. */
export function icpToApolloOrgCriteria(
  icp: IcpCriteria,
): ApolloOrgSearchCriteria {
  const criteria: ApolloOrgSearchCriteria = {};
  if (icp.keywords.length) criteria.keywords = icp.keywords;
  if (icp.industries.length) criteria.industries = icp.industries;
  if (icp.fundingStages.length) criteria.fundingStages = icp.fundingStages;
  if (icp.locations.length) criteria.locations = icp.locations;
  if (icp.employeeCountMin !== null || icp.employeeCountMax !== null) {
    criteria.companyHeadcount = {
      min: icp.employeeCountMin ?? undefined,
      max: icp.employeeCountMax ?? undefined,
    };
  }
  return criteria;
}

export class ApolloSourcingProvider implements SourcingProvider {
  readonly name = 'apollo';

  private readonly adapter: ApolloOrgSearcher;
  private readonly creds: ApolloOrgSearchParams['creds'];
  private readonly accountId: string;
  private readonly health: VendorHealthReporter;

  constructor(
    adapter: ApolloOrgSearcher,
    creds: ApolloOrgSearchParams['creds'],
    accountId: string,
    health: VendorHealthReporter,
  ) {
    this.adapter = adapter;
    this.creds = creds;
    this.accountId = accountId;
    this.health = health;
  }

  async findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    const limit = opts?.limit;
    const criteria = icpToApolloOrgCriteria(icp);

    // Dedupe by domain (falling back to name) so a company appearing twice in
    // Apollo's results becomes one candidate. `maxOrgs` caps raw pulls for cost
    // control; the post-dedupe count may land slightly under `limit`.
    const byKey = new Map<string, CandidateCompany>();
    // Track an auth rejection surfaced via the breaker hook so we can convert a
    // mid-search 401/403 into the graceful "reconnect" path below.
    let authFailed = false;
    try {
      for await (const org of this.adapter.searchOrganizations({
        creds: this.creds,
        config: { search: criteria, maxOrgs: limit },
        onVendorFailure: (kind) => {
          if (kind === 'auth_invalid') authFailed = true;
          return this.health.reportVendorFailure(this.accountId, kind);
        },
        onVendorSuccess: () => this.health.reportVendorSuccess(this.accountId),
      })) {
        const key = (org.domain ?? org.name).toLowerCase();
        if (byKey.has(key)) continue;
        byKey.set(key, {
          name: org.name,
          domain: org.domain,
          linkedinUrl: org.linkedinUrl,
          employeeCount: org.employeeCount,
          fundingStage: org.fundingStage,
          raw: org.raw,
        });
        if (limit !== undefined && byKey.size >= limit) break;
      }
    } catch (err) {
      // A rejected key (401/403) thrown mid-search is user-fixable, not a run
      // fault — map it to the graceful path so the orchestrator surfaces
      // "reconnect Apollo" and completes (ICP still shown) instead of failing
      // the whole search. Other errors (5xx, transport) bubble for pg-boss retry.
      if (authFailed) {
        throw new SourcingUnavailableError(
          'Apollo rejected the API key — reconnect Apollo to keep discovering companies.',
        );
      }
      throw err;
    }

    const candidates = [...byKey.values()];
    return { candidates, summary: buildSummary(candidates.length, criteria) };
  }
}

/** One-line account of the search for the chat tool-call row. */
function buildSummary(count: number, criteria: ApolloOrgSearchCriteria): string {
  if (count === 0) {
    return 'Apollo search returned no companies for this ICP';
  }
  const facets: string[] = [];
  const hc = criteria.companyHeadcount;
  if (hc && (hc.min != null || hc.max != null)) {
    facets.push(`${hc.min ?? 1}-${hc.max ?? '∞'} employees`);
  }
  if (criteria.locations?.length) facets.push(criteria.locations.join('/'));
  const noun = count === 1 ? 'company' : 'companies';
  return (
    `Apollo: ${count} ${noun} matching your ICP` +
    (facets.length ? ` (${facets.join(', ')})` : '')
  );
}
