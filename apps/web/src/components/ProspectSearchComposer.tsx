'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Loader2 } from 'lucide-react';
import type {
  CreateProspectSearchRequest,
  IcpCriteriaInput,
} from '@getbeyond/shared';
import { Button } from '@/components/ui/button';
import { SourcePicker } from '@/components/SourcePicker';
import { IcpCriteriaFields } from '@/components/IcpCriteriaFields';
import { ApiError, createProspectSearch } from '@/lib/api-client';
import { useIdentity } from '@/lib/use-identity';
import { cn } from '@/lib/utils';

/**
 * The "start a prospectSearch" chatbox. The user types the goal in natural language;
 * on submit we POST a CreateProspectSearchRequest and route to the prospectSearch's chat
 * workspace, where the SSE stream renders live.
 *
 * Chat-first: the goal is the only required field. A prospectSearch starts with just
 * the goal (and optionally a closed-won wins list to point the ICP at) — it
 * derives + shows the ICP and then prompts for a source. The prospect source
 * is attached later in the Prospects workspace, not here, to keep the composer
 * a single calm input. Lists are picked, never pasted as raw ids.
 *
 * Two visual modes:
 *  - `variant="hero"` — the prominent home-screen composer (large textarea).
 *  - `variant="inline"` — the compact form on /prospects/new.
 */

interface ProspectSearchComposerProps {
  variant?: 'hero' | 'inline';
  autoFocus?: boolean;
}

/**
 * Convert the ICP form state into a cleaned `IcpCriteriaInput` for the payload,
 * or `undefined` when the user filled in nothing.
 *
 * CRITICAL — this mirrors the backend's merge semantics. The backend treats any
 * PROVIDED field as an authoritative override: an explicit `[]` means "force
 * empty / clear", and an explicit `null` employee bound means "clear the bound".
 * A field left `undefined` means "let the model derive it". So we must omit
 * every field the user did not actually fill in, never send `[]`/`null` as a
 * stand-in for "untouched". If ALL fields are empty we return `undefined` so the
 * key is omitted entirely and the ICP stays purely derived.
 *
 * Pure; exported as a unit-test target if a web test runner is added.
 */
export function cleanIcpCriteria(
  value: IcpCriteriaInput,
): IcpCriteriaInput | undefined {
  const cleaned: IcpCriteriaInput = {};

  // Arrays: include only when at least one non-blank entry survives trimming.
  // (`IcpCriteriaFields` already parses to trimmed, blank-free arrays, but we
  // re-filter defensively so this helper is correct for any input.)
  const industries = (value.industries ?? []).map((s) => s.trim()).filter(Boolean);
  const keywords = (value.keywords ?? []).map((s) => s.trim()).filter(Boolean);
  const fundingStages = (value.fundingStages ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const locations = (value.locations ?? []).map((s) => s.trim()).filter(Boolean);

  if (industries.length > 0) cleaned.industries = industries;
  if (keywords.length > 0) cleaned.keywords = keywords;
  if (fundingStages.length > 0) cleaned.fundingStages = fundingStages;
  if (locations.length > 0) cleaned.locations = locations;

  // Employee bounds: include a bound only when it is a real number. A blank
  // input is `null`/`undefined` in form state — omit it so the derived bound
  // stands, rather than sending `null` (which would clear it).
  if (typeof value.employeeCountMin === 'number') {
    cleaned.employeeCountMin = value.employeeCountMin;
  }
  if (typeof value.employeeCountMax === 'number') {
    cleaned.employeeCountMax = value.employeeCountMax;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function ProspectSearchComposer({
  variant = 'hero',
  autoFocus = false,
}: ProspectSearchComposerProps): React.JSX.Element {
  const router = useRouter();
  const { status } = useIdentity();
  const [goal, setGoal] = useState('');
  const [winsListId, setWinsListId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ICP refinement is collapsed by default to keep the composer calm — the
  // default chat-first flow is unchanged. The form state holds the raw parsed
  // criteria; `cleanIcpCriteria` strips empty fields at submit time.
  const [icpOpen, setIcpOpen] = useState(false);
  const [icpCriteria, setIcpCriteria] = useState<IcpCriteriaInput>({});

  const identityReady = status === 'authenticated';
  // Source is optional now — only the goal gates submission.
  const canSubmit = !submitting && goal.trim().length > 0;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    // Omit `icpCriteria` entirely when the user filled in nothing, so the ICP
    // stays purely derived. Only the fields the user actually set are sent.
    const cleanedIcp = cleanIcpCriteria(icpCriteria);

    const payload: CreateProspectSearchRequest = {
      goal: goal.trim(),
      // The prospect source is attached later in the Prospects workspace, not
      // from the composer — start with the goal (+ optional wins list) only.
      sourcing: null,
      winsListId,
      ...(cleanedIcp ? { icpCriteria: cleanedIcp } : {}),
    };

    try {
      const { prospectSearchId } = await createProspectSearch(payload);
      router.push(`/prospects/${encodeURIComponent(prospectSearchId)}`);
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof ApiError
          ? `${err.status} — ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : 'Unknown error',
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="rounded-xl border bg-card p-3 shadow-sm focus-within:border-foreground/30">
        <textarea
          autoFocus={autoFocus}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={submitting}
          rows={variant === 'hero' ? 3 : 2}
          placeholder="Find more companies like my best closed-won accounts and rank them by fit…"
          className="w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-50"
          // Submit on plain Enter; newline on Shift+Enter — chat convention.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSubmit(e);
            }
          }}
        />
        <div className="mt-3 border-t pt-3">
          <SourcePicker
            label="Wins list"
            hint="(optional — derives ICP)"
            noneLabel="None"
            value={winsListId}
            onChange={setWinsListId}
            disabled={submitting}
          />
        </div>

        {/* Optional ICP refinement — collapsed by default so the default
            chat-first flow is unchanged. When open, pinned firmographic
            constraints override the derived ICP field-by-field. */}
        <div className="mt-3 border-t pt-3">
          <button
            type="button"
            onClick={() => setIcpOpen((open) => !open)}
            disabled={submitting}
            aria-expanded={icpOpen}
            className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                icpOpen && 'rotate-90',
              )}
            />
            Refine ICP (optional)
          </button>
          {icpOpen ? (
            <div className="mt-3">
              <IcpCriteriaFields
                value={icpCriteria}
                onChange={setIcpCriteria}
                disabled={submitting}
              />
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Derives your ICP; add a source to find prospects and rank them with
            cited signals.
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit || !identityReady}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" /> Starting…
              </>
            ) : (
              <>Start search →</>
            )}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </form>
  );
}
