/**
 * ProspectSearch HTTP + SSE contracts (chat/prospects feature).
 *
 * Lives in @getbeyond/shared (MIT) so the web client, the Chrome extension, and
 * third-party clients implement against them without AGPL obligations. The API
 * DTOs re-export these shapes; the orchestrator maps its internal types onto
 * them.
 *
 * A prospect search is a lookalike-sourcing run: derive an ICP from a wins list,
 * source a prospect pool, then qualify + rank each prospect via the Researcher.
 * The SSE stream surfaces both the orchestrator phases AND the granular tool
 * calls (wrapped RunEvents) so the chat can show "what's being run" live.
 */

import type { ResearcherDraftClaim, RunEvent } from './researcher-contracts';

export type ProspectSearchStatus = 'draft' | 'running' | 'completed' | 'failed';

// ─── Sourcing config (where the prospect pool comes from) ───────────
//
// Discriminated by provider:
//   - `contact_list` (no-key): qualify+rank an imported ContactList.
//   - `apollo` (BYO key): live company discovery — the derived ICP drives an
//     Apollo Organization Search. No extra config; the ICP IS the query.

export type SourcingConfig =
  | { provider: 'contact_list'; listId: string }
  | { provider: 'apollo' };

// ─── POST /prospect-searches ────────────────────────────────────────
//
// Identity (orgId, createdBy) is derived from the session, never the body.

export interface CreateProspectSearchRequest {
  /** Natural-language intent typed in the chatbox. */
  goal: string;
  /** Optional display title; the server derives one from `goal` if omitted. */
  title?: string;
  /** ContactList of closed-won accounts the ICP is derived from. Optional. */
  winsListId?: string | null;
  /**
   * Where prospect companies come from. OPTIONAL: a search can start with
   * just a goal — it derives + shows the ICP and then prompts for a source.
   * Attach a list (pick existing / CSV import / HubSpot) to find prospects.
   */
  sourcing?: SourcingConfig | null;
  /** Per-search hard cost cap (cents). */
  budgetCents?: number;
}

// ─── GET /contacts/lists (source/wins picker) ───────────────────────
//
// Powers the prospect-search composer's list pickers so users select a list
// instead of pasting a raw id. CSV-imported and HubSpot-synced lists both
// appear, distinguished by `source` (e.g. "csv:upload:…", "hubspot:list:…").

export interface ContactListSummary {
  id: string;
  name: string;
  contactCount: number;
  /** Provenance tag, e.g. "csv:upload:abc" | "hubspot:list:xyz". */
  source: string;
  createdAt: string;
}

export interface ContactListsResponse {
  items: ContactListSummary[];
}

export interface CreateProspectSearchResponse {
  prospectSearchId: string;
  status: ProspectSearchStatus;
}

// ─── GET /prospect-searches and /prospect-searches/:id ──────────────

export interface ProspectSearchSummary {
  id: string;
  title: string;
  goal: string;
  status: ProspectSearchStatus;
  createdAt: string;
  updatedAt: string;
  /** Ranked prospects produced so far. */
  prospectCount: number;
}

export interface ProspectSearchListResponse {
  items: ProspectSearchSummary[];
}

/** The ICP derived from the wins list, for display. */
export interface IcpSummary {
  summary: string;
  keywords: string[];
  employeeCountMax: number | null;
  fundingStages: string[];
}

/**
 * A contact sourced for a prospect company in Stage 5 — source-agnostic
 * (Snov, ZoomInfo, …). The connector that produced it rides in `source`; its
 * deliverability at source time rides in `emailVerification`.
 */
export interface ProspectContact {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  linkedinUrl: string | null;
  /** 'verified' | 'unverified' | 'unknown' | null. */
  emailVerification: string | null;
  /** Connector kind that produced this contact (snov | zoominfo | …). */
  source: string;
}

/** A sourced company qualified + scored against the ICP, with cited signals. */
export interface QualifiedProspect {
  name: string;
  domain: string | null;
  linkedinUrl: string | null;
  /** 0..1 fit/similarity to the wins ICP. */
  fitScore: number;
  /** Short why-it-matches rationale from the Researcher. */
  rationale: string;
  /** Cited firmographic signals (team size, stage, etc.). Cite-or-abstain. */
  claims: ResearcherDraftClaim[];
  /**
   * Contacts sourced at this company (Stage 5). Present in the prospect-search
   * DETAIL response; omitted on the mid-stream `prospect_qualified` event
   * (contacts are sourced after ranking). Empty array when none were found / no
   * connector.
   */
  contacts?: ProspectContact[];
}

export interface ProspectSearchDetailResponse {
  prospectSearch: ProspectSearchSummary;
  icp: IcpSummary | null;
  prospects: QualifiedProspect[];
}

// ─── SSE stream events (GET /prospect-searches/:id/stream) ──────────
//
// Each SSE payload is one ProspectSearchEvent. `tool_activity` wraps a runtime
// RunEvent so the chat shows the underlying tool calls as they run.

export type ProspectSearchEventType =
  | 'search_started'
  | 'icp_derived'
  | 'sourcing_started'
  | 'sourcing_completed'
  | 'prospect_qualified'
  | 'search_completed'
  | 'search_failed'
  | 'tool_activity';

interface BaseProspectSearchEvent {
  prospectSearchId: string;
  at: string;
}

export type ProspectSearchEvent =
  | (BaseProspectSearchEvent & { type: 'search_started'; data: { goal: string } })
  | (BaseProspectSearchEvent & { type: 'icp_derived'; data: { icp: IcpSummary } })
  | (BaseProspectSearchEvent & {
      type: 'sourcing_started';
      data: { provider: string };
    })
  | (BaseProspectSearchEvent & {
      type: 'sourcing_completed';
      data: { summary: string; prospectCount: number };
    })
  | (BaseProspectSearchEvent & {
      type: 'prospect_qualified';
      data: { prospect: QualifiedProspect; index: number; total: number };
    })
  | (BaseProspectSearchEvent & {
      type: 'search_completed';
      data: { prospectCount: number; costCents: number };
    })
  | (BaseProspectSearchEvent & {
      type: 'search_failed';
      data: { message: string };
    })
  // Granular tool call from an underlying teammate run, forwarded for the
  // "what's being run" view + the connected-tools sidebar.
  | (BaseProspectSearchEvent & { type: 'tool_activity'; data: { event: RunEvent } });

export const TERMINAL_PROSPECT_SEARCH_EVENT_TYPES: ReadonlySet<ProspectSearchEventType> =
  new Set(['search_completed', 'search_failed']);
