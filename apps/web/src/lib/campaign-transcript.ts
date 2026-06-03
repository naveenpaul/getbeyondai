import type {
  CampaignEvent,
  IcpSummary,
  QualifiedCandidate,
  RunEvent,
} from '@getbeyond/shared';

/**
 * Pure reducer: CampaignEvent[] → an ordered transcript of renderable rows.
 *
 * The chat workspace shows a live transcript mixing three things:
 *  - phase lines (campaign_started, icp_derived, sourcing_*) — narration
 *  - "what's being run" lines (tool_activity, wrapping a RunEvent) — the
 *    granular tool calls, collapsed so a started/completed pair updates one
 *    row in place rather than emitting two
 *  - candidate result cards (candidate_qualified) — the actual output
 *
 * Kept pure (no React) so it's the unit-test target for the feature: feed an
 * event array, assert the row sequence. `apps/web` has no test runner yet —
 * see the report for the bootstrap note.
 *
 * NOTE on tool_activity collapsing: the underlying RunEvent stream may belong
 * to several teammate runs over a campaign's life, so a `toolSeq` is only
 * unique within one run. We key in-flight tool rows by `runId|toolSeq` to keep
 * pairs from colliding across runs.
 */

export type CampaignRowKind = 'phase' | 'tool' | 'candidate' | 'terminal';

interface BaseRow {
  /** Stable React key + de-dup identity. */
  key: string;
  kind: CampaignRowKind;
}

export interface PhaseRow extends BaseRow {
  kind: 'phase';
  primary: string;
  secondary?: string;
}

export interface ToolRow extends BaseRow {
  kind: 'tool';
  /** True until the matching tool_call_completed arrives. */
  inFlight: boolean;
  isError: boolean;
  primary: string;
  secondary?: string;
}

export interface CandidateRow extends BaseRow {
  kind: 'candidate';
  candidate: QualifiedCandidate;
  index: number;
  total: number;
}

export interface TerminalRow extends BaseRow {
  kind: 'terminal';
  isError: boolean;
  primary: string;
  secondary?: string;
}

export type CampaignRow = PhaseRow | ToolRow | CandidateRow | TerminalRow;

export interface CampaignTranscript {
  rows: CampaignRow[];
  /** Latest derived ICP, surfaced separately from the row feed for the header. */
  icp: IcpSummary | null;
  /** Candidates in arrival order, for callers that want the cards alone. */
  candidates: QualifiedCandidate[];
}

export function buildCampaignTranscript(
  events: CampaignEvent[],
): CampaignTranscript {
  const rows: CampaignRow[] = [];
  const candidates: QualifiedCandidate[] = [];
  let icp: IcpSummary | null = null;

  // Map "runId|toolSeq" → index of its in-flight ToolRow, so the completed
  // event updates the same row instead of appending a new one.
  const toolRowIndex = new Map<string, number>();

  for (const e of events) {
    switch (e.type) {
      case 'campaign_started':
        rows.push({
          key: `started|${e.at}`,
          kind: 'phase',
          primary: 'Search started',
          secondary: e.data.goal,
        });
        break;

      case 'icp_derived':
        icp = e.data.icp;
        rows.push({
          key: `icp|${e.at}`,
          kind: 'phase',
          primary: 'Derived ICP from your wins',
          secondary: e.data.icp.summary,
        });
        break;

      case 'sourcing_started':
        rows.push({
          key: `sourcing-started|${e.at}`,
          kind: 'phase',
          primary: 'Sourcing prospects',
          secondary: `via ${e.data.provider}`,
        });
        break;

      case 'sourcing_completed':
        rows.push({
          key: `sourcing-completed|${e.at}`,
          kind: 'phase',
          primary: 'Sourcing complete',
          secondary: `${e.data.candidateCount} prospects · ${e.data.summary}`,
        });
        break;

      case 'candidate_qualified': {
        const { candidate, index, total } = e.data;
        candidates.push(candidate);
        rows.push({
          key: `candidate|${index}|${candidate.domain ?? candidate.name}`,
          kind: 'candidate',
          candidate,
          index,
          total,
        });
        break;
      }

      case 'campaign_completed':
        rows.push({
          key: `terminal-completed|${e.at}`,
          kind: 'terminal',
          isError: false,
          primary: 'Search complete',
          secondary: `${e.data.candidateCount} qualified · ${formatCents(e.data.costCents)}`,
        });
        break;

      case 'campaign_failed':
        rows.push({
          key: `terminal-failed|${e.at}`,
          kind: 'terminal',
          isError: true,
          primary: 'Search failed',
          secondary: e.data.message,
        });
        break;

      case 'tool_activity':
        applyToolActivity(e.data.event, rows, toolRowIndex);
        break;
    }
  }

  return { rows, icp, candidates };
}

/**
 * Folds a single wrapped RunEvent into the transcript's tool rows. Only the
 * tool-call events surface as "what's being run" lines; model-call and
 * draft/terminal RunEvents are internal to the underlying teammate run and
 * are intentionally not shown at the campaign level (the campaign has its own
 * terminal events).
 */
function applyToolActivity(
  event: RunEvent,
  rows: CampaignRow[],
  toolRowIndex: Map<string, number>,
): void {
  switch (event.type) {
    case 'tool_call_started': {
      const id = `${event.runId}|${event.data.toolSeq}`;
      toolRowIndex.set(id, rows.length);
      rows.push({
        key: `tool|${id}`,
        kind: 'tool',
        inFlight: true,
        isError: false,
        primary: describeToolStart(event.data.toolName, event.data.args),
      });
      break;
    }
    case 'tool_call_completed': {
      const id = `${event.runId}|${event.data.toolSeq}`;
      const idx = toolRowIndex.get(id);
      const row = idx !== undefined ? rows[idx] : undefined;
      if (row && row.kind === 'tool') {
        row.inFlight = false;
        row.isError = event.data.isError;
        row.primary = describeToolDone(event.data.toolName, event.data.isError);
        row.secondary = [
          event.data.summary,
          event.data.durationMs > 0 ? `${event.data.durationMs}ms` : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      break;
    }
    // model_call_*, draft_emitted, run_* are not surfaced at campaign level.
    default:
      break;
  }
}

export function describeToolStart(toolName: string, args: unknown): string {
  if (toolName === 'brave_search') {
    const q = (args as { query?: string } | undefined)?.query;
    return q ? `Searching for "${q}"…` : 'Searching the web…';
  }
  if (toolName === 'fetch_url') {
    const u = (args as { url?: string } | undefined)?.url;
    return u ? `Fetching ${u}…` : 'Fetching a page…';
  }
  return `Running ${toolName}…`;
}

export function describeToolDone(toolName: string, isError: boolean): string {
  if (isError) return `${toolName} failed`;
  if (toolName === 'brave_search') return 'Got search results';
  if (toolName === 'fetch_url') return 'Fetched page';
  return `Ran ${toolName}`;
}

export function formatCents(c: number): string {
  if (c < 1) return '<1¢';
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}

/** Compact "3m ago" / "2h ago" / "5d ago" relative time for list rows. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const deltaSec = Math.max(0, Math.round((now - then) / 1000));
  if (deltaSec < 60) return 'just now';
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
