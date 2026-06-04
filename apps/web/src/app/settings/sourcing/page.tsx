'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import type {
  SourcingConnectorKind,
  SourcingSettingsResponse,
  SourcingThresholdName,
} from '@getbeyond/shared';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ApiError, getSourcingSettings, saveSourcingSettings } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Settings → Sourcing. Configures the Stage 5 contact-sourcing waterfall:
 *
 *   1. Connector priority — the order ZoomInfo / Snov are tried, and whether
 *      each is included at all. The waterfall stops at the first connector that
 *      satisfies the threshold; later ones are skipped to save credits. An empty
 *      priority (every connector disabled) is a valid "no contact sourcing"
 *      state.
 *   2. Threshold — the email-verification bar: `verified` chases a verified
 *      email across connectors; `any` accepts the first contact found.
 *
 * The two connectors are modelled as an *ordered row list* covering every known
 * connector, each with an `enabled` flag. The persisted `priority` array is the
 * enabled rows in their current order. This lets the user reorder a disabled
 * connector (so it lands in the right place if re-enabled) while keeping the
 * derived contract trivial. State is held as the full settings response plus the
 * working draft, so Save can diff against the persisted value.
 */

const CONNECTOR_LABELS: Record<SourcingConnectorKind, string> = {
  zoominfo: 'ZoomInfo',
  snov: 'Snov',
};

/** Every connector valid in the waterfall, in a stable canonical order. */
const ALL_CONNECTORS: readonly SourcingConnectorKind[] = ['zoominfo', 'snov'];

const THRESHOLD_LABELS: Record<SourcingThresholdName, string> = {
  verified: 'Verified email only',
  any: 'Any contact found',
};

const THRESHOLD_HINTS: Record<SourcingThresholdName, string> = {
  verified:
    'Chase a verified email across connectors before accepting a contact.',
  any: 'Accept the first contact found, verified or not.',
};

const THRESHOLD_OPTIONS: readonly SourcingThresholdName[] = ['verified', 'any'];

/** One connector row in the working draft: its kind plus whether it's included. */
interface ConnectorRow {
  kind: SourcingConnectorKind;
  enabled: boolean;
}

/**
 * Builds the ordered row list from a persisted priority array. Enabled
 * connectors come first in their saved order; any remaining (disabled)
 * connectors follow in canonical order so they have a stable home.
 */
function rowsFromPriority(priority: SourcingConnectorKind[]): ConnectorRow[] {
  const enabled = priority.filter((kind) => ALL_CONNECTORS.includes(kind));
  const disabled = ALL_CONNECTORS.filter((kind) => !enabled.includes(kind));
  return [
    ...enabled.map((kind) => ({ kind, enabled: true })),
    ...disabled.map((kind) => ({ kind, enabled: false })),
  ];
}

/** The persisted priority a row list represents: enabled rows in order. */
function priorityFromRows(rows: ConnectorRow[]): SourcingConnectorKind[] {
  return rows.filter((row) => row.enabled).map((row) => row.kind);
}

function priorityEqual(
  a: SourcingConnectorKind[],
  b: SourcingConnectorKind[],
): boolean {
  return a.length === b.length && a.every((kind, i) => kind === b[i]);
}

export default function SourcingSettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<SourcingSettingsResponse | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  // Working draft. Initialised from the persisted settings on load and after
  // each successful save.
  const [rows, setRows] = useState<ConnectorRow[]>([]);
  const [threshold, setThreshold] = useState<SourcingThresholdName>('verified');

  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);

  const applyResponse = useCallback((res: SourcingSettingsResponse): void => {
    setSettings(res);
    setRows(rowsFromPriority(res.priority));
    setThreshold(res.threshold);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      applyResponse(await getSourcingSettings());
    } catch (err) {
      setLoadError(formatError(err));
    }
  }, [applyResponse]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftPriority = useMemo(() => priorityFromRows(rows), [rows]);

  // Dirty when the draft diverges from the persisted settings — gates Save.
  const dirty = useMemo(() => {
    if (settings === null) return false;
    return (
      threshold !== settings.threshold ||
      !priorityEqual(draftPriority, settings.priority)
    );
  }, [settings, threshold, draftPriority]);

  // Whether the draft already matches the server defaults — gates Reset.
  const isDefault = useMemo(() => {
    if (settings === null) return true;
    return (
      threshold === settings.defaults.threshold &&
      priorityEqual(draftPriority, settings.defaults.priority)
    );
  }, [settings, threshold, draftPriority]);

  function move(index: number, direction: -1 | 1): void {
    setSavedJustNow(false);
    setRows((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      if (item === undefined) return prev;
      next.splice(target, 0, item);
      return next;
    });
  }

  function toggle(index: number): void {
    setSavedJustNow(false);
    setRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, enabled: !row.enabled } : row,
      ),
    );
  }

  function changeThreshold(next: SourcingThresholdName): void {
    setSavedJustNow(false);
    setThreshold(next);
  }

  function resetToDefaults(): void {
    if (settings === null) return;
    setSavedJustNow(false);
    setSaveError(null);
    setRows(rowsFromPriority(settings.defaults.priority));
    setThreshold(settings.defaults.threshold);
  }

  async function onSave(): Promise<void> {
    setSubmitting(true);
    setSaveError(null);
    setSavedJustNow(false);
    try {
      applyResponse(
        await saveSourcingSettings({ priority: draftPriority, threshold }),
      );
      setSavedJustNow(true);
    } catch (err) {
      setSaveError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError !== null) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (settings === null) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </div>
    );
  }

  const enabledCount = draftPriority.length;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Contact sourcing
          </h2>
          <p className="text-sm text-muted-foreground">
            When a prospect search finds qualified companies, it sources
            contacts through a connector waterfall. The first connector to meet
            your threshold wins — later ones are skipped to save credits.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connector priority</CardTitle>
            <CardDescription>
              Connectors are tried top to bottom. Disable a connector to leave it
              out of the waterfall. With every connector disabled, no contacts
              are sourced.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="divide-y rounded-md border border-border">
              {rows.map((row, index) => {
                const order = draftPriority.indexOf(row.kind);
                const checkboxId = `connector-${row.kind}`;
                return (
                  <li
                    key={row.kind}
                    className="flex items-center gap-3 px-3 py-3"
                  >
                    <span className="w-6 shrink-0 text-center font-mono text-sm tabular-nums text-muted-foreground">
                      {row.enabled ? order + 1 : '—'}
                    </span>
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded border-input accent-foreground"
                      checked={row.enabled}
                      onChange={() => toggle(index)}
                      disabled={submitting}
                    />
                    <label
                      htmlFor={checkboxId}
                      className={cn(
                        'flex-1 text-sm font-medium',
                        !row.enabled && 'text-muted-foreground',
                      )}
                    >
                      {CONNECTOR_LABELS[row.kind]}
                    </label>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Move ${CONNECTOR_LABELS[row.kind]} up`}
                        onClick={() => move(index, -1)}
                        disabled={submitting || index === 0}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`Move ${CONNECTOR_LABELS[row.kind]} down`}
                        onClick={() => move(index, 1)}
                        disabled={submitting || index === rows.length - 1}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              {enabledCount === 0
                ? 'No contact sourcing — prospect searches will surface companies without contacts.'
                : `${enabledCount} connector${enabledCount === 1 ? '' : 's'} in the waterfall.`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Verification threshold</CardTitle>
            <CardDescription>
              The email-verification bar applied while sourcing each contact.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset className="space-y-3">
              <legend className="sr-only">Verification threshold</legend>
              {THRESHOLD_OPTIONS.map((option) => {
                const id = `threshold-${option}`;
                return (
                  <div key={option} className="flex items-start gap-3">
                    <input
                      id={id}
                      type="radio"
                      name="threshold"
                      className="mt-0.5 h-4 w-4 shrink-0 border-input accent-foreground"
                      value={option}
                      checked={threshold === option}
                      onChange={() => changeThreshold(option)}
                      disabled={submitting}
                    />
                    <label htmlFor={id} className="space-y-0.5">
                      <span className="block text-sm font-medium">
                        {THRESHOLD_LABELS[option]}
                        {option === settings.defaults.threshold ? (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            (default)
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {THRESHOLD_HINTS[option]}
                      </span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void onSave()} disabled={submitting || !dirty}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" /> Saving…
              </>
            ) : (
              <>Save changes</>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={resetToDefaults}
            disabled={submitting || isDefault}
          >
            Reset to defaults
          </Button>
          {savedJustNow && !dirty ? (
            <span className="text-sm text-emerald-600">Saved.</span>
          ) : null}
          {saveError ? (
            <span className="text-sm text-destructive">{saveError}</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError)
    return `${err.status} — ${err.body.slice(0, 200)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
