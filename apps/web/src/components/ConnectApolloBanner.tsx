'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getApolloStatus } from '@/lib/api-client';

/**
 * Apollo connection nudge for the campaigns home.
 *
 * Discovery is auto: once Apollo is connected, every new campaign searches
 * Apollo for companies matching the derived ICP. This banner just surfaces that
 * state and routes to Settings → Connectors to manage the key — the canonical
 * place to enter it. Self-host-only: on Cloud (available=false) it hides.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'disconnected' }
  | { kind: 'connected'; status?: string }
  | { kind: 'hidden' };

/** A connected account whose status isn't `active` needs the user's attention. */
function needsAttention(status?: string): boolean {
  return status !== undefined && status !== 'active';
}

export function ConnectApolloBanner(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getApolloStatus()
      .then((s) => {
        if (cancelled) return;
        // Self-host-only: hide on Cloud.
        if (!s.available) return setState({ kind: 'hidden' });
        setState(
          s.connected
            ? { kind: 'connected', status: s.status }
            : { kind: 'disconnected' },
        );
      })
      .catch(() => {
        // Non-critical UI — hide rather than surface an error over the composer.
        if (!cancelled) setState({ kind: 'hidden' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading' || state.kind === 'hidden') return null;

  const connectedOk = state.kind === 'connected' && !needsAttention(state.status);

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-sm">
          {connectedOk ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          ) : state.kind === 'connected' ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
          ) : (
            <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-foreground">
            {connectedOk
              ? 'Apollo connected — new searches auto-discover companies from your ICP.'
              : state.kind === 'connected'
                ? 'Your Apollo key needs attention — reconnect to keep discovering companies.'
                : 'Connect Apollo to auto-discover companies matching your ICP.'}
          </span>
        </div>
        {connectedOk ? null : (
          <Button
            asChild
            size="sm"
            variant={state.kind === 'connected' ? 'secondary' : 'default'}
            className="shrink-0"
          >
            <Link href="/settings/connectors">
              {state.kind === 'connected' ? 'Reconnect' : 'Connect Apollo'}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
