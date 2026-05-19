'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, postResearchRun } from '@/lib/api-client';
import { useIdentity } from '@/lib/use-identity';

/**
 * The "start a research run" form. POSTs to /run, then router.push to the
 * SSE-streamed detail page. Disables the submit button while in flight so
 * impatient double-clicks don't queue duplicate runs.
 */
export function ResearchRunForm(): React.JSX.Element {
  const router = useRouter();
  const { identity, status } = useIdentity();
  const [target, setTarget] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || !target.trim() || !identity) return;
    setSubmitting(true);
    setError(null);
    try {
      const { runId } = await postResearchRun({
        orgId: identity.orgId,
        triggeredBy: identity.userId,
        target: target.trim(),
      });
      router.push(`/research/${encodeURIComponent(runId)}`);
    } catch (err) {
      setSubmitting(false);
      const msg =
        err instanceof ApiError
          ? `${err.status} — ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : 'Unknown error';
      setError(msg);
    }
  }

  // Identity still resolving — disable submit but render the form so the
  // page doesn't flash empty.
  const identityReady = status === 'authenticated' || status === 'fallback';

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle>Start a research run</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label
              htmlFor="target"
              className="text-sm font-medium text-foreground"
            >
              Target
            </label>
            <Input
              id="target"
              autoFocus
              required
              placeholder="A company, URL, or topic — e.g. Acme dental SaaS"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              The Researcher will search the web, fetch sources, and produce a
              cited brief. Default budget: 50¢ · max 20 tool calls · 120s wall.
            </p>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={submitting || !target.trim() || !identityReady}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" /> Starting…
                </>
              ) : (
                <>Start →</>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
