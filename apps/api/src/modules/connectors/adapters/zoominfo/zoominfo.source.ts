/**
 * ZoomInfo client (vendor-HTTP quarantine boundary).
 *
 * The data-vendor counterpart to the Apollo / Snov adapters. Right now it
 * exposes exactly one operation — Company Search — over ZoomInfo's GTM Data
 * API, plus the OAuth machinery that operation needs. The people-sync
 * `SourceAdapter` contract + `ZoomInfoSourcingProvider` + registry entry are
 * the deliberate next step (the registry comments this as "T8"); keeping this
 * file to company-search-first mirrors how Apollo's company discovery is the
 * no-credit-burn primitive.
 *
 * Auth: OAuth2 client-credentials. Unlike Apollo/Snov (per-org BYO keys pasted
 * into a `ConnectorAccount`), ZoomInfo here is a single app-level credential:
 * `ZOOMINFO_CLIENT_ID` (public) + `ZOOMINFO_CLIENT_SECRET` (env-only, never
 * hardcoded). We exchange them for a short-lived Bearer token, CACHE it, and
 * mint a fresh one only when the cached token expires — or when the API rejects
 * it mid-call (a 401 is the authoritative "stale token" signal; the TTL is just
 * an optimization to avoid minting on every request).
 *
 * Opaque-token discipline: ZoomInfo's `access_token` is an opaque ~1KB string.
 * It is copied VERBATIM into `Authorization: Bearer <token>` — never decoded,
 * parsed, trimmed, or reformatted. Do not "validate" it by inspecting its
 * contents; the only signal that a token is bad is the API returning 401/403.
 *
 * User-Agent: every request (token + data) sends an explicit `User-Agent`.
 * Node's default undici UA is frequently gateway-blocked and returns a
 * misleading 403, so `rawFetch` injects ours on every call — it is structurally
 * impossible to forget.
 *
 * SDK quarantine (architecture invariant #5): all ZoomInfo HTTP lives in this
 * file. ZoomInfo has no official Node SDK we depend on, so calls go through an
 * injected `fetch`; dependency-cruiser keeps vendor traffic from leaking past
 * this boundary. Credentials never leave this layer (invariant #6).
 */

/** Public OAuth client id for the ZoomInfo GTM app. Not a secret. */
const DEFAULT_CLIENT_ID = '0oa13pd1zzkaMLKq7698';
/** GTM Data API base (Company/Contact search live under here). */
const DEFAULT_BASE_URL = 'https://api.zoominfo.com/gtm/data/v1';
/** Client-credentials token endpoint. */
const DEFAULT_OAUTH_URL = 'https://api.zoominfo.com/gtm/oauth/v1/token';
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Fallback token lifetime when the OAuth response omits `expires_in`. ZoomInfo
 * tokens are ~1h; 55m leaves headroom. We never read the token's own contents
 * to discover its expiry (opaque-token discipline) — a 401 mid-call is the
 * authoritative refresh trigger regardless of this value.
 */
const DEFAULT_TOKEN_TTL_MS = 55 * 60_000;
/** Subtracted from the computed expiry so we refresh just before the edge. */
const DEFAULT_TOKEN_SKEW_MS = 60_000;
/**
 * Explicit UA. ZoomInfo's gateway frequently 403s the default undici UA, so we
 * always identify ourselves. Bump the version if the gateway ever blocks it.
 */
const DEFAULT_USER_AGENT = 'getbeyond-zoominfo-connector/1.0';
/** JSON:API media type ZoomInfo's GTM Data API speaks. */
const JSON_API_MEDIA_TYPE = 'application/vnd.api+json';
/** JSON:API resource type for the company-search request body. */
const COMPANY_SEARCH_TYPE = 'CompanySearch';
/** JSON:API resource type for the contact-search request body. */
const CONTACT_SEARCH_TYPE = 'ContactSearch';
/** JSON:API resource type for the contact-enrich request body. */
const CONTACT_ENRICH_TYPE = 'ContactEnrich';

/**
 * Company-search criteria. ZoomInfo's CompanySearch accepts many attributes
 * (companyName, companyWebsite, industryCodes, …); we type the common ones and
 * leave the bag open so callers aren't blocked on us modelling every facet.
 * Unknown keys pass straight through to the vendor.
 */
export interface ZoomInfoCompanySearchAttributes {
  companyName?: string;
  companyWebsite?: string;
  [attribute: string]: unknown;
}

/**
 * Contact-search criteria. ZoomInfo's ContactSearch filters people by
 * firmographic + role attributes. The common ones are typed; the bag stays open
 * so unknown keys pass through (a typed `companyId` is intentionally NOT exposed
 * — the live API rejects it as the wrong type, so `companyName` is the safe
 * company filter). NOTE: search returns only `hasEmail`/`hasDirectPhone` flags +
 * an accuracy score, never the email/phone itself — those need ZoomInfo's
 * separate (credit-consuming) enrich endpoint.
 */
export interface ZoomInfoContactSearchAttributes {
  companyName?: string;
  jobTitle?: string;
  firstName?: string;
  lastName?: string;
  [attribute: string]: unknown;
}

/** Pagination for the search endpoints. 1-based page; ZoomInfo defaults size to 25. */
export interface ZoomInfoSearchOptions {
  /** 1-based page number (maps to `page[number]`). */
  page?: number;
  /** Results per page (maps to `page[size]`). */
  pageSize?: number;
}

/**
 * A single contact match input for {@link ZoomInfoClient.enrichContacts}. The
 * cheapest, most reliable key is `personId` (from a prior contact search);
 * name + company can match when you have no id. The bag stays open for the
 * other match keys ZoomInfo accepts.
 */
export interface ZoomInfoContactMatchInput {
  personId?: number;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  emailAddress?: string;
  [key: string]: unknown;
}

/**
 * A JSON:API document. We deliberately do NOT over-model ZoomInfo's response —
 * `data` is whatever the vendor returned; the caller (or a future
 * ZoomInfoSourcingProvider) maps it to the vendor-neutral `CandidateCompany`.
 */
export interface ZoomInfoDocument {
  data?: unknown;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ZoomInfoClientDeps {
  /** OAuth client id. Default: env `ZOOMINFO_CLIENT_ID`, else the GTM app id. */
  clientId?: string;
  /**
   * OAuth client secret. Default: env `ZOOMINFO_CLIENT_SECRET`. Never hardcode
   * the literal — it is read from the environment in production.
   */
  clientSecret?: string;
  /** Data API base URL. Default https://api.zoominfo.com/gtm/data/v1. */
  baseUrl?: string;
  /** Token endpoint. Default https://api.zoominfo.com/gtm/oauth/v1/token. */
  oauthUrl?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** User-Agent sent on every request. Default getbeyond-zoominfo-connector/1.0. */
  userAgent?: string;
  /** Fallback token TTL when the OAuth response omits expires_in. Default 55m. */
  tokenTtlMs?: number;
  /** Safety skew subtracted from token expiry. Default 60s. */
  tokenSkewMs?: number;
  /** Clock injection for deterministic expiry tests. Default Date.now. */
  now?: () => number;
}

/** Raised on 401/403 — credentials/token rejected. No retry can self-heal a bad secret. */
export class ZoomInfoAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoomInfoAuthError';
  }
}

/** Raised on 5xx / transport failure — transient; the caller may retry. */
export class ZoomInfoServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoomInfoServerError';
  }
}

/** A cached token plus the wall-clock ms after which it must be re-minted. */
interface CachedToken {
  token: string;
  expiresAt: number;
}

export class ZoomInfoClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly oauthUrl: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly tokenTtlMs: number;
  private readonly tokenSkewMs: number;
  private readonly now: () => number;

  /** The last token we minted, with its computed expiry. Null until first mint. */
  private cached: CachedToken | null = null;
  /**
   * In-flight mint, so concurrent callers single-flight one token request
   * instead of stampeding the OAuth endpoint. Cleared once the mint settles.
   */
  private inflightMint: Promise<string> | null = null;

  constructor(deps: ZoomInfoClientDeps = {}) {
    this.clientId =
      deps.clientId ?? process.env.ZOOMINFO_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    // Read the secret from the environment; never bake the literal into source.
    this.clientSecret = deps.clientSecret ?? process.env.ZOOMINFO_CLIENT_SECRET ?? '';
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.oauthUrl = deps.oauthUrl ?? DEFAULT_OAUTH_URL;
    // Resolve globalThis.fetch lazily so tests that swap it mid-process see the
    // new function (matches the brave-search / apollo convention).
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = deps.userAgent ?? DEFAULT_USER_AGENT;
    this.tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.tokenSkewMs = deps.tokenSkewMs ?? DEFAULT_TOKEN_SKEW_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Cheap connection check: a successful client-credentials exchange proves the
   * secret is valid and costs no ZoomInfo credits. Returns true on success;
   * surfaces only the transport/auth reason (never the secret) on failure.
   */
  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getAccessToken({ forceRefresh: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /**
   * Run a ZoomInfo Company Search. Mirrors the documented example call:
   *
   *   POST {baseUrl}/companies/search
   *   Content-Type / Accept: application/vnd.api+json
   *   { "data": { "type": "CompanySearch", "attributes": { ... } } }
   *
   * Pass `opts.page` / `opts.pageSize` to page through results; the response's
   * `meta.totalResults` + `links.next` describe the full set.
   */
  async searchCompanies(
    attributes: ZoomInfoCompanySearchAttributes,
    opts: ZoomInfoSearchOptions = {},
  ): Promise<ZoomInfoDocument> {
    return this.search('companies', COMPANY_SEARCH_TYPE, attributes, opts);
  }

  /**
   * Run a ZoomInfo Contact Search (people at companies). Same JSON:API envelope
   * as company search:
   *
   *   POST {baseUrl}/contacts/search
   *   { "data": { "type": "ContactSearch", "attributes": { ... } } }
   *
   * Returns contact metadata + reachability flags (`hasEmail` etc.), NOT the
   * email/phone itself — use {@link enrichContacts} (credit-consuming) for that.
   * Paginates via `opts.page` / `opts.pageSize`.
   */
  async searchContacts(
    attributes: ZoomInfoContactSearchAttributes,
    opts: ZoomInfoSearchOptions = {},
  ): Promise<ZoomInfoDocument> {
    return this.search('contacts', CONTACT_SEARCH_TYPE, attributes, opts);
  }

  /**
   * Enrich contacts — resolve real email/phone for people you already matched
   * (typically `personId`s harvested from {@link searchContacts}):
   *
   *   POST {baseUrl}/contacts/enrich
   *   { "data": { "type": "ContactEnrich", "attributes": {
   *       "matchPersonInput": [ { "personId": 123 }, ... ],
   *       "outputFields": [ "firstName", "email", ... ] } } }
   *
   * `matchPersonInput` is a batch (1..N inputs); each response item carries a
   * `meta.matchStatus` (e.g. FULL_MATCH / NO_MATCH). THIS CONSUMES ZoomInfo
   * CREDITS — search does not, enrich does. Both `matches` and `outputFields`
   * must be non-empty (the API 400s on an empty `outputFields`).
   */
  async enrichContacts(
    matches: ZoomInfoContactMatchInput[],
    outputFields: string[],
  ): Promise<ZoomInfoDocument> {
    if (matches.length === 0) {
      throw new Error('enrichContacts requires at least one match input');
    }
    if (outputFields.length === 0) {
      // ZoomInfo rejects an empty outputFields with a 400; fail fast + clearly.
      throw new Error('enrichContacts requires at least one output field');
    }
    return this.authedPost('/contacts/enrich', {
      data: {
        type: CONTACT_ENRICH_TYPE,
        attributes: { matchPersonInput: matches, outputFields },
      },
    });
  }

  /**
   * Shared JSON:API search: POST {baseUrl}/{resource}/search. Pagination rides
   * as `page[number]` / `page[size]` query params (ZoomInfo rejects them in the
   * body). Delegates auth + retry + parsing to {@link authedPost}.
   */
  private async search(
    resource: 'companies' | 'contacts',
    type: typeof COMPANY_SEARCH_TYPE | typeof CONTACT_SEARCH_TYPE,
    attributes: Record<string, unknown>,
    opts: ZoomInfoSearchOptions,
  ): Promise<ZoomInfoDocument> {
    return this.authedPost(
      `/${resource}/search${pageQuery(opts)}`,
      { data: { type, attributes } },
    );
  }

  /**
   * The single authed-write chokepoint: POST {baseUrl}{path} with the cached
   * Bearer token. On a 401/403 it mints a fresh token ONCE and retries (covers
   * the token-expired-mid-call case); a second 401 is a hard auth failure — the
   * secret itself is bad, and no retry can fix that.
   */
  private async authedPost(
    path: string,
    body: unknown,
  ): Promise<ZoomInfoDocument> {
    let token = await this.getAccessToken();
    let response = await this.postJsonApi(path, token, body);

    if (response.status === 401 || response.status === 403) {
      token = await this.getAccessToken({ forceRefresh: true });
      response = await this.postJsonApi(path, token, body);
    }

    return this.parseResponse(response);
  }

  /** Issue a JSON:API POST. Pure transport; status handling lives in the caller. */
  private async postJsonApi(
    path: string,
    token: string,
    body: unknown,
  ): Promise<Response> {
    return this.rawFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: JSON_API_MEDIA_TYPE,
        'Content-Type': JSON_API_MEDIA_TYPE,
        // Verbatim opaque token — never decoded, parsed, trimmed, or reformatted.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  /** Map a settled response to a parsed document or a typed error. */
  private async parseResponse(
    response: Response,
  ): Promise<ZoomInfoDocument> {
    if (response.status === 401 || response.status === 403) {
      // Reached here only after a fresh-token retry already failed.
      throw new ZoomInfoAuthError(
        `ZoomInfo rejected the access token (HTTP ${response.status})`,
      );
    }
    if (response.status >= 500) {
      throw new ZoomInfoServerError(
        `ZoomInfo server error (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `ZoomInfo HTTP ${response.status}` +
          (text ? `: ${text.slice(0, 200)}` : ''),
      );
    }
    try {
      return (await response.json()) as ZoomInfoDocument;
    } catch (err) {
      throw new Error(
        `ZoomInfo returned a non-JSON response: ${describeError(err)}`,
      );
    }
  }

  /**
   * Return a usable Bearer token, minting a fresh one only when there is no
   * cached token, the cached one has expired, or `forceRefresh` is set.
   * Concurrent callers share a single in-flight mint (single-flight).
   */
  private async getAccessToken(
    opts: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    if (!opts.forceRefresh && this.cached && this.now() < this.cached.expiresAt) {
      return this.cached.token;
    }
    // Single-flight: if a mint is already running, await it rather than firing a
    // second OAuth exchange. forceRefresh still piggybacks — a 401-driven
    // refresh that races a TTL refresh is fine; both want a fresh token.
    if (this.inflightMint) {
      return this.inflightMint;
    }
    this.inflightMint = this.mintToken();
    try {
      return await this.inflightMint;
    } finally {
      this.inflightMint = null;
    }
  }

  /** Exchange client credentials for a fresh token and cache it with an expiry. */
  private async mintToken(): Promise<string> {
    if (this.clientSecret.trim() === '') {
      // Never echo the (absent) secret; just say it's unconfigured.
      throw new ZoomInfoAuthError(
        'ZoomInfo client secret is not configured (set ZOOMINFO_CLIENT_SECRET)',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    let response: Response;
    try {
      response = await this.rawFetch(this.oauthUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (err) {
      throw new ZoomInfoServerError(
        `ZoomInfo token request failed: ${describeError(err)}`,
      );
    }

    if (response.status === 400 || response.status === 401) {
      throw new ZoomInfoAuthError('ZoomInfo rejected the client credentials');
    }
    if (response.status >= 500) {
      throw new ZoomInfoServerError(
        `ZoomInfo auth server error (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      throw new Error(`ZoomInfo auth HTTP ${response.status}`);
    }

    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = (await response.json()) as typeof json;
    } catch (err) {
      throw new Error(
        `ZoomInfo auth returned a non-JSON response: ${describeError(err)}`,
      );
    }

    const token = json.access_token;
    // Validate presence/type WITHOUT mutating: the token is opaque, so we never
    // trim or reformat it — an all-whitespace token would be ZoomInfo's bug to
    // report, not ours to silently "fix".
    if (typeof token !== 'string' || token.length === 0) {
      throw new ZoomInfoAuthError('ZoomInfo auth response had no access_token');
    }

    this.cached = { token, expiresAt: this.computeExpiry(json.expires_in) };
    return token;
  }

  /**
   * Expiry = now + lifetime − skew. Honors a positive numeric `expires_in`
   * (seconds) from the OAuth response; otherwise falls back to the configured
   * TTL. Never derived from the token's contents (opaque-token discipline).
   */
  private computeExpiry(expiresIn: unknown): number {
    const lifetimeMs =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1_000
        : this.tokenTtlMs;
    return this.now() + Math.max(0, lifetimeMs - this.tokenSkewMs);
  }

  /**
   * Low-level fetch: injects the User-Agent on EVERY request (so it can't be
   * forgotten) and applies an abort-based timeout.
   */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.httpFetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          // Set last so our UA always wins — explicit, never the blocked default.
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the `?page[number]=&page[size]=` query suffix from search options.
 * Returns '' when neither is set so the URL stays clean. Only positive integers
 * are emitted; anything else is ignored (ZoomInfo applies its own defaults).
 */
function pageQuery(opts: ZoomInfoSearchOptions): string {
  const params = new URLSearchParams();
  if (Number.isInteger(opts.page) && (opts.page as number) > 0) {
    params.set('page[number]', String(opts.page));
  }
  if (Number.isInteger(opts.pageSize) && (opts.pageSize as number) > 0) {
    params.set('page[size]', String(opts.pageSize));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Transport-error description, with a timeout called out distinctly. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The singleton — uses the default (global fetch) client + env credentials. */
export const zoominfoClient = new ZoomInfoClient();
