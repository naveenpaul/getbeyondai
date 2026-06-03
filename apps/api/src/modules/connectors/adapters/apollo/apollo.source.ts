import type {
  AuthMode,
  ConnectorKind,
  DecryptedCredentials,
  NormalizedContact,
  PingResult,
  SourceAdapter,
  SyncContactsParams,
} from '@getbeyond/shared';

/**
 * Apollo source adapter (eng-review T8 — Apollo connector).
 *
 * Pulls people from Apollo's People Search API, streaming each as a
 * NormalizedContact. Apollo returns verified/guessed emails directly (unlike
 * the company-centric SourcingProvider path), so this adapter is the
 * "verified contacts" source: a person's `email_status` rides along in
 * `rawPayload` and is persisted as `ContactSource.rawPayload`, giving every
 * imported email an honest provenance without inventing a new column.
 *
 * Trust-chain note: a vendor-asserted email enters as Contact *data* with
 * connector provenance — exactly like a HubSpot contact — NOT as a teammate
 * Claim. Architecture invariant #4 (every Claim cites or abstains) only bites
 * later, when a teammate writes about the contact.
 *
 * Auth: `byo_key`. The user pastes an Apollo API key; the runtime stores it
 * encrypted on `ConnectorAccount` and hands it back decrypted here. There is no
 * OAuth refresh — a 401 means the key is bad, surfaced via
 * `onVendorFailure('auth_invalid')` (no retry can fix it).
 *
 * SDK quarantine (invariant #5): all Apollo HTTP lives in this file. Apollo has
 * no official Node SDK we depend on, so calls go through injected `fetch`;
 * dependency-cruiser keeps vendor traffic from leaking past this boundary.
 */

const DEFAULT_BASE_URL = 'https://api.apollo.io';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Apollo's per_page ceiling for People Search. */
const MAX_PER_PAGE = 100;
/**
 * Hard page ceiling. Apollo caps People Search pagination at 500 pages / 50k
 * records on paid plans; this guards against an unbounded loop if a future API
 * change drops `total_pages`.
 */
const MAX_PAGES = 500;
/** Apollo returns this local-part when an email is gated behind credits. */
const LOCKED_EMAIL_MARKER = 'email_not_unlocked';

/** Credentials envelope this adapter persists + consumes. */
export interface ApolloCredentials {
  apiKey: string;
}

/** People Search criteria — the user's saved Apollo search, as config. */
export interface ApolloSearchCriteria {
  titles?: string[];
  seniorities?: string[];
  industries?: string[];
  companyHeadcount?: { min?: number; max?: number };
  locations?: string[];
  keywords?: string[];
  domains?: string[];
}

export interface ApolloSourceConfig {
  search: ApolloSearchCriteria;
  /** Hard cap on people pulled across all pages. Defaults to no cap. */
  maxContacts?: number;
}

/** Firmographic criteria for Organization Search (company discovery). */
export interface ApolloOrgSearchCriteria {
  keywords?: string[];
  industries?: string[];
  /** Soft funding-stage hints; folded into keyword tags (see toOrgSearchBody). */
  fundingStages?: string[];
  locations?: string[];
  companyHeadcount?: { min?: number; max?: number };
}

export interface ApolloOrgSearchConfig {
  search: ApolloOrgSearchCriteria;
  /** Hard cap on organizations pulled across all pages. Defaults to no cap. */
  maxOrgs?: number;
}

/** Params for searchOrganizations — creds + config + breaker hooks (no OAuth). */
export interface ApolloOrgSearchParams {
  creds: DecryptedCredentials;
  config: ApolloOrgSearchConfig;
  /** Resume page from a prior partial pull (1-based). */
  cursor?: string;
  onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
  onVendorSuccess?: () => void;
}

/**
 * A discovered company in the adapter's normalized shape. The
 * ApolloSourcingProvider maps this to the vendor-neutral `CandidateCompany`;
 * keeping the adapter free of the sourcing-layer type preserves the boundary.
 */
export interface ApolloOrganization {
  /** Apollo organization id, when present. */
  externalId: string | null;
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  employeeCount: number | null;
  fundingStage: string | null;
  /** The full vendor record — provenance the Researcher may draw on. */
  raw: Record<string, unknown>;
}

export interface ApolloSourceAdapterDeps {
  /** API base URL. Default https://api.apollo.io. */
  baseUrl?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
}

/** The subset of Apollo's person object we consume. */
interface ApolloPerson {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  linkedin_url?: string | null;
  email?: string | null;
  email_status?: string | null;
  organization?: { name?: string | null } | null;
}

interface ApolloSearchResponse {
  people?: ApolloPerson[];
  pagination?: { page?: number; total_pages?: number };
}

/** The subset of Apollo's organization object we consume. */
interface ApolloOrgRecord {
  id?: string | null;
  name?: string | null;
  website_url?: string | null;
  primary_domain?: string | null;
  domain?: string | null;
  linkedin_url?: string | null;
  estimated_num_employees?: number | null;
  latest_funding_stage?: string | null;
}

interface ApolloOrgSearchResponse {
  organizations?: ApolloOrgRecord[];
  accounts?: ApolloOrgRecord[];
  pagination?: { page?: number; total_pages?: number };
}

export class ApolloSourceAdapter implements SourceAdapter<ApolloSourceConfig> {
  readonly kind: ConnectorKind = 'apollo';
  readonly authMode: AuthMode = 'byo_key';

  private readonly baseUrl: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: ApolloSourceAdapterDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async ping(creds: DecryptedCredentials): Promise<PingResult> {
    const apiKey = decodeApolloCreds(creds).apiKey;
    try {
      const response = await this.request('GET', '/v1/auth/health', apiKey);
      if (!response.ok) {
        return {
          ok: false,
          scopes: [],
          error: `Apollo health check failed (HTTP ${response.status})`,
        };
      }
      return { ok: true, scopes: [] };
    } catch (err) {
      // Never echo the key; surface only the transport reason.
      return { ok: false, scopes: [], error: describeError(err) };
    }
  }

  async *syncContacts(
    params: SyncContactsParams<ApolloSourceConfig>,
  ): AsyncIterable<NormalizedContact> {
    const apiKey = decodeApolloCreds(params.creds).apiKey;
    const { config } = params;
    const searchBody = toSearchBody(config.search);
    const maxContacts = config.maxContacts;

    // The cursor is the next page to fetch (1-based). Resume picks up where a
    // prior partial sync stopped; a fresh sync starts at page 1.
    let page = parseCursor(params.cursor);
    let emitted = 0;

    while (page <= MAX_PAGES) {
      const data = await this.search(apiKey, searchBody, page, params);
      const people = data.people ?? [];
      if (people.length === 0) return;

      for (const person of people) {
        const contact = toNormalizedContact(person);
        // Skip people Apollo couldn't give us an actionable (unlocked) email
        // for — a contact without an email isn't usable for outbound, and the
        // upsert layer keys on email.
        if (!contact) continue;
        yield contact;
        emitted += 1;
        if (maxContacts !== undefined && emitted >= maxContacts) return;
      }

      const totalPages = data.pagination?.total_pages;
      if (totalPages !== undefined && page >= totalPages) return;
      page += 1;
    }
  }

  /** One People Search page, with circuit-breaker + auth signalling. */
  private async search(
    apiKey: string,
    searchBody: Record<string, unknown>,
    page: number,
    params: SyncContactsParams<ApolloSourceConfig>,
  ): Promise<ApolloSearchResponse> {
    return (await this.postSearchPage(
      apiKey,
      '/v1/mixed_people/search',
      searchBody,
      page,
      params,
    )) as ApolloSearchResponse;
  }

  /**
   * POST one page of an Apollo search endpoint, applying the shared
   * circuit-breaker + auth signalling. Used by both People Search
   * (`/v1/mixed_people/search`) and Organization Search
   * (`/v1/mixed_companies/search`). `hooks` carries the breaker callbacks; the
   * caller casts the parsed body to the endpoint's response shape.
   */
  private async postSearchPage(
    apiKey: string,
    path: string,
    searchBody: Record<string, unknown>,
    page: number,
    hooks: {
      onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
      onVendorSuccess?: () => void;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request('POST', path, apiKey, {
        ...searchBody,
        page,
        per_page: MAX_PER_PAGE,
      });
    } catch (err) {
      // Transport failure (DNS, timeout, reset) — feed the breaker as a 5xx so
      // a flapping vendor trips it, then propagate for the worker to retry.
      await hooks.onVendorFailure?.('server_5xx');
      throw new Error(`Apollo request failed: ${describeError(err)}`);
    }

    if (response.status === 401 || response.status === 403) {
      // byo_key has no refresh path: a rejected key is a hard auth failure.
      // This is the "Apollo 401 mid-sync" REGRESSION-IF-BROKEN path.
      await hooks.onVendorFailure?.('auth_invalid');
      throw new Error(`Apollo rejected the API key (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      await hooks.onVendorFailure?.('server_5xx');
      throw new Error(`Apollo server error (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Apollo HTTP ${response.status}` + (text ? `: ${text.slice(0, 200)}` : ''),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`Apollo returned a non-JSON response: ${describeError(err)}`);
    }
    // A successful page clears the breaker's failure window.
    hooks.onVendorSuccess?.();
    return json;
  }

  /**
   * Stream organizations matching firmographic criteria via Apollo's
   * Organization Search (`/v1/mixed_companies/search`). Unlike People Search
   * this does NOT unlock emails, so it costs no email credits — the right
   * primitive for ICP-driven *company* discovery. Cursor-resumable + breaker-
   * wired, mirroring syncContacts.
   */
  async *searchOrganizations(
    params: ApolloOrgSearchParams,
  ): AsyncIterable<ApolloOrganization> {
    const apiKey = decodeApolloCreds(params.creds).apiKey;
    const body = toOrgSearchBody(params.config.search);
    const maxOrgs = params.config.maxOrgs;

    let page = parseCursor(params.cursor);
    let emitted = 0;

    while (page <= MAX_PAGES) {
      const data = (await this.postSearchPage(apiKey, '/v1/mixed_companies/search', body, page, {
        onVendorFailure: params.onVendorFailure,
        onVendorSuccess: params.onVendorSuccess,
      })) as ApolloOrgSearchResponse;
      // Apollo has used both `organizations` and `accounts` for this endpoint;
      // accept either so a vendor-side rename doesn't silently return nothing.
      const orgs = data.organizations ?? data.accounts ?? [];
      if (orgs.length === 0) return;

      for (const org of orgs) {
        const candidate = toApolloOrganization(org);
        // A candidate must at least have a name; skip nameless rows.
        if (!candidate) continue;
        yield candidate;
        emitted += 1;
        if (maxOrgs !== undefined && emitted >= maxOrgs) return;
      }

      const totalPages = data.pagination?.total_pages;
      if (totalPages !== undefined && page >= totalPages) return;
      page += 1;
    }
  }

  /** Issue a request with the key in the X-Api-Key header + a timeout. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    // The key is already validated by decodeApolloCreds before any request;
    // no second guard here (DRY — one validation point).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.httpFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Decode + validate the credentials envelope. Throws if the key is absent. */
function decodeApolloCreds(creds: DecryptedCredentials): ApolloCredentials {
  const apiKey = creds['apiKey'];
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Apollo credentials missing a non-empty apiKey');
  }
  return { apiKey: apiKey.trim() };
}

/** Map the search criteria to Apollo's People Search request body. */
function toSearchBody(search: ApolloSearchCriteria): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (search.titles?.length) body.person_titles = search.titles;
  if (search.seniorities?.length) body.person_seniorities = search.seniorities;
  if (search.locations?.length) body.person_locations = search.locations;
  if (search.domains?.length) {
    // Apollo filters by org domains via a newline-joined string.
    body.q_organization_domains = search.domains.join('\n');
  }
  // Apollo has no first-class industry filter on People Search, so fold
  // industries into the free-text keyword query alongside `keywords`.
  const keywords = [...(search.keywords ?? []), ...(search.industries ?? [])];
  if (keywords.length) body.q_keywords = keywords.join(' ');

  const range = toHeadcountRange(search.companyHeadcount);
  if (range) body.organization_num_employees_ranges = [range];

  return body;
}

/**
 * Map firmographic criteria to Apollo's Organization Search body.
 *
 * Apollo org search has no free-text industry filter, so keywords + industries
 * (and funding-stage hints, underscores→spaces) all fold into
 * `q_organization_keyword_tags`. Funding/revenue precision is deliberately NOT
 * trusted to this query — the Researcher derives + cites it from the web.
 * Headcount + locations map to first-class structured filters.
 */
function toOrgSearchBody(
  search: ApolloOrgSearchCriteria,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const tags = [
    ...(search.keywords ?? []),
    ...(search.industries ?? []),
    ...(search.fundingStages ?? []).map((s) => s.replace(/_/g, ' ')),
  ]
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tags.length) body.q_organization_keyword_tags = tags;
  if (search.locations?.length) body.organization_locations = search.locations;
  const range = toHeadcountRange(search.companyHeadcount);
  if (range) body.organization_num_employees_ranges = [range];
  return body;
}

/** Down-convert one Apollo organization to the normalized shape, or null if it lacks a name. */
function toApolloOrganization(org: ApolloOrgRecord): ApolloOrganization | null {
  const name = nullIfBlank(org.name);
  if (!name) return null;
  return {
    externalId: nullIfBlank(org.id),
    name,
    domain:
      nullIfBlank(org.primary_domain) ??
      nullIfBlank(org.domain) ??
      domainFromUrl(org.website_url),
    linkedinUrl: nullIfBlank(org.linkedin_url),
    employeeCount:
      typeof org.estimated_num_employees === 'number'
        ? org.estimated_num_employees
        : null,
    fundingStage: nullIfBlank(org.latest_funding_stage),
    raw: org as Record<string, unknown>,
  };
}

/** Best-effort hostname from a website URL (strips scheme + leading www.). */
function domainFromUrl(url: string | null | undefined): string | null {
  const trimmed = nullIfBlank(url);
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return u.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Apollo expects "min,max" strings (e.g. "11,50"). Returns null if unset. */
function toHeadcountRange(
  headcount: ApolloSearchCriteria['companyHeadcount'],
): string | null {
  if (!headcount || (headcount.min == null && headcount.max == null)) {
    return null;
  }
  const min = headcount.min ?? 1;
  const max = headcount.max ?? 1_000_000;
  return `${min},${max}`;
}

/**
 * Down-convert one Apollo person to a NormalizedContact, or null if it lacks
 * the two things the upsert layer needs: a stable id and an unlocked email.
 */
function toNormalizedContact(person: ApolloPerson): NormalizedContact | null {
  const externalId = nullIfBlank(person.id);
  const emailRaw = cleanEmail(person.email);
  if (!externalId || !emailRaw) return null;

  return {
    emailRaw,
    externalId,
    externalUrl: `https://app.apollo.io/#/people/${externalId}`,
    firstName: nullIfBlank(person.first_name),
    lastName: nullIfBlank(person.last_name),
    title: nullIfBlank(person.title),
    company: nullIfBlank(person.organization?.name),
    linkedinUrl: nullIfBlank(person.linkedin_url),
    // The full person — including `email_status` — is the provenance record.
    rawPayload: person,
  };
}

/** Treat Apollo's credit-gated placeholder address as "no email". */
function cleanEmail(email: string | null | undefined): string | null {
  const trimmed = nullIfBlank(email);
  if (!trimmed || trimmed.includes(LOCKED_EMAIL_MARKER)) return null;
  return trimmed;
}

/** The cursor is a 1-based page number; default to page 1 when absent/invalid. */
function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 1;
  const page = Number.parseInt(cursor, 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/** Trim to a non-empty string, else null. */
function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Transport-error description, with a timeout called out distinctly. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The registry singleton — uses the default (global fetch) client. */
export const apolloSourceAdapter = new ApolloSourceAdapter();
