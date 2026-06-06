import type {
  ProspectSearchEvent,
  DiscoveredCompany,
  IcpSummary,
  QualifiedProspect,
  RunEvent,
} from '@getbeyond/shared';
import { TERMINAL_PROSPECT_SEARCH_EVENT_TYPES } from '@getbeyond/shared';

/**
 * Typed factory helpers for the prospectSearch SSE event union.
 *
 * The orchestrator emits these at each pipeline phase; `tool_activity` wraps an
 * underlying Researcher `RunEvent` so the chat can render the granular tool
 * calls live (architecture: the chat shows "what's being run").
 *
 * Centralizing construction here keeps `at` stamping consistent and the
 * discriminated-union shapes correct in one place (the contract lives in
 * @getbeyond/shared; these builders are the API-side mapping onto it).
 */
export type EmitProspectSearchEvent = (event: ProspectSearchEvent) => void;

function nowIso(): string {
  return new Date().toISOString();
}

export function searchStarted(
  prospectSearchId: string,
  goal: string,
): ProspectSearchEvent {
  return { type: 'search_started', prospectSearchId, at: nowIso(), data: { goal } };
}

export function icpDerived(
  prospectSearchId: string,
  icp: IcpSummary,
): ProspectSearchEvent {
  return { type: 'icp_derived', prospectSearchId, at: nowIso(), data: { icp } };
}

export function sourcingStarted(
  prospectSearchId: string,
  provider: string,
): ProspectSearchEvent {
  return {
    type: 'sourcing_started',
    prospectSearchId,
    at: nowIso(),
    data: { provider },
  };
}

export function sourcingCompleted(
  prospectSearchId: string,
  summary: string,
  prospectCount: number,
): ProspectSearchEvent {
  return {
    type: 'sourcing_completed',
    prospectSearchId,
    at: nowIso(),
    data: { summary, prospectCount },
  };
}

export function companiesDiscovered(
  prospectSearchId: string,
  companies: DiscoveredCompany[],
  total: number,
): ProspectSearchEvent {
  return {
    type: 'companies_discovered',
    prospectSearchId,
    at: nowIso(),
    data: { companies, total },
  };
}

export function prospectQualified(
  prospectSearchId: string,
  prospect: QualifiedProspect,
  index: number,
  total: number,
): ProspectSearchEvent {
  return {
    type: 'prospect_qualified',
    prospectSearchId,
    at: nowIso(),
    data: { prospect, index, total },
  };
}

export function searchCompleted(
  prospectSearchId: string,
  prospectCount: number,
  costCents: number,
): ProspectSearchEvent {
  return {
    type: 'search_completed',
    prospectSearchId,
    at: nowIso(),
    data: { prospectCount, costCents },
  };
}

export function searchFailed(
  prospectSearchId: string,
  message: string,
): ProspectSearchEvent {
  return {
    type: 'search_failed',
    prospectSearchId,
    at: nowIso(),
    data: { message },
  };
}

/**
 * Wrap an underlying teammate `RunEvent` as a prospectSearch `tool_activity` event so
 * the chat's "connected tools" view sees the granular model/tool calls of the
 * Researcher runs the orchestrator drives. `at` is stamped fresh (the moment
 * the orchestrator forwarded it) so the prospectSearch stream stays monotonic even if
 * a RunEvent's own `at` lags.
 */
export function toolActivity(
  prospectSearchId: string,
  event: RunEvent,
): ProspectSearchEvent {
  return {
    type: 'tool_activity',
    prospectSearchId,
    at: nowIso(),
    data: { event },
  };
}

export function isTerminalProspectSearchEvent(event: ProspectSearchEvent): boolean {
  return TERMINAL_PROSPECT_SEARCH_EVENT_TYPES.has(event.type);
}

/**
 * Adapt a ProspectSearchEvent for the shared RunEventBus before publishing.
 *
 * The bus routes + buffers by `event.runId` (see run-event-bus.ts), but
 * ProspectSearchEvents key on `prospectSearchId` — so a prospectSearch event published as-is lands
 * under `runId: undefined` and the SSE stream (which subscribes by prospectSearchId)
 * never receives it. Stamping `runId = prospectSearchId` aligns the bus key with the
 * stream subscription. The extra field is inert on the wire (the web client
 * reads `type` + the typed `data`).
 */
export function toBusEvent(event: ProspectSearchEvent): RunEvent {
  return { ...event, runId: event.prospectSearchId } as unknown as RunEvent;
}
