'use client';

import { Check, CircleAlert, Loader2 } from 'lucide-react';
import type { RunEvent } from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';

interface ResearchRunStreamProps {
  events: RunEvent[];
  terminated: boolean;
}

/**
 * Renders the live event feed for an in-progress (or completed) research
 * run. Each event becomes a row; in-flight tool/model calls show a spinner,
 * completed ones show a check, errors show a warning.
 *
 * The component is purely view — the SSE subscription lives in the page
 * via useResearchStream.
 */
export function ResearchRunStream({
  events,
  terminated,
}: ResearchRunStreamProps): React.JSX.Element {
  // Group tool_call_started with its later tool_call_completed (by toolSeq)
  // so the row updates in place rather than emitting two lines per tool.
  const collapsed = collapseEvents(events);

  return (
    <div className="space-y-1.5">
      {collapsed.map((row) => (
        <RunRow key={row.key} row={row} />
      ))}
      {!terminated && collapsed.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to the
          worker…
        </div>
      ) : null}
    </div>
  );
}

interface CollapsedRow {
  key: string;
  kind: 'model' | 'tool' | 'draft' | 'terminal';
  /** True until the matching completed/terminal event arrives. */
  inFlight: boolean;
  isError: boolean;
  primary: string;
  secondary?: string;
  raw: RunEvent;
}

function collapseEvents(events: RunEvent[]): CollapsedRow[] {
  const out: CollapsedRow[] = [];
  const toolIndexBySeq = new Map<number, number>();
  const modelIndexByTurn = new Map<number, number>();

  for (const e of events) {
    switch (e.type) {
      case 'model_call_started': {
        const idx = out.length;
        modelIndexByTurn.set(e.data.turn, idx);
        out.push({
          key: `model-${e.data.turn}`,
          kind: 'model',
          inFlight: true,
          isError: false,
          primary: 'Thinking…',
          secondary: `${e.data.modelName} · turn ${e.data.turn + 1}`,
          raw: e,
        });
        break;
      }
      case 'model_call_completed': {
        // Find the matching started row by turn and mark complete. The
        // model_call_completed event doesn't carry `turn` — there's a 1:1
        // ordering with started events, so we attach to the LAST inFlight
        // model row.
        for (let i = out.length - 1; i >= 0; i--) {
          const row = out[i];
          if (row && row.kind === 'model' && row.inFlight) {
            row.inFlight = false;
            row.primary = 'Thought';
            row.secondary = `${e.data.modelName} · ${e.data.inputTokens} in / ${e.data.outputTokens} out · ${formatCents(e.data.costCents)}`;
            break;
          }
        }
        break;
      }
      case 'tool_call_started': {
        const idx = out.length;
        toolIndexBySeq.set(e.data.toolSeq, idx);
        out.push({
          key: `tool-${e.data.toolSeq}`,
          kind: 'tool',
          inFlight: true,
          isError: false,
          primary: describeToolStart(e.data.toolName, e.data.args),
          secondary: undefined,
          raw: e,
        });
        break;
      }
      case 'tool_call_completed': {
        const idx = toolIndexBySeq.get(e.data.toolSeq);
        if (idx !== undefined && out[idx]) {
          const row = out[idx];
          row.inFlight = false;
          row.isError = e.data.isError;
          row.primary = describeToolDone(e.data.toolName, e.data.isError);
          row.secondary = [
            e.data.summary,
            e.data.durationMs > 0 ? `${e.data.durationMs}ms` : null,
          ]
            .filter(Boolean)
            .join(' · ');
        }
        break;
      }
      case 'draft_emitted':
        out.push({
          key: `draft-${e.data.draftId}`,
          kind: 'draft',
          inFlight: false,
          isError: false,
          primary: 'Persisted draft',
          secondary: `${e.data.persistedClaimCount} claims · ${e.data.droppedUncitedCount} uncited dropped · ${e.data.droppedDanglingCount} dangling dropped`,
          raw: e,
        });
        break;
      case 'run_completed':
        out.push({
          key: 'terminal-completed',
          kind: 'terminal',
          inFlight: false,
          isError: false,
          primary: 'Done',
          secondary: `${e.data.toolCallCount} tool calls · ${formatCents(e.data.costCents)}`,
          raw: e,
        });
        break;
      case 'run_abstained':
        out.push({
          key: 'terminal-abstained',
          kind: 'terminal',
          inFlight: false,
          isError: false,
          primary: `Gave up: ${e.data.reason}`,
          secondary: `${e.data.toolCallCount} tool calls · ${formatCents(e.data.costCents)}`,
          raw: e,
        });
        break;
      case 'run_failed':
        out.push({
          key: 'terminal-failed',
          kind: 'terminal',
          inFlight: false,
          isError: true,
          primary: 'Failed',
          secondary: e.data.message,
          raw: e,
        });
        break;
    }
  }
  return out;
}

function describeToolStart(toolName: string, args: unknown): string {
  // 'brave_search' is the legacy tool name kept for historical AgentRun records.
  if (toolName === 'web_search' || toolName === 'brave_search') {
    const q = (args as { query?: string } | undefined)?.query;
    return q ? `Searching for "${q}"…` : 'Searching…';
  }
  if (toolName === 'fetch_url') {
    const u = (args as { url?: string } | undefined)?.url;
    return u ? `Fetching ${u}…` : 'Fetching…';
  }
  if (toolName === 'emit_draft') return 'Writing draft…';
  return `Calling ${toolName}…`;
}

function describeToolDone(toolName: string, isError: boolean): string {
  if (isError) {
    if (toolName === 'emit_draft') return 'Draft rejected — retrying';
    return `${toolName} failed`;
  }
  if (toolName === 'web_search' || toolName === 'brave_search') return 'Got results';
  if (toolName === 'fetch_url') return 'Fetched';
  if (toolName === 'emit_draft') return 'Draft accepted';
  return toolName;
}

function formatCents(c: number): string {
  if (c < 1) return '<1¢';
  if (c < 100) return `${c}¢`;
  return `$${(c / 100).toFixed(2)}`;
}

function RunRow({ row }: { row: CollapsedRow }): React.JSX.Element {
  const icon = row.inFlight ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
  ) : row.isError ? (
    <CircleAlert className="h-3.5 w-3.5 text-destructive" />
  ) : (
    <Check className="h-3.5 w-3.5 text-emerald-600" />
  );
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="mt-1 self-start">{icon}</span>
      <div className="flex flex-1 flex-wrap items-baseline gap-x-2">
        <span
          className={
            row.isError ? 'text-destructive' : 'text-foreground'
          }
        >
          {row.primary}
        </span>
        {row.secondary ? (
          <span className="text-xs text-muted-foreground">
            {row.secondary}
          </span>
        ) : null}
        {row.kind === 'terminal' ? (
          <Badge
            variant={row.isError ? 'destructive' : 'success'}
            className="ml-auto"
          >
            {row.raw.type.replace('run_', '')}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
