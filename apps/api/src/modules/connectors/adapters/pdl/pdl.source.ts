import type {
  AuthMode,
  ConnectorKind,
  DecryptedCredentials,
  PingResult,
} from '@getbeyond/shared';

/**
 * People Data Labs (PDL) company-enrichment adapter.
 *
 * Unlike a SourceAdapter (which pulls *contacts* in), this adapter resolves the
 * firmographic skeleton of a single *company* by identity (name + domain): it
 * calls PDL's Company Enrichment endpoint and normalizes the response to the
 * fields the prospect-search pipeline can backfill onto a `CandidateCompany`
 * before qualification (domain, linkedin, employee count) plus the richer
 * signals (industry, location) it carries through as provenance in `raw`.
 *
 * Why a separate adapter, not a SourceAdapter: PDL enrichment is identity → one
 * record, not a streamed contact list, and it never unlocks emails. Wiring it as
 * a SourceAdapter would force a syncContacts() it can't honestly implement. It
 * still exposes `ping` (for the connect controller's key validation) + the
 * breaker-hook contract (server_5xx / auth_invalid) the credential manager uses.
 *
 * Auth: `byo_key`. The user pastes a PDL API key; the runtime stores it encrypted
 * on `ConnectorAccount` and hands it back decrypted here (invariant #6). No OAuth
 * refresh — a 401 means the key is bad (surfaced via onVendorFailure('auth_invalid')).
 *
 * SDK quarantine (invariant #5): all PDL HTTP lives in this file. PDL has no
 * official Node SDK we depend on, so calls go through injected `fetch`.
 */

const DEFAULT_BASE_URL = 'https://api.peopledatalabs.com';
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * PDL match-confidence floor (likelihood 1–10). A domain match is usually a 10;
 * a name-only match can be loose, so we require a reasonably confident record
 * rather than backfilling firmographics from a wrong company. Below the floor,
 * PDL returns 404 (no record) — and PDL does not bill a credit for a 404, which
 * is also what makes `ping` free.
 */
const DEFAULT_MIN_LIKELIHOOD = 6;
/** A name that cannot match any real company — used by `ping` for a zero-credit key check. */
const PING_SENTINEL_NAME = '__getbeyond_pdl_ping__';

/** Credentials envelope this adapter persists + consumes. */
export interface PdlCredentials {
  apiKey: string;
}

/** Identity inputs + breaker hooks for one company enrichment lookup. */
export interface PdlCompanyEnrichParams {
  creds: DecryptedCredentials;
  /** Company name (always present on a CandidateCompany). */
  name: string;
  /** Company domain when the sourcing provider already had one (sharpens the match). */
  domain: string | null;
  onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
  onVendorSuccess?: () => void;
}

/**
 * A PDL company in the adapter's normalized shape. The PdlEnrichmentProvider
 * maps this onto the vendor-neutral `CandidateCompany` (filling nulls only);
 * keeping the adapter free of the sourcing-layer type preserves the boundary.
 * PDL Company Enrichment carries no funding-stage signal, so that field is left
 * for the Researcher to derive + cite from the web.
 */
export interface PdlCompanyRecord {
  domain: string | null;
  linkedinUrl: string | null;
  employeeCount: number | null;
  industry: string | null;
  location: string | null;
  /** The full vendor record — provenance the Researcher may draw on. */
  raw: Record<string, unknown>;
}

export interface PdlSourceAdapterDeps {
  /** API base URL. Default https://api.peopledatalabs.com. */
  baseUrl?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Match-confidence floor (1–10). Default 6. */
  minLikelihood?: number;
}

/** The subset of PDL's company object we consume. */
interface PdlCompanyResponse {
  status?: number;
  website?: string | null;
  linkedin_url?: string | null;
  employee_count?: number | null;
  industry?: string | null;
  location?: { name?: string | null } | null;
}

export class PdlSourceAdapter {
  readonly kind: ConnectorKind = 'pdl';
  readonly authMode: AuthMode = 'byo_key';

  private readonly baseUrl: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minLikelihood: number;

  constructor(deps: PdlSourceAdapterDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minLikelihood = deps.minLikelihood ?? DEFAULT_MIN_LIKELIHOOD;
  }

  /**
   * Validate the key without burning a credit: enrich a sentinel name that
   * cannot match (forcing a 404, which PDL does not bill). Any non-auth response
   * — including the expected 404 — means the key works; only 401/403 is a bad key.
   */
  async ping(creds: DecryptedCredentials): Promise<PingResult> {
    try {
      const apiKey = decodePdlCreds(creds).apiKey;
      const response = await this.request(apiKey, {
        name: PING_SENTINEL_NAME,
        min_likelihood: '10',
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          scopes: [],
          error: `PDL rejected the API key (HTTP ${response.status})`,
        };
      }
      return { ok: true, scopes: [] };
    } catch (err) {
      // Never echo the key; surface only the transport reason.
      return { ok: false, scopes: [], error: describeError(err) };
    }
  }

  /**
   * Resolve one company's firmographics by identity. Returns null when PDL has
   * no confident match (HTTP 404) — a normal, non-failure outcome the caller
   * treats as "nothing to backfill". Breaker-wired: 401/403 → auth_invalid, 5xx
   * → server_5xx, then throw so the caller's best-effort pass can degrade.
   */
  async enrichCompany(
    params: PdlCompanyEnrichParams,
  ): Promise<PdlCompanyRecord | null> {
    const apiKey = decodePdlCreds(params.creds).apiKey;
    const query: Record<string, string> = {
      name: params.name,
      min_likelihood: String(this.minLikelihood),
    };
    // A known domain sharpens the match (PDL accepts name + website together).
    if (params.domain) query.website = params.domain;

    let response: Response;
    try {
      response = await this.request(apiKey, query);
    } catch (err) {
      // Transport failure (DNS, timeout, reset) — feed the breaker as a 5xx so a
      // flapping vendor trips it, then propagate for the caller to handle.
      await params.onVendorFailure?.('server_5xx');
      throw new Error(`PDL request failed: ${describeError(err)}`);
    }

    if (response.status === 404) {
      // No confident match — a valid key that simply found nothing. Not a
      // failure: clear the breaker window and report "nothing to backfill".
      params.onVendorSuccess?.();
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      // byo_key has no refresh path: a rejected key is a hard auth failure.
      await params.onVendorFailure?.('auth_invalid');
      throw new Error(`PDL rejected the API key (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      await params.onVendorFailure?.('server_5xx');
      throw new Error(`PDL server error (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `PDL HTTP ${response.status}` + (text ? `: ${text.slice(0, 200)}` : ''),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new Error(`PDL returned a non-JSON response: ${describeError(err)}`);
    }
    // A successful page clears the breaker's failure window.
    params.onVendorSuccess?.();
    return toPdlCompanyRecord(json as PdlCompanyResponse);
  }

  /** Issue the enrichment GET with the key in the X-Api-Key header + a timeout. */
  private async request(
    apiKey: string,
    query: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/v5/company/enrich`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.httpFetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Api-Key': apiKey,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Decode + validate the credentials envelope. Throws if the key is absent. */
function decodePdlCreds(creds: DecryptedCredentials): PdlCredentials {
  const apiKey = creds['apiKey'];
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('PDL credentials missing a non-empty apiKey');
  }
  return { apiKey: apiKey.trim() };
}

/** Normalize a PDL company response to the adapter shape. */
function toPdlCompanyRecord(company: PdlCompanyResponse): PdlCompanyRecord {
  return {
    domain: domainFromUrl(company.website),
    linkedinUrl: normalizeLinkedinUrl(company.linkedin_url),
    employeeCount:
      typeof company.employee_count === 'number'
        ? company.employee_count
        : null,
    industry: nullIfBlank(company.industry),
    location: nullIfBlank(company.location?.name),
    raw: company as Record<string, unknown>,
  };
}

/** PDL returns bare linkedin paths ("linkedin.com/company/acme"); make them absolute. */
function normalizeLinkedinUrl(value: string | null | undefined): string | null {
  const trimmed = nullIfBlank(value);
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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
export const pdlSourceAdapter = new PdlSourceAdapter();
