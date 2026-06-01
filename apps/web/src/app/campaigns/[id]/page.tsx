'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, RotateCw } from 'lucide-react';
import type {
  CampaignDetailResponse,
  CampaignStatus,
} from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CampaignTranscript } from '@/components/CampaignTranscript';
import { ConnectedToolsSidebar } from '@/components/ConnectedToolsSidebar';
import { ApiError, getCampaign, rerunCampaign } from '@/lib/api-client';
import { useCampaignStream } from '@/lib/use-campaign-stream';

/**
 * Campaign chat workspace.
 *
 * Claude-web-shaped: a central transcript column + an always-open right rail
 * of connected tools/sources. The SSE stream (useCampaignStream) drives the
 * live transcript — phase lines, "what's being run" tool lines, and qualified
 * candidate cards. On a terminal event we fetch the persisted detail once so
 * the page survives a refresh after the stream has closed (re-opening a
 * completed campaign shows its candidates without a live stream).
 *
 * Identity is resolved server-side from the session cookie; middleware ensures
 * /campaigns/** is only reachable after sign-in.
 */
export default function CampaignWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);

  const { events, connectionState, terminated } = useCampaignStream({
    campaignId: id,
  });

  const [detail, setDetail] = useState<CampaignDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Fetch the persisted detail (a) on mount, so header/sourcing/candidates
  // render even before the stream warms up or for an already-finished
  // campaign, and (b) again once terminated to pick up the final snapshot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getCampaign(id);
        if (!cancelled) setDetail(result);
      } catch (err) {
        if (cancelled) return;
        setDetailError(
          err instanceof ApiError
            ? `${err.status} — ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, terminated]);

  const campaign = detail?.campaign ?? null;
  // While the stream has produced no candidate events yet, fall back to the
  // persisted candidates from the detail fetch (e.g. reopening a finished
  // campaign). Once live events arrive, the transcript reducer renders those.
  const liveHasCandidates = events.some(
    (e) => e.type === 'candidate_qualified',
  );

  return (
    <div className="container py-8 lg:grid lg:grid-cols-[1fr_18rem] lg:gap-8">
      <main className="min-w-0 space-y-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All campaigns
        </Link>

        <header className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {campaign?.title ?? 'Campaign'}
            </h1>
            {campaign ? <StatusBadge status={campaign.status} /> : null}
            <span className="font-mono text-xs text-muted-foreground">{id}</span>
            {/* Re-run is offered once a campaign has settled (failed or
                completed); it clones the config into a fresh run and navigates
                to the new campaign. Hidden while draft/running to avoid
                spawning a duplicate of an in-flight run. */}
            {campaign &&
            (campaign.status === 'failed' ||
              campaign.status === 'completed') ? (
              <RerunButton campaignId={id} className="ml-auto" />
            ) : null}
          </div>
          {campaign?.goal ? (
            <p className="text-sm text-muted-foreground">{campaign.goal}</p>
          ) : null}
        </header>

        {detail?.icp ? (
          <div className="rounded-lg border bg-muted/30 p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Derived ICP
            </h2>
            <p className="mt-1 text-sm text-foreground">{detail.icp.summary}</p>
            {detail.icp.keywords.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.icp.keywords.map((kw) => (
                  <Badge key={kw} variant="secondary">
                    {kw}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Activity</h2>
            <span className="font-mono text-xs text-muted-foreground">
              stream: {connectionState}
            </span>
          </div>

          {detailError && events.length === 0 ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              Failed to load campaign: {detailError}
            </div>
          ) : null}

          {events.length > 0 || liveHasCandidates ? (
            <CampaignTranscript events={events} terminated={terminated} />
          ) : detail ? (
            <PersistedCandidates detail={detail} />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Connecting to the campaign…
            </div>
          )}
        </section>
      </main>

      <aside className="mt-10 lg:mt-0">
        <div className="lg:sticky lg:top-8">
          {/*
            CampaignDetailResponse doesn't echo the create-time SourcingConfig,
            so we pass null and the sidebar renders a neutral source row. When
            the API surfaces the sourcing config on the detail, bind it here.
          */}
          <ConnectedToolsSidebar sourcing={null} />
        </div>
      </aside>
    </div>
  );
}

/**
 * Re-runs the campaign: clones its persisted config into a new campaign and
 * navigates to it. Disabled while in flight so a double-click can't spawn two
 * runs. Errors surface inline beneath the header rather than as a toast (no
 * toast system here yet).
 */
function RerunButton({
  campaignId,
  className,
}: {
  campaignId: string;
  className?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRerun(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const { campaignId: nextId } = await rerunCampaign(campaignId);
      router.push(`/campaigns/${nextId}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.status} — ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : 'Re-run failed',
      );
      setSubmitting(false);
    }
    // On success we navigate away, so we intentionally leave `submitting` true
    // (the button unmounts) rather than resetting it.
  }

  return (
    <div className={className}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onRerun()}
        disabled={submitting}
      >
        {submitting ? (
          <>
            <Loader2 className="animate-spin" /> Re-running…
          </>
        ) : (
          <>
            <RotateCw className="h-3.5 w-3.5" /> Re-run
          </>
        )}
      </Button>
      {error ? (
        <p className="mt-1 text-right text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

/**
 * Renders candidates already persisted on the campaign when there's no live
 * stream (e.g. reopening a completed campaign). Reuses the transcript's
 * candidate rendering by synthesizing candidate_qualified events would be
 * heavier than warranted — a thin list mirrors the same card shape.
 */
function PersistedCandidates({
  detail,
}: {
  detail: CampaignDetailResponse;
}): React.JSX.Element {
  if (detail.candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No qualified candidates yet.
      </p>
    );
  }
  // Replay persisted candidates through the same transcript renderer by
  // building synthetic candidate_qualified events, so the card UI stays DRY.
  const synthetic = detail.candidates.map((candidate, i) => ({
    type: 'candidate_qualified' as const,
    campaignId: detail.campaign.id,
    at: detail.campaign.updatedAt,
    data: { candidate, index: i, total: detail.candidates.length },
  }));
  return <CampaignTranscript events={synthetic} terminated />;
}

const STATUS_VARIANT: Record<
  CampaignStatus,
  'secondary' | 'success' | 'warning' | 'destructive'
> = {
  draft: 'secondary',
  running: 'warning',
  completed: 'success',
  failed: 'destructive',
};

function StatusBadge({ status }: { status: CampaignStatus }): React.JSX.Element {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}
