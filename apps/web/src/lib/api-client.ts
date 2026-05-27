import type {
  ResearcherRunEnqueueResponse,
  ResearcherRunRequest,
  ResearcherRunStatusResponse,
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
