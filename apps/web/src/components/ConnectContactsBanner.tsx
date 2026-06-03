'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSnovStatus, getZoomInfoStatus } from '@/lib/api-client';

/**
 * Contact-sources nudge for the prospectSearches home.
 *
 * Discovery (Apollo) finds + ranks companies, but to surface the actual PEOPLE
 * to reach out to a prospectSearch needs a contact connector (Snov or ZoomInfo). This
 * banner makes that explicit: without one, ranked companies come back with zero
 * contacts. Source-agnostic — connecting either is enough. Hides on any error
 * (non-critical UI over the composer).
 */

type State =
  | { kind: 'loading' }
  | { kind: 'connected'; names: string[] }
  | { kind: 'disconnected' }
  | { kind: 'hidden' };

export function ConnectContactsBanner(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSnovStatus(), getZoomInfoStatus()])
      .then(([snov, zoom]) => {
        if (cancelled) return;
        const names: string[] = [];
        if (snov.connected) names.push('Snov');
        if (zoom.connected) names.push('ZoomInfo');
        setState(
          names.length > 0
            ? { kind: 'connected', names }
            : { kind: 'disconnected' },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'hidden' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading' || state.kind === 'hidden') return null;

  const connected = state.kind === 'connected';

  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-sm">
          {connected ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-foreground">
            {connected
              ? `${state.names.join(' + ')} connected — prospectSearches surface contacts + verified emails at your matched companies.`
              : 'Connect Snov or ZoomInfo to surface the people to reach out to — without one, prospectSearches rank companies but find no contacts.'}
          </span>
        </div>
        {connected ? null : (
          <Button asChild size="sm" className="shrink-0">
            <Link href="/settings/connectors">Connect a contact source</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
