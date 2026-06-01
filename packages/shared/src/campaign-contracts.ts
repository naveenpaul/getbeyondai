/**
 * Campaign HTTP + SSE contracts (chat/campaigns feature).
 *
 * Lives in @getbeyond/shared (MIT) so the web client, the Chrome extension, and
 * third-party clients implement against them without AGPL obligations. The API
 * DTOs re-export these shapes; the orchestrator maps its internal types onto
 * them.
 *
 * A campaign is a lookalike-sourcing run: derive an ICP from a wins list, source
 * a candidate pool, then qualify + rank each candidate via the Researcher. The
 * SSE stream surfaces both the orchestrator phases AND the granular tool calls
 * (wrapped RunEvents) so the chat can show "what's being run" live.
 */

import type { ResearcherDraftClaim, RunEvent } from './researcher-contracts';

export type CampaignStatus = 'draft' | 'running' | 'completed' | 'failed';

// ─── Sourcing config (where the candidate pool comes from) ──────────
//
// Discriminated by provider. Only `contact_list` (no-key: an imported
// ContactList) ships today; `apollo` is reserved for the firmographic-search
// adapter that lands with a BYO key.

export type SourcingConfig =
  | { provider: 'contact_list'; listId: string }
  | { provider: 'apollo'; reserved: true };

// ─── POST /campaigns ────────────────────────────────────────────────
//
// Identity (orgId, createdBy) is derived from the session, never the body.

export interface CreateCampaignRequest {
  /** Natural-language intent typed in the chatbox. */
  goal: string;
  /** Optional display title; the server derives one from `goal` if omitted. */
  title?: string;
  /** ContactList of closed-won accounts the ICP is derived from. */
  winsListId?: string | null;
  /** Where candidate companies come from. */
  sourcing: SourcingConfig;
  /** Per-campaign hard cost cap (cents). */
  budgetCents?: number;
}

export interface CreateCampaignResponse {
  campaignId: string;
  status: CampaignStatus;
}

// ─── GET /campaigns and /campaigns/:id ──────────────────────────────

export interface CampaignSummary {
  id: string;
  title: string;
  goal: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  /** Ranked candidates produced so far. */
  candidateCount: number;
}

export interface CampaignListResponse {
  items: CampaignSummary[];
}

/** The ICP derived from the wins list, for display. */
export interface IcpSummary {
  summary: string;
  keywords: string[];
  employeeCountMax: number | null;
  fundingStages: string[];
}

/** A sourced company qualified + scored against the ICP, with cited signals. */
export interface QualifiedCandidate {
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  /** 0..1 fit/similarity to the wins ICP. */
  fitScore: number;
  /** Short why-it-matches rationale from the Researcher. */
  rationale: string;
  /** Cited firmographic signals (team size, stage, etc.). Cite-or-abstain. */
  claims: ResearcherDraftClaim[];
}

export interface CampaignDetailResponse {
  campaign: CampaignSummary;
  icp: IcpSummary | null;
  candidates: QualifiedCandidate[];
}

// ─── SSE stream events (GET /campaigns/:id/stream) ──────────────────
//
// Each SSE payload is one CampaignEvent. `tool_activity` wraps a runtime
// RunEvent so the chat shows the underlying tool calls as they run.

export type CampaignEventType =
  | 'campaign_started'
  | 'icp_derived'
  | 'sourcing_started'
  | 'sourcing_completed'
  | 'candidate_qualified'
  | 'campaign_completed'
  | 'campaign_failed'
  | 'tool_activity';

interface BaseCampaignEvent {
  campaignId: string;
  at: string;
}

export type CampaignEvent =
  | (BaseCampaignEvent & { type: 'campaign_started'; data: { goal: string } })
  | (BaseCampaignEvent & { type: 'icp_derived'; data: { icp: IcpSummary } })
  | (BaseCampaignEvent & {
      type: 'sourcing_started';
      data: { provider: string };
    })
  | (BaseCampaignEvent & {
      type: 'sourcing_completed';
      data: { summary: string; candidateCount: number };
    })
  | (BaseCampaignEvent & {
      type: 'candidate_qualified';
      data: { candidate: QualifiedCandidate; index: number; total: number };
    })
  | (BaseCampaignEvent & {
      type: 'campaign_completed';
      data: { candidateCount: number; costCents: number };
    })
  | (BaseCampaignEvent & {
      type: 'campaign_failed';
      data: { message: string };
    })
  // Granular tool call from an underlying teammate run, forwarded for the
  // "what's being run" view + the connected-tools sidebar.
  | (BaseCampaignEvent & { type: 'tool_activity'; data: { event: RunEvent } });

export const TERMINAL_CAMPAIGN_EVENT_TYPES: ReadonlySet<CampaignEventType> =
  new Set(['campaign_completed', 'campaign_failed']);
