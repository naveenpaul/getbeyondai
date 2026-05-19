'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { ResearcherRunStatusResponse } from '@getbeyond/shared';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ResearchRunStream } from '@/components/ResearchRunStream';
import { ResearchDraftCard } from '@/components/ResearchDraftCard';
import { ApiError, getResearchRun } from '@/lib/api-client';
import { useIdentity } from '@/lib/use-identity';
import { useResearchStream } from '@/lib/use-research-stream';

/**
 * Run detail page (T5.4 → T6.4).
 *
 * Subscribes to the SSE stream to render live progress. Once a terminal
 * event arrives, fires a single GET /runs/:id to fetch the persisted
 * Draft (with claims + citation URLs joined) for inline display.
 *
 * orgId comes from the session via `useIdentity()` — middleware ensures
 * /research/** is only reachable after sign-in, so identity is present.
 */
export default function ResearchRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}): React.JSX.Element {
  const { runId } = use(params);
  const { identity } = useIdentity();
  const orgId = identity?.orgId ?? null;

  const { events, connectionState, terminated } = useResearchStream({
    runId: orgId ? runId : null,
    orgId: orgId ?? '',
  });

  const [snapshot, setSnapshot] = useState<ResearcherRunStatusResponse | null>(
    null,
  );
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  useEffect(() => {
    if (!terminated || !orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getResearchRun(runId, orgId);
        if (!cancelled) setSnapshot(result);
      } catch (err) {
        if (cancelled) return;
        setSnapshotError(
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
  }, [runId, terminated, orgId]);

  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/research/new"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        New run
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-baseline justify-between">
            <span>Research run</span>
            <span className="font-mono text-xs text-muted-foreground">
              {runId}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-muted-foreground">
            stream: <span className="font-mono">{connectionState}</span>
          </div>
          <ResearchRunStream events={events} terminated={terminated} />
        </CardContent>
      </Card>

      {snapshotError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load draft: {snapshotError}
        </div>
      ) : null}

      {snapshot?.draft ? <ResearchDraftCard draft={snapshot.draft} /> : null}
    </main>
  );
}
