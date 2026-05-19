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
  orgId: string,
): Promise<ResearcherRunStatusResponse> {
  const url = new URL(
    `${env.apiUrl}/teammates/researcher/runs/${encodeURIComponent(runId)}`,
  );
  url.searchParams.set('orgId', orgId);
  const response = await fetch(url.toString(), { credentials: 'include' });
  if (!response.ok) await readError(response);
  return response.json() as Promise<ResearcherRunStatusResponse>;
}

/**
 * Build the SSE URL for a run. The component opens an EventSource on this
 * URL; EventSource doesn't support custom headers so the orgId rides as a
 * query param (same pattern as the rest of the pre-auth endpoints).
 */
export function buildResearchStreamUrl(runId: string, orgId: string): string {
  const url = new URL(
    `${env.apiUrl}/teammates/researcher/runs/${encodeURIComponent(runId)}/stream`,
  );
  url.searchParams.set('orgId', orgId);
  return url.toString();
}
