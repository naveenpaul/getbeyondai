'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Loader2, Plug, Upload } from 'lucide-react';
import type { ContactListSummary } from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';
import { listContactLists } from '@/lib/api-client';
import { cn } from '@/lib/utils';

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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await listContactLists();
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
  }, []);

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
        <Link
          href="/contacts/import"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs font-medium hover:bg-muted',
            !hasLists && state.kind === 'ready' ? 'border-foreground/30' : '',
          )}
        >
          <Upload className="h-3.5 w-3.5" />
          Import CSV
        </Link>
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
    </div>
  );
}
