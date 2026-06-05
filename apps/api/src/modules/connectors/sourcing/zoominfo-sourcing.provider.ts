import {
  ZoomInfoAuthError,
  ZoomInfoBadRequestError,
  ZoomInfoServerError,
  type ZoomInfoCompanySearchAttributes,
  type ZoomInfoDocument,
} from '../adapters/zoominfo/zoominfo.source';
import { SourcingUnavailableError } from './sourcing-provider';
import type {
  CandidateCompany,
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';
import type { VendorHealthReporter } from './apollo-sourcing.provider';
import { canonicalCountry } from './geo';

/**
 * Live company-discovery sourcing provider backed by ZoomInfo's GTM CompanySearch.
 *
 * The brain derives an ICP; this translates it into ZoomInfo CompanySearch
 * attributes and pages back matching *companies* (no contact-credit burn) for the
 * orchestrator to qualify + rank. The Researcher then derives + cites the signals
 * (funding precision, etc.) from the web. Contacts/emails at the qualified
 * companies are a separate step (the Stage 5 waterfall), not this provider.
 *
 * Boundary: lives in the connectors layer and talks to the quarantined
 * `ZoomInfoClient` (vendor SDK lives in `adapters/zoominfo/`, invariant #5). Bound
 * per run with the org's client + the ConnectorAccount id (for breaker reporting).
 *
 * Auth handling: a rejected key (401/403) surfaces as `ZoomInfoAuthError`; we
 * report it to the breaker AND convert it to a `SourcingUnavailableError` so the
 * orchestrator completes gracefully ("reconnect ZoomInfo") with the ICP still
 * shown, instead of hard-failing the search. A `ZoomInfoServerError` (5xx /
 * transport) is reported and rethrown as transient.
 */

/** The slice of ZoomInfoClient this provider drives (eases test injection). */
export interface ZoomInfoCompanySearcher {
  searchCompanies(
    attributes: ZoomInfoCompanySearchAttributes,
    opts?: { page?: number; pageSize?: number },
  ): Promise<ZoomInfoDocument>;
}

/** Companies fetched per CompanySearch page. */
const DEFAULT_PAGE_SIZE = 25;
/** Hard page ceiling — guards an unbounded paging loop. */
const DEFAULT_MAX_PAGES = 40;

/**
 * ZoomInfo's discrete employee-count buckets, in ascending order, with the
 * numeric range each covers. Verified against the live GTM Data API
 * (2026-06-04): `employeeCount` must be a comma-delimited string of these exact
 * tokens — a number / object / "min-max" range is rejected.
 */
const EMPLOYEE_BUCKETS: ReadonlyArray<{ token: string; lo: number; hi: number }> = [
  { token: '1to4', lo: 1, hi: 4 },
  { token: '5to9', lo: 5, hi: 9 },
  { token: '10to19', lo: 10, hi: 19 },
  { token: '20to49', lo: 20, hi: 49 },
  { token: '50to99', lo: 50, hi: 99 },
  { token: '100to249', lo: 100, hi: 249 },
  { token: '250to499', lo: 250, hi: 499 },
  { token: '500to999', lo: 500, hi: 999 },
  { token: '1000to4999', lo: 1000, hi: 4999 },
  { token: '5000to9999', lo: 5000, hi: 9999 },
  { token: '10000plus', lo: 10000, hi: Number.POSITIVE_INFINITY },
];

/**
 * Map an ICP headcount range to the ZoomInfo buckets it overlaps. Pure. An
 * absent bound is open-ended (`min ?? 0`, `max ?? ∞`), so e.g. max=200 →
 * everything up to and including the 100to249 bucket.
 */
export function employeeCountBuckets(
  min: number | null,
  max: number | null,
): string[] {
  const lo = min ?? 0;
  const hi = max ?? Number.POSITIVE_INFINITY;
  return EMPLOYEE_BUCKETS.filter((b) => b.hi >= lo && b.lo <= hi).map(
    (b) => b.token,
  );
}

/**
 * Map the provider-agnostic ICP to ZoomInfo CompanySearch attributes. Pure.
 *
 * Field names + formats VERIFIED against the live GTM Data API (2026-06-04):
 *   - `country`            — comma-delimited string of country names ONLY. ICP
 *                            `locations` are free-form (the model emits cities,
 *                            states, or countries), but this attribute 400s on a
 *                            non-country value — so we send only the locations we
 *                            recognize as countries and fold the rest (cities,
 *                            regions) into `companyDescription`.
 *   - `companyDescription` — free-text; we fold ICP keywords + industries + any
 *                            non-country locations here (the plan exposes no
 *                            industry-name or city filter, so a description
 *                            keyword search is the pragmatic, working substitute;
 *                            precise location filtering happens at qualify+score).
 *   - `employeeCount`      — comma-delimited bucket tokens (see EMPLOYEE_BUCKETS).
 * Only attributes for ICP fields that are set are emitted, so an empty ICP yields
 * a broad (all-companies) search and the qualify+rank step does the fine filtering.
 * fundingStages are NOT mapped — ZoomInfo CompanySearch has no funding filter on
 * this plan; the Researcher derives + cites funding downstream.
 */
export function icpToZoomInfoCompanyCriteria(
  icp: IcpCriteria,
): ZoomInfoCompanySearchAttributes {
  const attrs: ZoomInfoCompanySearchAttributes = {};

  // Only filter by headcount when the ICP actually constrains it — an
  // unconstrained range would emit every bucket (a no-op filter), so we omit it.
  if (icp.employeeCountMin !== null || icp.employeeCountMax !== null) {
    const buckets = employeeCountBuckets(
      icp.employeeCountMin,
      icp.employeeCountMax,
    );
    if (buckets.length) attrs['employeeCount'] = buckets.join(',');
  }

  // Partition locations: countries → the validated `country` filter; everything
  // else (cities/states/regions) → the free-text description, so a value like
  // "Bengaluru" can never 400 the search.
  const countries: string[] = [];
  const otherLocations: string[] = [];
  for (const loc of icp.locations) {
    const canonical = canonicalCountry(loc);
    if (canonical) {
      if (!countries.includes(canonical)) countries.push(canonical);
    } else if (loc.trim().length > 0) {
      otherLocations.push(loc.trim());
    }
  }
  if (countries.length) attrs['country'] = countries.join(',');

  const description = [...icp.keywords, ...icp.industries, ...otherLocations]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (description.length) attrs['companyDescription'] = description.join(' ');

  return attrs;
}

export class ZoomInfoSourcingProvider implements SourcingProvider {
  readonly name = 'zoominfo';

  private readonly searcher: ZoomInfoCompanySearcher;
  private readonly accountId: string;
  private readonly health: VendorHealthReporter;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    searcher: ZoomInfoCompanySearcher,
    accountId: string,
    health: VendorHealthReporter,
    opts: { pageSize?: number; maxPages?: number } = {},
  ) {
    this.searcher = searcher;
    this.accountId = accountId;
    this.health = health;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    const limit = opts?.limit;
    const attributes = icpToZoomInfoCompanyCriteria(icp);

    // Dedupe by domain (falling back to name) so a company appearing on multiple
    // pages becomes one candidate.
    const byKey = new Map<string, CandidateCompany>();

    for (let page = 1; page <= this.maxPages; page++) {
      let doc: ZoomInfoDocument;
      try {
        doc = await this.searcher.searchCompanies(attributes, {
          page,
          pageSize: this.pageSize,
        });
        this.health.reportVendorSuccess(this.accountId);
      } catch (err) {
        if (err instanceof ZoomInfoAuthError) {
          await this.health.reportVendorFailure(this.accountId, 'auth_invalid');
          // User-fixable, not a run fault → graceful path.
          throw new SourcingUnavailableError(
            'ZoomInfo rejected the credentials — reconnect ZoomInfo to keep discovering companies.',
          );
        }
        if (err instanceof ZoomInfoBadRequestError) {
          // Bad criteria — retrying is pointless. Complete gracefully (ICP still
          // shown) instead of failing the run with a raw vendor error. This
          // commonly means a location ZoomInfo couldn't filter on (e.g. a city);
          // qualify+score or a city-friendly source like Apollo handles those.
          throw new SourcingUnavailableError(
            "ZoomInfo couldn't run this search — its company search filters by country, not city/region. Try a country-level location, or use Apollo for finer targeting.",
          );
        }
        if (err instanceof ZoomInfoServerError) {
          await this.health.reportVendorFailure(this.accountId, 'server_5xx');
        }
        throw err;
      }

      const rows = asArray(doc.data);
      if (rows.length === 0) break;

      for (const row of rows) {
        const candidate = toCandidate(row);
        if (!candidate) continue;
        const key = (candidate.domain ?? candidate.name).toLowerCase();
        if (byKey.has(key)) continue;
        byKey.set(key, candidate);
        if (limit !== undefined && byKey.size >= limit) break;
      }

      if (limit !== undefined && byKey.size >= limit) break;
      // A short page means we've exhausted the result set.
      if (rows.length < this.pageSize) break;
    }

    const candidates = [...byKey.values()];
    return { candidates, summary: buildSummary(candidates.length) };
  }
}

/**
 * Down-convert one ZoomInfo CompanySearch JSON:API resource to a vendor-neutral
 * `CandidateCompany`, or null when it has no usable company name (the orchestrator
 * + Stage 5 key on name). Field access is defensive across the likely attribute
 * names — the exact ones vary by ZoomInfo plan, and the full resource is kept in
 * `raw` so the Researcher can draw on anything we didn't model.
 */
export function toCandidate(resource: unknown): CandidateCompany | null {
  if (!resource || typeof resource !== 'object') return null;
  const obj = resource as Record<string, unknown>;
  const attrs = (obj['attributes'] as Record<string, unknown> | undefined) ?? {};

  const name = firstString(attrs, ['name', 'companyName', 'company_name']);
  if (!name) return null;

  const websiteRaw = firstString(attrs, [
    'website',
    'companyWebsite',
    'domain',
    'companyDomain',
    'url',
  ]);
  const linkedinUrl = firstString(attrs, ['linkedInUrl', 'linkedinUrl']);

  return {
    name,
    domain: toDomain(websiteRaw),
    linkedinUrl: linkedinUrl ?? null,
    employeeCount: firstNumber(attrs, [
      'employeeCount',
      'employees',
      'companyEmployeeCount',
    ]),
    fundingStage: firstString(attrs, [
      'fundingStage',
      'latestFundingType',
      'companyFundingStage',
    ]),
    raw: obj,
  };
}

/** One-line account of the search for the chat tool-call row. */
function buildSummary(count: number): string {
  if (count === 0) return 'ZoomInfo search returned no companies for this ICP';
  const noun = count === 1 ? 'company' : 'companies';
  return `ZoomInfo: ${count} ${noun} matching your ICP`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** First non-blank string among `keys` in `obj`, or null. */
function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

/** First finite number among `keys` in `obj`, or null. Coerces numeric strings. */
function firstNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Normalize a website/URL to a bare hostname (no protocol, no `www.`, no path),
 * or null. `"https://www.Acme.com/about"` → `"acme.com"`.
 */
export function toDomain(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s === '') return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  return s.length > 0 ? s : null;
}
