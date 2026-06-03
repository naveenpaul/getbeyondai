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
 * Snov.io source adapter (contacts-with-emails path).
 *
 * Snov is DOMAIN-driven: you give it company domains (+ optional job titles) and
 * it returns prospects, then a per-prospect lookup resolves a (best-effort
 * verified) email. Unlike Apollo there is no ICP-wide people discovery — the
 * caller supplies `config.domains`. This makes Snov the email-finder/verifier
 * source: a person's `smtp_status` rides along in `rawPayload` so every imported
 * email has honest provenance (valid / unknown / accept_all), and we import ALL
 * found emails labelled with status rather than dropping the unverified ones.
 *
 * Auth: `byo_key` over OAuth client-credentials. The user pastes an API User ID
 * + API Secret; we exchange them for a short-lived (1h) Bearer token on each
 * call and refresh once on a 401. There is no stored refresh token — a 401 after
 * a fresh exchange is a hard auth failure surfaced via the breaker.
 *
 * Async protocol: Snov v2 search endpoints are task-based — POST `…/start`
 * returns HTTP 202 + a `links.result` URL; you poll that GET until it returns
 * HTTP 200 with a terminal `meta.status`. All of this lives behind `pollTask`.
 *
 * SDK quarantine (invariant #5): all Snov HTTP lives in this file. Snov has no
 * official Node SDK we depend on, so calls go through injected `fetch`.
 */

const DEFAULT_BASE_URL = 'https://api.snov.io';
const DEFAULT_TIMEOUT_MS = 30_000;
const OAUTH_PATH = '/v1/oauth/access_token';
/** Snov returns up to 20 prospects per domain-search page. */
const PROSPECTS_PER_PAGE = 20;
/** Guard against an unbounded paging loop if a page count goes haywire. */
const MAX_PAGES_PER_DOMAIN = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_MAX_TRIES = 25;

/** Credentials envelope this adapter persists + consumes. */
export interface SnovCredentials {
  clientId: string;
  clientSecret: string;
}

/** The caller-supplied domain list + optional title filter, as config. */
export interface SnovSourceConfig {
  /** Company domains to source contacts from (e.g. ["stripe.com"]). */
  domains: string[];
  /** Optional job-title filter (Snov caps at 10). Empty = all prospects. */
  positions?: string[];
  /** Hard cap on contacts emitted per domain. Defaults to no cap. */
  maxContactsPerDomain?: number;
}

export interface SnovSourceAdapterDeps {
  /** API base URL. Default https://api.snov.io. */
  baseUrl?: string;
  /** HTTP client. Defaults to global fetch (resolved lazily). Tests inject a stub. */
  httpFetch?: typeof fetch;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Poll interval between result fetches. Default 1.5s (tests pass 0). */
  pollIntervalMs?: number;
  /** Max result polls before giving up on a task. Default 25. */
  pollMaxTries?: number;
}

/** Snov's prospect record (the subset we consume). */
interface SnovProspect {
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  /** Usually the LinkedIn profile URL — our most stable per-person identifier. */
  source_page?: string | null;
  /** Ready-made URL to POST to start this prospect's email lookup. */
  search_emails_start?: string | null;
}

interface SnovEmailEntry {
  email?: string | null;
  smtp_status?: string | null;
}

/** Thrown on 401/403 so the caller can refresh the token and retry once. */
class SnovAuthError extends Error {}
/** Thrown on 5xx / transport failure (already reported to the breaker). */
class SnovServerError extends Error {}

/** A mutable token holder so a single-retry refresh updates the in-flight token. */
interface TokenRef {
  value: string;
}

export class SnovSourceAdapter implements SourceAdapter<SnovSourceConfig> {
  readonly kind: ConnectorKind = 'snov';
  readonly authMode: AuthMode = 'byo_key';

  private readonly baseUrl: string;
  private readonly httpFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollMaxTries: number;

  constructor(deps: SnovSourceAdapterDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.httpFetch = deps.httpFetch
      ? deps.httpFetch
      : (...args) => globalThis.fetch(...args);
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollMaxTries = deps.pollMaxTries ?? DEFAULT_POLL_MAX_TRIES;
  }

  async ping(creds: DecryptedCredentials): Promise<PingResult> {
    // A successful client-credentials exchange proves the keys are valid and
    // costs no Snov credits — the right cheap connection check.
    try {
      await this.getAccessToken(decodeSnovCreds(creds));
      return { ok: true, scopes: [] };
    } catch (err) {
      // Never echo credentials; surface only the transport/auth reason.
      return { ok: false, scopes: [], error: describeError(err) };
    }
  }

  async *syncContacts(
    params: SyncContactsParams<SnovSourceConfig>,
  ): AsyncIterable<NormalizedContact> {
    const creds = decodeSnovCreds(params.creds);
    const domains = params.config.domains
      .map((d) => normalizeDomain(d))
      .filter((d): d is string => d !== null);
    const positions = params.config.positions?.filter((p) => p.trim().length > 0);
    const maxPerDomain = params.config.maxContactsPerDomain;

    const tokenRef: TokenRef = { value: await this.getAccessToken(creds, params) };

    // Cursor resumes a partial sync: "<domainIndex>:<page>" (both 0/1-based as
    // noted). A fresh sync starts at the first domain, page 1.
    let { domainIndex, page } = parseCursor(params.cursor);

    for (; domainIndex < domains.length; domainIndex++, page = 1) {
      const domain = domains[domainIndex];
      if (domain === undefined) break;
      // One company-info lookup per domain gives a real company name for every
      // contact at that domain (best-effort; null on failure).
      const company = await this.fetchCompanyName(creds, tokenRef, domain, params);

      let emitted = 0;
      for (; page <= MAX_PAGES_PER_DOMAIN; page++) {
        const prospects = await this.fetchProspects(
          creds,
          tokenRef,
          domain,
          positions,
          page,
          params,
        );
        if (prospects.length === 0) break;

        for (const prospect of prospects) {
          const email = await this.resolveEmail(creds, tokenRef, prospect, params);
          const contact = toSnovContact(domain, company, prospect, email);
          // Skip prospects Snov found no email for — a contact without an email
          // isn't usable for outbound and the upsert layer keys on email.
          if (!contact) continue;
          yield contact;
          emitted += 1;
          if (maxPerDomain !== undefined && emitted >= maxPerDomain) break;
        }

        if (maxPerDomain !== undefined && emitted >= maxPerDomain) break;
        // A short final page means we've exhausted this domain's prospects.
        if (prospects.length < PROSPECTS_PER_PAGE) break;
      }
    }
  }

  /** Best-effort company name for a domain (null if the lookup yields nothing). */
  private async fetchCompanyName(
    creds: SnovCredentials,
    tokenRef: TokenRef,
    domain: string,
    params: SyncContactsParams<SnovSourceConfig>,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/v2/domain-search/start?domain=${encodeURIComponent(domain)}`;
    const result = await this.withAuthRetry(creds, tokenRef, params, (token) =>
      this.pollTask(token, url, params),
    );
    const data = result['data'];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return nullIfBlank((data as Record<string, unknown>)['company_name'] as string);
    }
    return null;
  }

  /** One page of prospects for a domain (names/titles only — no emails yet). */
  private async fetchProspects(
    creds: SnovCredentials,
    tokenRef: TokenRef,
    domain: string,
    positions: string[] | undefined,
    page: number,
    params: SyncContactsParams<SnovSourceConfig>,
  ): Promise<SnovProspect[]> {
    const qs = new URLSearchParams();
    qs.set('domain', domain);
    qs.set('page', String(page));
    positions?.forEach((p) => qs.append('positions[]', p));
    const url = `${this.baseUrl}/v2/domain-search/prospects/start?${qs.toString()}`;
    const result = await this.withAuthRetry(creds, tokenRef, params, (token) =>
      this.pollTask(token, url, params),
    );
    return prospectsFrom(result);
  }

  /** Resolve one prospect's email via its ready-made search_emails_start URL. */
  private async resolveEmail(
    creds: SnovCredentials,
    tokenRef: TokenRef,
    prospect: SnovProspect,
    params: SyncContactsParams<SnovSourceConfig>,
  ): Promise<SnovEmailEntry | null> {
    const start = nullIfBlank(prospect.search_emails_start);
    if (!start) return null;
    // Snov hands back an absolute URL; honour it but keep traffic on our host.
    const url = start.startsWith('http') ? start : `${this.baseUrl}${start}`;
    const result = await this.withAuthRetry(creds, tokenRef, params, (token) =>
      this.pollTask(token, url, params),
    );
    return emailEntriesFrom(result)[0] ?? null;
  }

  /**
   * Run a Snov v2 async task: POST `…/start` → follow `links.result` → poll the
   * GET until HTTP 200 with a terminal status. `token` is the current Bearer.
   */
  private async pollTask(
    token: string,
    startUrl: string,
    hooks: BreakerHooks,
  ): Promise<Record<string, unknown>> {
    const start = await this.fetchJson('POST', startUrl, token, hooks);
    const link = resultLink(this.baseUrl, start.json);
    if (!link) return start.json;

    for (let i = 0; i < this.pollMaxTries; i++) {
      const r = await this.fetchJson('GET', link, token, hooks);
      // HTTP 200 = task done (even if empty); 202 = still processing.
      if (r.status === 200 && isTerminalStatus(statusOf(r.json))) {
        return r.json;
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error(`Snov task did not complete after ${this.pollMaxTries} polls`);
  }

  /** Run `fn` with the current token; on a 401 refresh once and retry. */
  private async withAuthRetry<T>(
    creds: SnovCredentials,
    tokenRef: TokenRef,
    params: SyncContactsParams<SnovSourceConfig> | undefined,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(tokenRef.value);
    } catch (err) {
      if (!(err instanceof SnovAuthError)) throw err;
      // Refresh the short-lived token once, then retry the operation.
      tokenRef.value = await this.getAccessToken(creds, params);
      try {
        return await fn(tokenRef.value);
      } catch (retryErr) {
        if (retryErr instanceof SnovAuthError) {
          // Still rejected after a fresh token → a real auth failure.
          await params?.onVendorFailure?.('auth_invalid');
          throw new Error('Snov rejected the credentials after a token refresh');
        }
        throw retryErr;
      }
    }
  }

  /** Exchange client credentials for a Bearer access token. */
  private async getAccessToken(
    creds: SnovCredentials,
    hooks?: BreakerHooks,
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    let response: Response;
    try {
      response = await this.rawFetch(`${this.baseUrl}${OAUTH_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (err) {
      await hooks?.onVendorFailure?.('server_5xx');
      throw new Error(`Snov token request failed: ${describeError(err)}`);
    }
    if (response.status === 401 || response.status === 400) {
      throw new Error('Snov rejected the API credentials');
    }
    if (response.status >= 500) {
      await hooks?.onVendorFailure?.('server_5xx');
      throw new Error(`Snov auth server error (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Snov auth HTTP ${response.status}`);
    }
    const json = (await response.json().catch(() => null)) as {
      access_token?: string;
    } | null;
    if (!json?.access_token) {
      throw new Error('Snov auth response had no access_token');
    }
    hooks?.onVendorSuccess?.();
    return json.access_token;
  }

  /**
   * Issue an authed request, mapping HTTP to breaker signals + typed errors.
   * Returns parsed JSON for any 2xx/4xx-non-auth; throws for auth/5xx/transport.
   */
  private async fetchJson(
    method: 'GET' | 'POST',
    url: string,
    token: string,
    hooks: BreakerHooks,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.rawFetch(url, {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      await hooks.onVendorFailure?.('server_5xx');
      throw new SnovServerError(`Snov request failed: ${describeError(err)}`);
    }
    if (response.status === 401 || response.status === 403) {
      // Don't report yet — withAuthRetry may recover via a token refresh.
      throw new SnovAuthError(`Snov auth rejected (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      await hooks.onVendorFailure?.('server_5xx');
      throw new SnovServerError(`Snov server error (HTTP ${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Snov HTTP ${response.status}` + (text ? `: ${text.slice(0, 200)}` : ''),
      );
    }
    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Snov returned a non-JSON response: ${describeError(err)}`);
    }
    hooks.onVendorSuccess?.();
    return { status: response.status, json };
  }

  /** Low-level fetch with an abort-based timeout. */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.httpFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The breaker callbacks an in-flight operation may signal. */
interface BreakerHooks {
  onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
  onVendorSuccess?: () => void;
}

/** Decode + validate the credentials envelope. Throws if either field is absent. */
function decodeSnovCreds(creds: DecryptedCredentials): SnovCredentials {
  const clientId = creds['clientId'];
  const clientSecret = creds['clientSecret'];
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('Snov credentials missing a non-empty clientId');
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim() === '') {
    throw new Error('Snov credentials missing a non-empty clientSecret');
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/** Normalize a user-entered domain (strip scheme/path/www) to a bare hostname. */
function normalizeDomain(input: string): string | null {
  const trimmed = input?.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  try {
    if (trimmed.includes('://') || trimmed.includes('/')) {
      host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
    }
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  // A bare hostname must contain a dot; reject obvious junk.
  return host.includes('.') ? host : null;
}

/** Find the poll URL inside a JSON:API `links` object (a value containing /result). */
function resultLink(baseUrl: string, resp: Record<string, unknown>): string | null {
  const links = resp['links'];
  if (links && typeof links === 'object') {
    for (const v of Object.values(links as Record<string, unknown>)) {
      if (typeof v === 'string' && v.includes('/result')) {
        return v.startsWith('http') ? v : `${baseUrl}${v}`;
      }
    }
  }
  return null;
}

/** Snov puts task state at `meta.status` (or top-level `status`). */
function statusOf(resp: Record<string, unknown>): string {
  const meta = resp['meta'] as Record<string, unknown> | undefined;
  return String(meta?.['status'] ?? resp['status'] ?? '');
}

/** A 200 with anything but in-progress/pending means the task is done. */
function isTerminalStatus(status: string): boolean {
  return status !== 'in_progress' && status !== 'pending';
}

/** Prospects live under `data` (array) or `data.prospects`. */
function prospectsFrom(result: Record<string, unknown>): SnovProspect[] {
  const data = result['data'];
  if (Array.isArray(data)) return data as SnovProspect[];
  const nested = (data as Record<string, unknown> | undefined)?.['prospects'];
  return Array.isArray(nested) ? (nested as SnovProspect[]) : [];
}

/** Email entries live under `data.emails` (or top-level `emails`). */
function emailEntriesFrom(result: Record<string, unknown>): SnovEmailEntry[] {
  const data = result['data'] as Record<string, unknown> | undefined;
  const fromData = data?.['emails'];
  if (Array.isArray(fromData)) return fromData as SnovEmailEntry[];
  const top = result['emails'];
  return Array.isArray(top) ? (top as SnovEmailEntry[]) : [];
}

/**
 * Down-convert one Snov prospect + resolved email to a NormalizedContact, or
 * null if no email was found. The full record (incl. smtp_status) is the
 * provenance payload — we import every status, labelled, not just verified.
 */
function toSnovContact(
  domain: string,
  company: string | null,
  prospect: SnovProspect,
  email: SnovEmailEntry | null,
): NormalizedContact | null {
  const emailRaw = nullIfBlank(email?.email);
  if (!emailRaw) return null;
  const linkedin = nullIfBlank(prospect.source_page);
  return {
    emailRaw,
    // Snov gives no stable person id; the LinkedIn URL is the best identifier,
    // falling back to the email itself.
    externalId: linkedin ?? emailRaw,
    externalUrl: linkedin ?? undefined,
    firstName: nullIfBlank(prospect.first_name),
    lastName: nullIfBlank(prospect.last_name),
    title: nullIfBlank(prospect.position),
    company,
    linkedinUrl: linkedin,
    emailVerification: mapSmtpStatus(email?.smtp_status),
    rawPayload: { prospect, email, domain },
  };
}

/**
 * Map Snov's `smtp_status` to the normalized verification signal.
 *   'valid'                          → verified (confirmed deliverable)
 *   'not_valid' / 'invalid'          → unverified (vendor says bad)
 *   'unknown' / 'greylisted' /       → unknown (catch-all or undeterminable)
 *   'accept_all' / absent
 */
function mapSmtpStatus(
  status: string | null | undefined,
): 'verified' | 'unverified' | 'unknown' {
  switch (nullIfBlank(status)?.toLowerCase()) {
    case 'valid':
      return 'verified';
    case 'not_valid':
    case 'invalid':
      return 'unverified';
    default:
      return 'unknown';
  }
}

/** The cursor is "<domainIndex>:<page>"; default to the first domain, page 1. */
function parseCursor(cursor: string | undefined): { domainIndex: number; page: number } {
  if (!cursor) return { domainIndex: 0, page: 1 };
  const [d, p] = cursor.split(':');
  const domainIndex = Number.parseInt(d ?? '', 10);
  const page = Number.parseInt(p ?? '', 10);
  return {
    domainIndex: Number.isInteger(domainIndex) && domainIndex >= 0 ? domainIndex : 0,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

/** Trim to a non-empty string, else null. */
function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Transport-error description, with a timeout called out distinctly. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'request timed out';
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The registry singleton — uses the default (global fetch) client. */
export const snovSourceAdapter = new SnovSourceAdapter();
