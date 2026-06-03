import type {
  AuthMode,
  ConnectorKind,
  DecryptedCredentials,
  NormalizedContact,
  PingResult,
  SourceAdapter,
  SyncContactsParams,
} from '@getbeyond/shared';
import {
  ZoomInfoAuthError,
  ZoomInfoClient,
  ZoomInfoServerError,
  type ZoomInfoDocument,
} from './zoominfo.source';

/**
 * ZoomInfo source adapter (contacts-with-emails path) — per-org BYO.
 *
 * Wraps the quarantined {@link ZoomInfoClient}. ZoomInfo is a two-step flow like
 * Apollo: Contact Search finds people at a company (by NAME — ZoomInfo keys
 * contact search on companyName, not domain) returning `personId`s + reachability
 * flags but NO email; then Contact Enrich resolves the real email (credit-
 * consuming) with a per-match `meta.matchStatus` we map to the normalized
 * `emailVerification` signal.
 *
 * Auth: `byo_key` — each org pastes its ZoomInfo `clientId` + `clientSecret`,
 * stored encrypted on `ConnectorAccount`. A fresh `ZoomInfoClient` is built per
 * call from the decrypted creds (the adapter singleton holds none); a test
 * factory lets unit tests inject a fake client.
 *
 * SDK quarantine (invariant #5): all ZoomInfo HTTP lives in `zoominfo.source.ts`
 * (the client) and this file. Nothing else imports the vendor surface.
 */

/** Credentials envelope this adapter persists + consumes. */
export interface ZoomInfoCredentials {
  clientId: string;
  clientSecret: string;
}

/** Caller config — the company to source contacts at + an optional title filter. */
export interface ZoomInfoSourceConfig {
  /** Company NAME (ZoomInfo's contact-search key). Required. */
  companyName: string;
  /** Optional job-title filter. */
  positions?: string[];
  /** Hard cap on contacts emitted. Defaults to no cap. */
  maxContacts?: number;
}

/** The slice of ZoomInfoClient this adapter drives (eases test injection). */
export interface ZoomInfoClientLike {
  ping(): Promise<{ ok: boolean; error?: string }>;
  searchContacts(
    attributes: Record<string, unknown>,
    opts?: { page?: number; pageSize?: number },
  ): Promise<ZoomInfoDocument>;
  enrichContacts(
    matches: Array<Record<string, unknown>>,
    outputFields: string[],
  ): Promise<ZoomInfoDocument>;
}

export interface ZoomInfoSourceAdapterDeps {
  /** Builds a client from per-org creds. Default: a real ZoomInfoClient. */
  clientFactory?: (creds: ZoomInfoCredentials) => ZoomInfoClientLike;
  /** Contacts fetched per search page. Default 25 (ZoomInfo's default). */
  pageSize?: number;
  /** Hard page ceiling, guards an unbounded loop. Default 40 (≈1000 contacts). */
  maxPages?: number;
  /** Enrich batch size (matchPersonInput cap per call). Default 25. */
  enrichBatchSize?: number;
}

/**
 * Output fields we ask ZoomInfo to enrich (the columns we map to a contact).
 * Verified against the live API (2026-06): `linkedInUrl` is NOT an allowed
 * field on the GTM plan (400 "Invalid field 'linkedinurl'"), so it's omitted —
 * ZoomInfo-sourced contacts have no LinkedIn URL. Requesting `companyName`
 * returns a nested `company:{id,name}` object (see toNormalizedContact).
 */
const ENRICH_FIELDS = ['firstName', 'lastName', 'jobTitle', 'email', 'companyName'];

export class ZoomInfoSourceAdapter
  implements SourceAdapter<ZoomInfoSourceConfig>
{
  readonly kind: ConnectorKind = 'zoominfo';
  readonly authMode: AuthMode = 'byo_key';

  private readonly clientFactory: (creds: ZoomInfoCredentials) => ZoomInfoClientLike;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly enrichBatchSize: number;

  constructor(deps: ZoomInfoSourceAdapterDeps = {}) {
    this.clientFactory =
      deps.clientFactory ??
      ((creds) =>
        new ZoomInfoClient({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        }));
    this.pageSize = deps.pageSize ?? 25;
    this.maxPages = deps.maxPages ?? 40;
    this.enrichBatchSize = deps.enrichBatchSize ?? 25;
  }

  async ping(creds: DecryptedCredentials): Promise<PingResult> {
    try {
      const result = await this.clientFactory(decodeCreds(creds)).ping();
      return result.ok
        ? { ok: true, scopes: [] }
        : { ok: false, scopes: [], error: result.error ?? 'ZoomInfo rejected the credentials' };
    } catch (err) {
      return { ok: false, scopes: [], error: describeError(err) };
    }
  }

  async *syncContacts(
    params: SyncContactsParams<ZoomInfoSourceConfig>,
  ): AsyncIterable<NormalizedContact> {
    const creds = decodeCreds(params.creds);
    const companyName = params.config.companyName?.trim();
    if (!companyName) return; // ZoomInfo contact search needs a company name.
    const client = this.clientFactory(creds);
    const maxContacts = params.config.maxContacts;
    const jobTitle = params.config.positions?.find((p) => p.trim().length > 0);

    let emitted = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const search = await this.run(
        () =>
          client.searchContacts(
            { companyName, ...(jobTitle ? { jobTitle } : {}) },
            { page, pageSize: this.pageSize },
          ),
        params,
      );
      const rows = asArray(search.data);
      if (rows.length === 0) return;

      // Harvest personIds for the enrich step.
      const ids = rows
        .map((r) => personIdOf(r))
        .filter((id): id is number => id !== null);
      if (ids.length === 0) {
        if (rows.length < this.pageSize) return;
        continue;
      }

      for (const batch of chunk(ids, this.enrichBatchSize)) {
        const enriched = await this.run(
          () =>
            client.enrichContacts(
              batch.map((personId) => ({ personId })),
              ENRICH_FIELDS,
            ),
          params,
        );
        for (const match of asArray(enriched.data)) {
          const contact = toNormalizedContact(match);
          if (!contact) continue;
          yield contact;
          emitted += 1;
          if (maxContacts !== undefined && emitted >= maxContacts) return;
        }
      }

      // A short page means we've exhausted this company's contacts.
      if (rows.length < this.pageSize) return;
    }
  }

  /** Run a client call, mapping ZoomInfo's typed errors to the breaker hooks. */
  private async run<T>(
    fn: () => Promise<T>,
    hooks: {
      onVendorFailure?: (kind: 'server_5xx' | 'auth_invalid') => Promise<void>;
      onVendorSuccess?: () => void;
    },
  ): Promise<T> {
    try {
      const result = await fn();
      hooks.onVendorSuccess?.();
      return result;
    } catch (err) {
      if (err instanceof ZoomInfoAuthError) {
        await hooks.onVendorFailure?.('auth_invalid');
      } else if (err instanceof ZoomInfoServerError) {
        await hooks.onVendorFailure?.('server_5xx');
      }
      throw err;
    }
  }
}

/** Decode + validate the credentials envelope. */
function decodeCreds(creds: DecryptedCredentials): ZoomInfoCredentials {
  const clientId = creds['clientId'];
  const clientSecret = creds['clientSecret'];
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('ZoomInfo credentials missing a non-empty clientId');
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim() === '') {
    throw new Error('ZoomInfo credentials missing a non-empty clientSecret');
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/** JSON:API resources put their stable id at the top level; ZoomInfo's is the personId. */
function personIdOf(row: unknown): number | null {
  if (!row || typeof row !== 'object') return null;
  const id = (row as Record<string, unknown>)['id'];
  const n = typeof id === 'number' ? id : Number.parseInt(String(id ?? ''), 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * Down-convert one enriched ZoomInfo match to a NormalizedContact, or null when
 * no email resolved. Fields live under `attributes`; the per-match
 * `meta.matchStatus` is mapped to the normalized verification signal.
 */
function toNormalizedContact(match: unknown): NormalizedContact | null {
  if (!match || typeof match !== 'object') return null;
  const obj = match as Record<string, unknown>;
  const attrs = (obj['attributes'] as Record<string, unknown> | undefined) ?? {};
  const meta = (obj['meta'] as Record<string, unknown> | undefined) ?? {};

  const emailRaw = nullIfBlank(attrs['email'] as string | undefined);
  if (!emailRaw) return null;

  // ZoomInfo's GTM plan exposes no LinkedIn URL; identity falls back to the
  // personId (stable) then email. Company name arrives nested under `company`.
  const externalId = personIdOf(obj);
  const company = attrs['company'] as { name?: unknown } | undefined;

  return {
    emailRaw,
    externalId: externalId !== null ? String(externalId) : emailRaw,
    firstName: nullIfBlank(attrs['firstName'] as string | undefined),
    lastName: nullIfBlank(attrs['lastName'] as string | undefined),
    title: nullIfBlank(attrs['jobTitle'] as string | undefined),
    company: nullIfBlank(company?.name as string | undefined),
    linkedinUrl: null,
    emailVerification: mapMatchStatus(meta['matchStatus'] as string | undefined),
    rawPayload: match,
  };
}

/**
 * Map ZoomInfo's `meta.matchStatus` to the normalized verification signal.
 *   FULL_MATCH        → verified
 *   NO_MATCH          → unverified (we still got a guessed email)
 *   anything else / absent → unknown
 */
function mapMatchStatus(
  status: string | null | undefined,
): 'verified' | 'unverified' | 'unknown' {
  switch (nullIfBlank(status)?.toUpperCase()) {
    case 'FULL_MATCH':
      return 'verified';
    case 'NO_MATCH':
      return 'unverified';
    default:
      return 'unknown';
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The registry singleton — builds a real ZoomInfoClient per call. */
export const zoominfoSourceAdapter = new ZoomInfoSourceAdapter();
