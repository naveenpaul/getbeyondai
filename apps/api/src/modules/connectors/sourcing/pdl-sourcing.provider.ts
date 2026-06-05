import {
  PdlAuthError,
  PdlInsufficientCreditsError,
  type PdlCompanySearchParams,
  type PdlCompanySearchResponse,
} from '../adapters/pdl/pdl.source';
import { SourcingUnavailableError } from './sourcing-provider';
import type {
  CandidateCompany,
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';
import type { VendorHealthReporter } from './apollo-sourcing.provider';
import { canonicalCity, canonicalCountry } from './geo';

/**
 * Live company-discovery sourcing provider backed by PDL's Company Search.
 *
 * PDL's data is global with native city-level geo (verified live 2026-06-05:
 * Bengaluru, London, Berlin all return results) — so this is the source we reach
 * for on non-US/Canada and city-scoped goals, where ZoomInfo's US/Canada-only
 * geo filters can't help. The brain derives an ICP; this translates it into a
 * PDL Elasticsearch query and returns matching *companies* for the orchestrator
 * to qualify + rank. The Researcher then derives + cites what PDL lacks (funding
 * stage precision, etc.) from the web.
 *
 * Boundary: lives in the connectors layer and talks to the quarantined PDL
 * adapter (vendor HTTP in `adapters/pdl/`, invariant #5). Bound per run with the
 * org's decrypted creds + the ConnectorAccount id (for breaker reporting).
 *
 * Cost: PDL Company Search bills one credit per returned record, so a run spends
 * ~`limit` credits — far below the per-prospect qualification LLM cost, but real.
 */

/** Companies pulled per search. PDL caps `size` at 100; our candidate limit is lower. */
const MAX_SIZE = 100;
const DEFAULT_LIMIT = 25;

/** The slice of the PDL adapter this provider drives (eases test injection). */
export interface PdlCompanySearcher {
  searchCompanies(
    params: PdlCompanySearchParams,
  ): Promise<PdlCompanySearchResponse>;
}

/**
 * PDL company-size buckets (the `size` field's discrete values), each with the
 * numeric headcount range it covers. Verified against live data (2026-06-05).
 */
const PDL_SIZE_BUCKETS: ReadonlyArray<{ token: string; lo: number; hi: number }> = [
  { token: '1-10', lo: 1, hi: 10 },
  { token: '11-50', lo: 11, hi: 50 },
  { token: '51-200', lo: 51, hi: 200 },
  { token: '201-500', lo: 201, hi: 500 },
  { token: '501-1000', lo: 501, hi: 1000 },
  { token: '1001-5000', lo: 1001, hi: 5000 },
  { token: '5001-10000', lo: 5001, hi: 10000 },
  { token: '10001+', lo: 10001, hi: Number.POSITIVE_INFINITY },
];

/**
 * Map an ICP headcount range to the PDL `size` buckets it overlaps. Pure. An
 * absent bound is open-ended. We filter on `size` (not `employee_count`) because
 * far more PDL records carry a size bucket than an exact count — higher recall.
 */
export function pdlSizeBuckets(min: number | null, max: number | null): string[] {
  const lo = min ?? 0;
  const hi = max ?? Number.POSITIVE_INFINITY;
  return PDL_SIZE_BUCKETS.filter((b) => b.hi >= lo && b.lo <= hi).map(
    (b) => b.token,
  );
}

/**
 * Map common ICP industry/keyword terms onto PDL's controlled `industry`
 * vocabulary (verified values, 2026-06-05). The ICP is free-form ("IT",
 * "fintech"); PDL's `industry` is a fixed taxonomy, so we translate. Unmapped
 * terms (e.g. "startup") are dropped from the PDL filter — the search stays
 * broad and the scorer refines, rather than over-filtering to zero.
 */
const INDUSTRY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  it: ['information technology and services', 'computer software', 'internet', 'information services'],
  'information technology': ['information technology and services', 'information services'],
  technology: ['information technology and services', 'computer software', 'internet'],
  tech: ['information technology and services', 'computer software', 'internet'],
  software: ['computer software', 'information technology and services'],
  saas: ['computer software', 'internet'],
  internet: ['internet', 'computer software'],
  web: ['internet', 'computer software'],
  ai: ['computer software', 'internet'],
  'artificial intelligence': ['computer software', 'internet'],
  'machine learning': ['computer software', 'internet'],
  cybersecurity: ['computer & network security', 'information technology and services'],
  security: ['computer & network security', 'information technology and services'],
  fintech: ['financial services', 'computer software'],
  'financial technology': ['financial services', 'computer software'],
  finance: ['financial services', 'banking'],
  banking: ['banking', 'financial services'],
  healthtech: ['hospital & health care', 'health, wellness and fitness'],
  healthcare: ['hospital & health care', 'health, wellness and fitness'],
  health: ['hospital & health care', 'health, wellness and fitness'],
  edtech: ['e-learning', 'education management'],
  education: ['education management', 'e-learning'],
  marketing: ['marketing and advertising', 'internet'],
  adtech: ['marketing and advertising', 'internet'],
  ecommerce: ['retail', 'internet'],
  'e-commerce': ['retail', 'internet'],
  retail: ['retail', 'internet'],
  telecom: ['telecommunications'],
  telecommunications: ['telecommunications'],
};

/** Resolve ICP terms to the deduped set of PDL `industry` values they imply. Pure. */
export function pdlIndustriesFor(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const term of terms) {
    const mapped = INDUSTRY_SYNONYMS[term.trim().toLowerCase()];
    if (!mapped) continue;
    for (const industry of mapped) {
      if (!out.includes(industry)) out.push(industry);
    }
  }
  return out;
}

/**
 * Map the provider-agnostic ICP to a PDL Company Search Elasticsearch query. Pure.
 *
 *   - countries → `location.country` (lowercased); cities → `location.locality`
 *     (alias-normalized, e.g. Bengaluru→bangalore) — PDL filters both globally.
 *   - industries + keywords → an OR over mapped PDL `industry` values.
 *   - headcount → `size` buckets.
 * An empty ICP yields `match_all` (a broad search the qualify+rank step filters).
 * fundingStages are NOT mapped — PDL company data has no reliable funding stage;
 * the Researcher derives + cites it.
 */
export function icpToPdlSearchQuery(icp: IcpCriteria): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [];

  const countries: string[] = [];
  const cities: string[] = [];
  for (const loc of icp.locations) {
    const country = canonicalCountry(loc);
    if (country) {
      const lower = country.toLowerCase();
      if (!countries.includes(lower)) countries.push(lower);
    } else {
      const city = canonicalCity(loc);
      if (city && !cities.includes(city)) cities.push(city);
    }
  }
  if (countries.length) must.push({ terms: { 'location.country': countries } });
  if (cities.length) must.push({ terms: { 'location.locality': cities } });

  const industries = pdlIndustriesFor([...icp.industries, ...icp.keywords]);
  if (industries.length) {
    must.push({
      bool: { should: industries.map((i) => ({ term: { industry: i } })) },
    });
  }

  if (icp.employeeCountMin !== null || icp.employeeCountMax !== null) {
    const sizes = pdlSizeBuckets(icp.employeeCountMin, icp.employeeCountMax);
    if (sizes.length) must.push({ terms: { size: sizes } });
  }

  return must.length ? { bool: { must } } : { match_all: {} };
}

export class PdlSourcingProvider implements SourcingProvider {
  readonly name = 'pdl';

  private readonly searcher: PdlCompanySearcher;
  private readonly creds: PdlCompanySearchParams['creds'];
  private readonly accountId: string;
  private readonly health: VendorHealthReporter;

  constructor(
    searcher: PdlCompanySearcher,
    creds: PdlCompanySearchParams['creds'],
    accountId: string,
    health: VendorHealthReporter,
  ) {
    this.searcher = searcher;
    this.creds = creds;
    this.accountId = accountId;
    this.health = health;
  }

  async findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const query = icpToPdlSearchQuery(icp);

    let result: PdlCompanySearchResponse;
    try {
      result = await this.searcher.searchCompanies({
        creds: this.creds,
        query,
        size: Math.min(limit, MAX_SIZE),
        onVendorFailure: (kind) =>
          this.health.reportVendorFailure(this.accountId, kind),
        onVendorSuccess: () => this.health.reportVendorSuccess(this.accountId),
      });
    } catch (err) {
      // User-fixable problems → graceful path (the orchestrator surfaces the
      // message + completes with the ICP shown). Other errors bubble for retry.
      if (err instanceof PdlAuthError) {
        throw new SourcingUnavailableError(
          'PDL rejected the API key — reconnect PDL to keep discovering companies.',
        );
      }
      if (err instanceof PdlInsufficientCreditsError) {
        throw new SourcingUnavailableError(
          'PDL is out of search credits — top up PDL to keep discovering companies.',
        );
      }
      throw err;
    }

    // Dedupe by domain (falling back to name).
    const byKey = new Map<string, CandidateCompany>();
    for (const record of result.records) {
      const candidate = toCandidate(record);
      if (!candidate) continue;
      const key = (candidate.domain ?? candidate.name).toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, candidate);
      if (byKey.size >= limit) break;
    }

    const candidates = [...byKey.values()];
    return { candidates, summary: buildSummary(candidates.length, result.total) };
  }
}

/**
 * Down-convert one PDL company record to a vendor-neutral `CandidateCompany`, or
 * null when it has no usable name. The full record is kept in `raw` so the
 * Researcher can draw on anything we didn't model (industry, location, tags).
 */
export function toCandidate(
  record: Record<string, unknown>,
): CandidateCompany | null {
  const name = firstString(record, ['display_name', 'name']);
  if (!name) return null;
  return {
    name,
    domain: toDomain(firstString(record, ['website'])),
    linkedinUrl: normalizeLinkedin(firstString(record, ['linkedin_url'])),
    employeeCount:
      typeof record['employee_count'] === 'number'
        ? (record['employee_count'] as number)
        : null,
    // PDL company search carries no funding stage — the Researcher derives it.
    fundingStage: null,
    raw: record,
  };
}

/** One-line account of the search for the chat tool-call row. */
function buildSummary(count: number, total: number): string {
  if (count === 0) return 'PDL search returned no companies for this ICP';
  const noun = count === 1 ? 'company' : 'companies';
  const of = total > count ? ` (of ${total.toLocaleString('en-US')})` : '';
  return `PDL: ${count} ${noun} matching your ICP${of}`;
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

/** Bare hostname from a website (no scheme/www/path), or null. */
function toDomain(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .split('?')[0]!;
  return s.length > 0 ? s : null;
}

/** PDL returns bare linkedin paths; make them absolute. */
function normalizeLinkedin(raw: string | null): string | null {
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
