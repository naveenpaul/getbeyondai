'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Loader2, Plus } from 'lucide-react';
import type { CampaignStatus, CampaignSummary } from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CampaignComposer } from '@/components/CampaignComposer';
import { ConnectApolloBanner } from '@/components/ConnectApolloBanner';
import { ConnectContactsBanner } from '@/components/ConnectContactsBanner';
import { ApiError, listCampaigns } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/campaign-transcript';
import { useIdentity } from '@/lib/use-identity';

/**
 * Home page.
 *
 * Unauthenticated visitors see the marketing card with a "sign in" CTA.
 * Authenticated users land on the campaigns workspace: a prominent "start a
 * campaign" composer plus the list of their campaigns. Opening a campaign
 * routes to its chat workspace at /campaigns/[id].
 */
export default function HomePage(): React.JSX.Element {
  const { status, identity } = useIdentity();

  if (status === 'loading') {
    return (
      <main className="container flex min-h-screen items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (status === 'signed_out' || !identity) {
    return <UnauthenticatedHome />;
  }

  return <CampaignsHome />;
}

function UnauthenticatedHome(): React.JSX.Element {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center py-16">
      <div className="mx-auto max-w-2xl space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            AI GTM teammates for solo founders.
          </h1>
          <p className="mx-auto max-w-xl text-lg text-muted-foreground">
            Audit every prompt, every claim, every source — in code and in the
            app.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link href="/login">
            <Button size="lg">
              Sign in <ArrowRight />
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-6 pt-12 text-left sm:grid-cols-3">
          <Feature
            title="Cite or abstain"
            body="Every claim links to a source the agent actually fetched. The runtime drops claims with no citation — no hallucinations reach the draft."
          />
          <Feature
            title="Open source"
            body="AGPLv3. Read the prompts, audit the tool calls, fork it if you want. The trust positioning is enforced by the code, not the marketing."
          />
          <Feature
            title="Cost-aware by design"
            body="Per-run budget cap, model + tool costs logged on every call, audit log primary in the schema. Solo founders can afford to run this."
          />
        </div>
      </div>
    </main>
  );
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: CampaignSummary[] }
  | { status: 'error'; message: string };

function CampaignsHome(): React.JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listCampaigns()
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', items: res.items });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message:
            err instanceof ApiError
              ? `${err.status} — ${err.body.slice(0, 200)}`
              : err instanceof Error
                ? err.message
                : 'Unknown error',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="container max-w-3xl space-y-10 py-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Prospects</h1>
        <p className="text-sm text-muted-foreground">
          Describe who you want to reach. We&apos;ll derive your ICP, source
          lookalikes, and rank them by fit — every signal cited.
        </p>
      </header>

      <CampaignComposer variant="hero" autoFocus />

      <ConnectApolloBanner />
      <ConnectContactsBanner />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            Your searches
          </h2>
        </div>
        <CampaignList state={state} />
      </section>
    </main>
  );
}

function CampaignList({ state }: { state: ListState }): React.JSX.Element {
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading searches…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load searches: {state.message}
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Plus className="h-4 w-4" />
        </div>
        <p className="text-sm font-medium text-foreground">No searches yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Start your first search with the box above — describe your goal and
          we&apos;ll discover matching companies once Apollo is connected.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {state.items.map((c) => (
        <li key={c.id}>
          <CampaignRow campaign={c} />
        </li>
      ))}
    </ul>
  );
}

function CampaignRow({
  campaign,
}: {
  campaign: CampaignSummary;
}): React.JSX.Element {
  return (
    <Link
      href={`/campaigns/${encodeURIComponent(campaign.id)}`}
      className="group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">
            {campaign.title}
          </span>
          <StatusBadge status={campaign.status} />
        </div>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {campaign.goal}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {campaign.candidateCount}{' '}
          {campaign.candidateCount === 1 ? 'prospect' : 'prospects'}
        </span>
        <span>{formatRelativeTime(campaign.updatedAt)}</span>
      </div>
    </Link>
  );
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
  return (
    <Badge variant={STATUS_VARIANT[status]} className="shrink-0">
      {status}
    </Badge>
  );
}

function Feature({
  title,
  body,
}: {
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
