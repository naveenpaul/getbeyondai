/**
 * Adapter contracts (eng-review pass-2 D1 + adapter architecture section).
 *
 * Two interfaces define the entire vendor surface of getbeyond. Anything that
 * pulls contacts in implements `SourceAdapter`; anything that writes back out
 * (send email, log activity, update CRM field) implements `DestinationAdapter`.
 *
 * Adding a new source = one file implementing `SourceAdapter`, one registry
 * line. Adding a new destination = one file implementing `DestinationAdapter`,
 * one registry line. Zero changes to teammates, data model, or UI.
 *
 * Architecture invariants enforced by dependency-cruiser:
 *   - Adapters cannot import teammate code.
 *   - Teammates cannot import adapter code.
 *   - Vendor SDKs (`@hubspot/api-client`, `jsforce`, etc.) live only inside
 *     the matching adapter file.
 *
 * MIT-licensed package: closed-source embedders can implement adapters
 * against these contracts without taking on AGPLv3 obligations.
 */

// ─── Enums (mirror Prisma's generated enums for cross-package safety) ────────

export type ConnectorKind =
  | 'hubspot'
  | 'salesforce'
  | 'apollo'
  | 'zoominfo'
  | 'csv';

export type AuthMode = 'oauth' | 'byo_key' | 'upload';

export type DraftActionKind =
  | 'send_email'
  | 'post_linkedin'
  | 'post_twitter'
  | 'crm_log_activity'
  | 'crm_update_field'
  | 'archive';

// ─── Credentials (encrypted at rest; decrypted only inside adapter boundary) ─

/**
 * The decrypted credentials envelope passed to an adapter. Vendor-specific
 * shapes (HubSpot {accessToken, refreshToken, ...}, Apollo {apiKey}, etc.)
 * are cast inside the adapter. The runtime never reads individual fields.
 *
 * NEVER serialize this object into logs, errors, audit trails, or responses.
 * The CredentialManager handles the lifecycle; adapters consume + return.
 */
export interface DecryptedCredentials {
  readonly [key: string]: unknown;
}

/**
 * Returned by an adapter when its action causes the vendor to rotate a token
 * (OAuth refresh). The runtime persists the new envelope under CAS on
 * `ConnectorAccount.credentialsVersion`.
 */
export interface CredentialUpdate {
  next: DecryptedCredentials;
  /** UTC ISO-8601 when these credentials expire (or null if never). */
  expiresAt: string | null;
}

// ─── Source adapters (read: pull contacts in) ────────────────────────────────

/** OAuth flow setup. Returned by adapter, consumed by the auth controller. */
export interface OAuthStart {
  authUrl: string;
  /** Adapter-controlled state token. The runtime stores it and verifies on completion. */
  state: string;
}

/** Result of a connection ping. */
export interface PingResult {
  ok: boolean;
  scopes: string[];
  /** Populated on failure; never include credentials in this string. */
  error?: string;
}

/**
 * A discoverable source-list option (HubSpot list, Salesforce report, Apollo
 * saved search, ...). Surfaces in the UI dropdown when a user picks what to sync.
 */
export interface SourceOption {
  /** Vendor-side identifier (list ID, report ID, search ID, ...). */
  id: string;
  kind: 'list' | 'search' | 'view' | 'file';
  name: string;
  /** Optional estimated record count. Adapters that can't cheaply count it omit. */
  itemCount?: number;
}

/**
 * A contact in the canonical pre-Prisma shape. Adapters normalize their
 * vendor payload to this; the contact-upsert layer takes it from here.
 */
export interface NormalizedContact {
  /** Raw email as the vendor reported it. The runtime normalizes (lowercase, +strip). */
  emailRaw: string;
  /** Vendor-side identifier for this contact. Stable across syncs. */
  externalId: string;
  /** Direct link to the contact in the vendor UI, if available. */
  externalUrl?: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  /** The full vendor record. Stored as ContactSource.rawPayload (may spill to S3 at >10KB). */
  rawPayload: unknown;
}

export interface SyncContactsParams<TConfig> {
  creds: DecryptedCredentials;
  /** Adapter-specific config (list ID, search query, file ref). */
  config: TConfig;
  /**
   * Resume cursor from a prior partial sync. Adapters that paginate persist
   * their next-page token here; on retry the runtime hands it back.
   */
  cursor?: string;
}

/**
 * SourceAdapter — read contacts from a vendor.
 *
 * Async iteration is the unit of streaming: adapters yield NormalizedContacts
 * one at a time so the runtime can batch upserts without loading everything
 * into memory. A 25k Apollo search yields 25k times.
 *
 * If the adapter rotates credentials mid-sync (HubSpot OAuth refresh), it
 * returns a CredentialUpdate sentinel via a side channel (TBD in T3b — likely
 * an event emitter or a Symbol yield); the runtime persists under CAS.
 */
export interface SourceAdapter<TConfig = unknown> {
  readonly kind: ConnectorKind;
  readonly authMode: AuthMode;

  /** OAuth-only. Builds the consent URL; runtime persists state and redirects. */
  startOAuth?(redirectUri: string): OAuthStart;

  /** OAuth-only. Exchanges the code for credentials. State already verified. */
  completeOAuth?(code: string, state: string): Promise<DecryptedCredentials>;

  /** Verify the connection works. Cheap to call. Used at setup + on schedule. */
  ping(creds: DecryptedCredentials): Promise<PingResult>;

  /** List the user-pickable sources (HubSpot lists, Apollo searches, ...). */
  listSources?(creds: DecryptedCredentials): Promise<SourceOption[]>;

  /** Stream NormalizedContacts. Cursor-resumable. */
  syncContacts(params: SyncContactsParams<TConfig>): AsyncIterable<NormalizedContact>;
}

// ─── Destination adapters (write: send + post + CRM write-back) ──────────────

export interface ExecuteResult {
  status: 'succeeded' | 'failed';
  /** ID returned by the vendor (email message ID, HubSpot Engagement ID, ...). */
  externalId?: string;
  /** The raw vendor response. Stored on DraftAction.responsePayload. */
  responsePayload: unknown;
  /** If false, runtime moves to dead-letter without further retries (e.g. 4xx user errors). */
  retryable?: boolean;
  /** Error description for the audit log. NEVER include credentials. */
  error?: string;
}

export interface ExecuteParams<TAction> {
  creds: DecryptedCredentials;
  action: TAction;
  /** Idempotency key from DraftAction.idempotencyKey — pass to vendor when supported. */
  idempotencyKey: string;
  contactId: string;
  contactExternalId?: string;
}

/**
 * DestinationAdapter — execute an approved DraftAction. The runtime hands the
 * adapter a payload shaped to one of its declared `supports[]` kinds; the
 * adapter calls the vendor and returns the outcome.
 */
export interface DestinationAdapter<TAction = unknown> {
  /** Unique destination identifier — gmail, resend, hubspot, salesforce, linkedin-ext, ... */
  readonly kind: string;
  /** Which DraftAction.kind values this adapter handles. */
  readonly supports: readonly DraftActionKind[];

  execute(params: ExecuteParams<TAction>): Promise<ExecuteResult>;
}
