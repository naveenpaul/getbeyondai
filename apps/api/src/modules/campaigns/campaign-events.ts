import type {
  CampaignEvent,
  IcpSummary,
  QualifiedCandidate,
  RunEvent,
} from '@getbeyond/shared';
import { TERMINAL_CAMPAIGN_EVENT_TYPES } from '@getbeyond/shared';

/**
 * Typed factory helpers for the campaign SSE event union.
 *
 * The orchestrator emits these at each pipeline phase; `tool_activity` wraps an
 * underlying Researcher `RunEvent` so the chat can render the granular tool
 * calls live (architecture: the chat shows "what's being run").
 *
 * Centralizing construction here keeps `at` stamping consistent and the
 * discriminated-union shapes correct in one place (the contract lives in
 * @getbeyond/shared; these builders are the API-side mapping onto it).
 */
export type EmitCampaignEvent = (event: CampaignEvent) => void;

function nowIso(): string {
  return new Date().toISOString();
}

export function campaignStarted(
  campaignId: string,
  goal: string,
): CampaignEvent {
  return { type: 'campaign_started', campaignId, at: nowIso(), data: { goal } };
}

export function icpDerived(
  campaignId: string,
  icp: IcpSummary,
): CampaignEvent {
  return { type: 'icp_derived', campaignId, at: nowIso(), data: { icp } };
}

export function sourcingStarted(
  campaignId: string,
  provider: string,
): CampaignEvent {
  return {
    type: 'sourcing_started',
    campaignId,
    at: nowIso(),
    data: { provider },
  };
}

export function sourcingCompleted(
  campaignId: string,
  summary: string,
  candidateCount: number,
): CampaignEvent {
  return {
    type: 'sourcing_completed',
    campaignId,
    at: nowIso(),
    data: { summary, candidateCount },
  };
}

export function candidateQualified(
  campaignId: string,
  candidate: QualifiedCandidate,
  index: number,
  total: number,
): CampaignEvent {
  return {
    type: 'candidate_qualified',
    campaignId,
    at: nowIso(),
    data: { candidate, index, total },
  };
}

export function campaignCompleted(
  campaignId: string,
  candidateCount: number,
  costCents: number,
): CampaignEvent {
  return {
    type: 'campaign_completed',
    campaignId,
    at: nowIso(),
    data: { candidateCount, costCents },
  };
}

export function campaignFailed(
  campaignId: string,
  message: string,
): CampaignEvent {
  return {
    type: 'campaign_failed',
    campaignId,
    at: nowIso(),
    data: { message },
  };
}

/**
 * Wrap an underlying teammate `RunEvent` as a campaign `tool_activity` event so
 * the chat's "connected tools" view sees the granular model/tool calls of the
 * Researcher runs the orchestrator drives. `at` is stamped fresh (the moment
 * the orchestrator forwarded it) so the campaign stream stays monotonic even if
 * a RunEvent's own `at` lags.
 */
export function toolActivity(
  campaignId: string,
  event: RunEvent,
): CampaignEvent {
  return {
    type: 'tool_activity',
    campaignId,
    at: nowIso(),
    data: { event },
  };
}

export function isTerminalCampaignEvent(event: CampaignEvent): boolean {
  return TERMINAL_CAMPAIGN_EVENT_TYPES.has(event.type);
}

/**
 * Adapt a CampaignEvent for the shared RunEventBus before publishing.
 *
 * The bus routes + buffers by `event.runId` (see run-event-bus.ts), but
 * CampaignEvents key on `campaignId` — so a campaign event published as-is lands
 * under `runId: undefined` and the SSE stream (which subscribes by campaignId)
 * never receives it. Stamping `runId = campaignId` aligns the bus key with the
 * stream subscription. The extra field is inert on the wire (the web client
 * reads `type` + the typed `data`).
 */
export function toBusEvent(event: CampaignEvent): RunEvent {
  return { ...event, runId: event.campaignId } as unknown as RunEvent;
}
