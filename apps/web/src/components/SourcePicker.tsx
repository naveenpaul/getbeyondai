'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Loader2, Plug, Upload, X } from 'lucide-react';
import type { ContactListSummary } from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';
import { listContactLists } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
  CsvImportFlow,
  type CsvImportResultInfo,
} from '@/components/CsvImportFlow';

/**
 * Picks one of the org's imported contact lists for a campaign (the candidate
 * source pool, or the closed-won wins list the ICP is derived from).
 *
 * Replaces the old raw-id text inputs: the user selects a real list instead of
 * pasting an id we'd have to trust blindly. CSV-imported and HubSpot-synced
 * lists both appear, tagged by provenance.
 *
 * The select is OPTIONAL — "None" is a first-class value (`null`). The CTAs
 * below seed lists when the org has none: CSV import is a built web flow;
 * HubSpot connect points at the API OAuth start (no web connectors route yet),
 * so we never fabricate a settings page that doesn't exist.
 */

/**
 * Human-readable origin label from a list's `source` provenance tag, e.g.
 * "csv:upload:abc" → "CSV", "hubspot:list:xyz" → "HubSpot". Pure; exported as
 * a unit-test target.
 */
export function formatSourceTag(source: string): string {
  const provider = source.split(':', 1)[0]?.toLowerCase() ?? '';
  switch (provider) {
    case 'csv':
      return 'CSV';
    case 'hubspot':
      return 'HubSpot';
    case 'salesforce':
      return 'Salesforce';
    case 'apollo':
      return 'Apollo';
    case 'zoominfo':
      return 'ZoomInfo';
    case '':
      return 'List';
    default:
      // Capitalize an unknown provider rather than dropping it.
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; lists: ContactListSummary[] };

interface SourcePickerProps {
  /** Selected list id, or null when nothing is picked. */
  value: string | null;
  /** Fired with the picked list id, or null for the "None" option. */
  onChange: (listId: string | null) => void;
  /** Field label shown above the select. */
  label: string;
  /** Short helper line under the label. */
  hint?: string;
  /** Label for the empty / unselected option (e.g. "None"). */
  noneLabel?: string;
  disabled?: boolean;
  id?: string;
}

export function SourcePicker({
  value,
  onChange,
  label,
  hint,
  noneLabel = 'None',
  disabled = false,
  id,
}: SourcePickerProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [importOpen, setImportOpen] = useState(false);

  // Single fetch helper, reused by the initial load and the post-import
  // refresh. Throws on failure so each caller decides how to surface it.
  const fetchLists = useCallback(async (): Promise<ContactListSummary[]> => {
    const { items } = await listContactLists();
    return items;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchLists();
        if (!cancelled) setState({ kind: 'ready', lists: items });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load lists',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchLists]);

  // Close the import modal on Escape.
  useEffect(() => {
    if (!importOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setImportOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [importOpen]);

  // After an in-context import completes, refresh the dropdown and auto-select
  // the freshly-created list (matched by its `csv:upload:{syncRunId}` source) so
  // the user lands back on the campaign with the source already chosen.
  async function onImported(result: CsvImportResultInfo): Promise<void> {
    if (result.status.status !== 'completed') return;
    try {
      const items = await fetchLists();
      setState({ kind: 'ready', lists: items });
      const created = items.find(
        (l) => l.source === `csv:upload:${result.syncRunId}`,
      );
      if (created) onChange(created.id);
    } catch {
      // Non-fatal: the import succeeded; the list just isn't auto-selected.
      // It will appear the next time the picker loads.
    }
  }

  const selectId = id ?? `source-picker-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const hasLists = state.kind === 'ready' && state.lists.length > 0;
  const selected =
    state.kind === 'ready'
      ? (state.lists.find((l) => l.id === value) ?? null)
      : null;

  return (
    <div className="space-y-1.5">
      <label htmlFor={selectId} className="block text-xs font-medium">
        {label}
        {hint ? (
          <span className="ml-1 font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </label>

      {state.kind === 'loading' ? (
        <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading lists…
        </div>
      ) : null}

      {state.kind === 'error' ? (
        // Degrade gracefully: surface the error but keep the field usable as a
        // disabled "None" so the campaign can still start without a source.
        <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-100/40 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Couldn&apos;t load contact lists. You can still continue without one.</span>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        hasLists ? (
          <div className="flex items-center gap-2">
            <select
              id={selectId}
              disabled={disabled}
              value={value ?? ''}
              onChange={(e) =>
                onChange(e.target.value === '' ? null : e.target.value)
              }
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">{noneLabel}</option>
              {state.lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} · {list.contactCount.toLocaleString()} ·{' '}
                  {formatSourceTag(list.source)}
                </option>
              ))}
            </select>
            {selected ? (
              <Badge variant="secondary" className="shrink-0">
                {formatSourceTag(selected.source)}
              </Badge>
            ) : null}
          </div>
        ) : (
          // Empty state: no lists yet → make the CTAs the prominent action.
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            No contact lists yet. Import a CSV or connect HubSpot to add one.
          </div>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          disabled={disabled}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
            !hasLists && state.kind === 'ready' ? 'border-foreground/30' : '',
          )}
        >
          <Upload className="h-3.5 w-3.5" />
          Import CSV
        </button>
        {/* HubSpot connect is a fetch-then-redirect OAuth flow with a callback
            landing the web app doesn't have yet — not a navigable link. Shown
            disabled until that flow is wired; once connected, HubSpot-synced
            lists appear in the dropdown above like any other list. */}
        <span
          title="HubSpot connection isn't wired into the UI yet — coming soon. Once connected, synced lists appear above."
          aria-disabled="true"
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium text-muted-foreground opacity-60"
        >
          <Plug className="h-3.5 w-3.5" />
          Connect HubSpot (soon)
        </span>
      </div>

      {importOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Import contacts from CSV"
              onClick={(e) => {
                if (e.target === e.currentTarget) setImportOpen(false);
              }}
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
            >
              <div className="my-4 w-full max-w-2xl rounded-xl border bg-card p-5 shadow-lg">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-base font-semibold">
                    Import contacts from CSV
                  </h2>
                  <button
                    type="button"
                    onClick={() => setImportOpen(false)}
                    aria-label="Close"
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mb-4 text-xs text-muted-foreground">
                  We&apos;ll import into a new list and select it here — your
                  campaign stays as-is.
                </p>
                <CsvImportFlow
                  onComplete={(r) => void onImported(r)}
                  primaryAction={{
                    label: 'Done',
                    onClick: () => setImportOpen(false),
                  }}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
