import type {
  ProspectSearchDetailResponse,
  ProspectSearchListResponse,
  ContactListsResponse,
  CreateProspectSearchRequest,
  CreateProspectSearchResponse,
  LlmSettingsResponse,
  ResearcherRunEnqueueResponse,
  ResearcherRunRequest,
  ResearcherRunStatusResponse,
  SaveLlmCredentialRequest,
  SaveLlmCredentialResponse,
  SaveLlmRoutingRequest,
  TestLlmCredentialResponse,
  SaveSourcingSettingsRequest,
  SourcingSettingsResponse,
  SdrDrafterRunEnqueueResponse,
  SdrDrafterRunRequest,
  SdrDrafterRunStatusResponse,
  TeammateRoutingConfig,
} from '@getbeyond/shared';
import { env } from './env';

/**
 * Typed wrappers around the API endpoints we use from the web client.
 *
 * Direct fetch (no react-query / swr yet) — the two endpoints we call are
 * simple enough that hand-rolled functions are clearer than wiring a query
 * cache. Add a query lib when we have a list view + need de-dup / refetch.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}

async function readError(response: Response): Promise<never> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // ignore
  }
  throw new ApiError(response.status, body);
}

export async function postResearchRun(
  payload: ResearcherRunRequest,
): Promise<ResearcherRunEnqueueResponse> {
  const response = await fetch(`${env.apiUrl}/teammates/researcher/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    // Session cookie rides along on every API call; CORS is configured to
    // allow credentials on the API side (CORS_ORIGIN env var).
    credentials: 'include',
  });
  if (!response.ok) await readError(response);
  return response.json() as Promise<ResearcherRunEnqueueResponse>;
}

export async function getResearchRun(
  runId: string,
): Promise<ResearcherRunStatusResponse> {
  const url = `${env.apiUrl}/teammates/researcher/runs/${encodeURIComponent(runId)}`;
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) await readError(response);
  return response.json() as Promise<ResearcherRunStatusResponse>;
}

export function buildResearchStreamUrl(runId: string): string {
  return `${env.apiUrl}/teammates/researcher/runs/${encodeURIComponent(runId)}/stream`;
}

// ─── SDR Drafter ──────────────────────────────────────────────────────────

export interface ContactLookupResponse {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
}

export async function lookupContactByEmail(
  email: string,
): Promise<ContactLookupResponse> {
  const url = new URL(`${env.apiUrl}/contacts/lookup`);
  url.searchParams.set('email', email);
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ContactLookupResponse>;
}

// ─── Contacts list ────────────────────────────────────────────────────────

export interface ContactListItem {
  id: string;
  primaryEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  updatedAt: string;
}

export interface ContactListResponse {
  items: ContactListItem[];
  total: number;
  limit: number;
  offset: number;
}

export async function listContacts(params?: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<ContactListResponse> {
  const url = new URL(`${env.apiUrl}/contacts`);
  if (params?.q) url.searchParams.set('q', params.q);
  if (params?.limit !== undefined)
    url.searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined)
    url.searchParams.set('offset', String(params.offset));
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ContactListResponse>;
}

// ─── Contact lists (prospectSearch source / wins pickers) ─────────────────────────
//
// Powers the prospectSearch composer's source + wins pickers: the user selects an
// imported list instead of pasting a raw id. CSV-imported and HubSpot-synced
// lists both appear, distinguished by `source`.

export async function listContactLists(): Promise<ContactListsResponse> {
  const res = await fetch(`${env.apiUrl}/contacts/lists`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ContactListsResponse>;
}

// ─── Drafts inbox ─────────────────────────────────────────────────────────

export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'sent'
  | 'partial'
  | 'failed';

export type DraftType =
  | 'email'
  | 'linkedin_dm'
  | 'linkedin_post'
  | 'twitter_post'
  | 'research_brief';

export interface DraftListItem {
  id: string;
  teammate: string;
  type: DraftType;
  status: DraftStatus;
  recipient: unknown;
  contentPreview: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftListResponse {
  items: DraftListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface DraftDetailClaim {
  id: string;
  text: string;
  abstained: boolean;
  confidence: number | null;
  citation: {
    id: string;
    url: string;
    title: string | null;
    excerpt: string | null;
  } | null;
}

export interface DraftDetailResponse {
  id: string;
  teammate: string;
  type: DraftType;
  status: DraftStatus;
  recipient: unknown;
  content: unknown;
  runId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  scheduledFor: string | null;
  postedAt: string | null;
  createdAt: string;
  updatedAt: string;
  claims: DraftDetailClaim[];
}

export async function listDrafts(params?: {
  status?: DraftStatus;
  teammate?: string;
  type?: DraftType;
  limit?: number;
  offset?: number;
}): Promise<DraftListResponse> {
  const url = new URL(`${env.apiUrl}/drafts`);
  if (params?.status) url.searchParams.set('status', params.status);
  if (params?.teammate) url.searchParams.set('teammate', params.teammate);
  if (params?.type) url.searchParams.set('type', params.type);
  if (params?.limit !== undefined)
    url.searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined)
    url.searchParams.set('offset', String(params.offset));
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) await readError(res);
  return res.json() as Promise<DraftListResponse>;
}

export async function getDraft(id: string): Promise<DraftDetailResponse> {
  const res = await fetch(`${env.apiUrl}/drafts/${encodeURIComponent(id)}`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<DraftDetailResponse>;
}

// ─── CSV import ───────────────────────────────────────────────────────────

export interface CsvAccountResponse {
  id: string;
}

export interface CsvColumnMapping {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company?: string;
  linkedinUrl?: string;
}

export interface CsvImportEnqueueResponse {
  syncRunId: string;
  status: 'running';
}

export interface CsvSyncRunStatusResponse {
  syncRunId: string;
  status: 'running' | 'completed' | 'failed';
  recordsIn: number;
  recordsOut: number;
  errorCount: number;
  errors: Array<{ row: number; reason: string; message: string }>;
}

export async function ensureCsvAccount(): Promise<CsvAccountResponse> {
  const res = await fetch(`${env.apiUrl}/connectors/csv/account`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<CsvAccountResponse>;
}

export async function submitCsvImport(args: {
  file: File;
  sourceAccountId: string;
  columnMapping: CsvColumnMapping;
}): Promise<CsvImportEnqueueResponse> {
  const form = new FormData();
  form.append('file', args.file, args.file.name);
  form.append(
    'metadata',
    JSON.stringify({
      sourceAccountId: args.sourceAccountId,
      columnMapping: args.columnMapping,
    }),
  );
  const res = await fetch(`${env.apiUrl}/connectors/csv/import`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<CsvImportEnqueueResponse>;
}

export interface ApolloAccountStatus {
  /** False on getbeyond Cloud — Apollo discovery is self-host-only. */
  available: boolean;
  connected: boolean;
  status?: string;
}

/** Current Apollo connection state for the org. */
export async function getApolloStatus(): Promise<ApolloAccountStatus> {
  const res = await fetch(`${env.apiUrl}/connectors/apollo/account`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ApolloAccountStatus>;
}

/** Validate + persist an Apollo BYO API key. Throws ApiError(400) on a bad key. */
export async function connectApollo(
  apiKey: string,
): Promise<{ id: string; status: 'connected' }> {
  const res = await fetch(`${env.apiUrl}/connectors/apollo/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<{ id: string; status: 'connected' }>;
}

export interface PdlAccountStatus {
  /** Today always true (PDL is allowed in all modes); false would hide the card. */
  available: boolean;
  connected: boolean;
  status?: string;
}

/** Current PDL (People Data Labs) connection state for the org. */
export async function getPdlStatus(): Promise<PdlAccountStatus> {
  const res = await fetch(`${env.apiUrl}/connectors/pdl/account`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<PdlAccountStatus>;
}

/** Validate + persist a PDL BYO API key. Throws ApiError(400) on a bad key. */
export async function connectPdl(
  apiKey: string,
): Promise<{ id: string; status: 'connected' }> {
  const res = await fetch(`${env.apiUrl}/connectors/pdl/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<{ id: string; status: 'connected' }>;
}

export interface SnovAccountStatus {
  connected: boolean;
  status?: string;
}

/** Current Snov connection state for the org. */
export async function getSnovStatus(): Promise<SnovAccountStatus> {
  const res = await fetch(`${env.apiUrl}/connectors/snov/account`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SnovAccountStatus>;
}

/** Validate + persist Snov BYO credentials. Throws ApiError(400) on bad creds. */
export async function connectSnov(
  clientId: string,
  clientSecret: string,
): Promise<{ id: string; status: 'connected' }> {
  const res = await fetch(`${env.apiUrl}/connectors/snov/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<{ id: string; status: 'connected' }>;
}

export interface ZoomInfoAccountStatus {
  connected: boolean;
  status?: string;
}

/** Current ZoomInfo connection state for the org. */
export async function getZoomInfoStatus(): Promise<ZoomInfoAccountStatus> {
  const res = await fetch(`${env.apiUrl}/connectors/zoominfo/account`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ZoomInfoAccountStatus>;
}

/** Validate + persist ZoomInfo BYO credentials. Throws ApiError(400) on bad creds. */
export async function connectZoomInfo(
  clientId: string,
  clientSecret: string,
): Promise<{ id: string; status: 'connected' }> {
  const res = await fetch(`${env.apiUrl}/connectors/zoominfo/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<{ id: string; status: 'connected' }>;
}

export async function getCsvSyncRun(
  syncRunId: string,
): Promise<CsvSyncRunStatusResponse> {
  const res = await fetch(
    `${env.apiUrl}/connectors/csv/sync-runs/${encodeURIComponent(syncRunId)}`,
    { credentials: 'include' },
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<CsvSyncRunStatusResponse>;
}

export async function postSdrDrafterRun(
  payload: SdrDrafterRunRequest,
): Promise<SdrDrafterRunEnqueueResponse> {
  const res = await fetch(`${env.apiUrl}/teammates/sdr-drafter/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SdrDrafterRunEnqueueResponse>;
}

export async function getSdrDrafterRun(
  runId: string,
): Promise<SdrDrafterRunStatusResponse> {
  const url = `${env.apiUrl}/teammates/sdr-drafter/runs/${encodeURIComponent(runId)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SdrDrafterRunStatusResponse>;
}

export function buildSdrDrafterStreamUrl(runId: string): string {
  return `${env.apiUrl}/teammates/sdr-drafter/runs/${encodeURIComponent(runId)}/stream`;
}

// ─── ProspectSearches (lookalike sourcing) ─────────────────────────────────────────
//
// A prospectSearch derives an ICP from a wins list, sources a prospect pool, then
// qualifies + ranks each prospect. The detail/list shapes plus the SSE event
// union live in @getbeyond/shared so the client binds to the typed contract.

export async function createProspectSearch(
  payload: CreateProspectSearchRequest,
): Promise<CreateProspectSearchResponse> {
  const res = await fetch(`${env.apiUrl}/prospect-searches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<CreateProspectSearchResponse>;
}

/**
 * Re-run a prospectSearch: clones its config into a new prospectSearch and enqueues a fresh
 * run. Returns the NEW prospectSearch id, which the caller navigates to.
 */
export async function rerunProspectSearch(
  id: string,
): Promise<CreateProspectSearchResponse> {
  const res = await fetch(
    `${env.apiUrl}/prospect-searches/${encodeURIComponent(id)}/rerun`,
    { method: 'POST', credentials: 'include' },
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<CreateProspectSearchResponse>;
}

export async function listProspectSearches(): Promise<ProspectSearchListResponse> {
  const res = await fetch(`${env.apiUrl}/prospect-searches`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<ProspectSearchListResponse>;
}

export async function getProspectSearch(
  id: string,
): Promise<ProspectSearchDetailResponse> {
  const res = await fetch(
    `${env.apiUrl}/prospect-searches/${encodeURIComponent(id)}`,
    { credentials: 'include' },
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<ProspectSearchDetailResponse>;
}

export function buildProspectSearchStreamUrl(id: string): string {
  return `${env.apiUrl}/prospect-searches/${encodeURIComponent(id)}/stream`;
}

// ─── Org / invites / members ──────────────────────────────────────────────

export type MemberRole = 'owner' | 'admin' | 'member';
export type InviteRole = 'admin' | 'member';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  role: MemberRole;
  joinedAt: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: MemberRole;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  invitedByEmail: string;
}

export interface InviteLookupResponse {
  status: InviteStatus;
  orgName: string | null;
  role: MemberRole;
  invitedEmail: string;
  expiresAt: string;
}

export async function listMembers(): Promise<MemberSummary[]> {
  const res = await fetch(`${env.apiUrl}/org/members`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<MemberSummary[]>;
}

export async function listInvites(): Promise<InviteSummary[]> {
  const res = await fetch(`${env.apiUrl}/org/invites`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<InviteSummary[]>;
}

export async function createInvite(payload: {
  email: string;
  role: InviteRole;
}): Promise<InviteSummary> {
  const res = await fetch(`${env.apiUrl}/org/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<InviteSummary>;
}

export async function revokeInvite(id: string): Promise<void> {
  const res = await fetch(
    `${env.apiUrl}/org/invites/${encodeURIComponent(id)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) await readError(res);
}

export async function lookupInvite(
  token: string,
): Promise<InviteLookupResponse> {
  const res = await fetch(
    `${env.apiUrl}/invite/${encodeURIComponent(token)}/lookup`,
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<InviteLookupResponse>;
}

export async function acceptInvite(
  token: string,
): Promise<{ orgId: string; role: MemberRole }> {
  const res = await fetch(
    `${env.apiUrl}/invite/${encodeURIComponent(token)}/accept`,
    { method: 'POST', credentials: 'include' },
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<{ orgId: string; role: MemberRole }>;
}

// ─── Me / active org ──────────────────────────────────────────────────────

export interface MeResponse {
  userId: string;
  email: string;
  activeOrgId: string;
  orgs: Array<{ id: string; name: string | null; role: MemberRole }>;
}

export async function getMe(): Promise<MeResponse> {
  const res = await fetch(`${env.apiUrl}/me`, { credentials: 'include' });
  if (!res.ok) await readError(res);
  return res.json() as Promise<MeResponse>;
}

export async function switchActiveOrg(orgId: string): Promise<MeResponse> {
  const res = await fetch(`${env.apiUrl}/me/active-org`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ orgId }),
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<MeResponse>;
}

// ─── LLM settings (BYO-key) ─────────────────────────────────────────────────
//
// The org brings its own provider key and routes each teammate to a
// provider/model. The API NEVER returns a stored key — only whether one is
// configured (status), so nothing here ever surfaces a secret.

export async function getLlmSettings(): Promise<LlmSettingsResponse> {
  const res = await fetch(`${env.apiUrl}/settings/llm`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<LlmSettingsResponse>;
}

export async function saveLlmCredential(
  req: SaveLlmCredentialRequest,
): Promise<SaveLlmCredentialResponse> {
  const res = await fetch(`${env.apiUrl}/settings/llm/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SaveLlmCredentialResponse>;
}

/**
 * Live-verify the stored key for a provider. An invalid key returns a normal
 * `{ ok: false, error }` verdict (HTTP 200) — only a bad provider name throws.
 */
export async function testLlmCredential(
  provider: string,
): Promise<TestLlmCredentialResponse> {
  const res = await fetch(
    `${env.apiUrl}/settings/llm/credentials/${encodeURIComponent(provider)}/test`,
    { method: 'POST', credentials: 'include' },
  );
  if (!res.ok) await readError(res);
  return res.json() as Promise<TestLlmCredentialResponse>;
}

export async function saveLlmRouting(
  req: SaveLlmRoutingRequest,
): Promise<TeammateRoutingConfig> {
  const res = await fetch(`${env.apiUrl}/settings/llm/routing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<TeammateRoutingConfig>;
}

// ─── Sourcing settings (Stage 5 contact waterfall) ──────────────────────────
//
// Per-org connector priority + verification threshold for the contact-sourcing
// waterfall. GET reports the org's effective config (defaults when unset);
// PUT upserts it.

export async function getSourcingSettings(): Promise<SourcingSettingsResponse> {
  const res = await fetch(`${env.apiUrl}/settings/sourcing`, {
    credentials: 'include',
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SourcingSettingsResponse>;
}

export async function saveSourcingSettings(
  req: SaveSourcingSettingsRequest,
): Promise<SourcingSettingsResponse> {
  const res = await fetch(`${env.apiUrl}/settings/sourcing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });
  if (!res.ok) await readError(res);
  return res.json() as Promise<SourcingSettingsResponse>;
}
