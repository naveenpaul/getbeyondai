'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { CreateCampaignRequest } from '@getbeyond/shared';
import { Button } from '@/components/ui/button';
import { SourcePicker } from '@/components/SourcePicker';
import { ApiError, createCampaign } from '@/lib/api-client';
import { useIdentity } from '@/lib/use-identity';

/**
 * The "start a campaign" chatbox. The user types the goal in natural language;
 * on submit we POST a CreateCampaignRequest and route to the campaign's chat
 * workspace, where the SSE stream renders live.
 *
 * Chat-first: the goal is the only required field. A campaign can start with
 * just a goal — it derives + shows the ICP and then prompts for a source.
 * Sourcing is OPTIONAL (CreateCampaignRequest.sourcing): attach a contact list
 * via the SourcePicker to find candidates, and optionally point the ICP at a
 * separate closed-won wins list. Lists are picked, never pasted as raw ids.
 * Apollo sourcing is reserved (BYO key) and not offered yet.
 *
 * Two visual modes:
 *  - `variant="hero"` — the prominent home-screen composer (large textarea).
 *  - `variant="inline"` — the compact form on /campaigns/new.
 */

interface CampaignComposerProps {
  variant?: 'hero' | 'inline';
  autoFocus?: boolean;
}

export function CampaignComposer({
  variant = 'hero',
  autoFocus = false,
}: CampaignComposerProps): React.JSX.Element {
  const router = useRouter();
  const { status } = useIdentity();
  const [goal, setGoal] = useState('');
  const [winsListId, setWinsListId] = useState<string | null>(null);
  const [sourceListId, setSourceListId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityReady = status === 'authenticated';
  // Source is optional now — only the goal gates submission.
  const canSubmit = !submitting && goal.trim().length > 0;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    const payload: CreateCampaignRequest = {
      goal: goal.trim(),
      sourcing:
        sourceListId !== null
          ? { provider: 'contact_list', listId: sourceListId }
          : null,
      winsListId,
    };

    try {
      const { campaignId } = await createCampaign(payload);
      router.push(`/campaigns/${encodeURIComponent(campaignId)}`);
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
        <div className="mt-3 grid grid-cols-1 gap-4 border-t pt-3 sm:grid-cols-2">
          <SourcePicker
            label="Source"
            hint="(optional — candidate pool)"
            noneLabel="None — derive ICP only"
            value={sourceListId}
            onChange={setSourceListId}
            disabled={submitting}
          />
          <SourcePicker
            label="Wins list"
            hint="(optional — derives ICP)"
            noneLabel="None"
            value={winsListId}
            onChange={setWinsListId}
            disabled={submitting}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Derives your ICP; add a source to find candidates and rank them with
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
              <>Start campaign →</>
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
