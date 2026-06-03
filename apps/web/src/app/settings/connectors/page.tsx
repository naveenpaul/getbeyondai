'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Info, Loader2, Plug, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ApiError,
  connectApollo,
  connectSnov,
  getApolloStatus,
  getSnovStatus,
  type ApolloAccountStatus,
  type SnovAccountStatus,
} from '@/lib/api-client';

/**
 * Settings → Connectors. Where the org wires data sources for campaign
 * discovery. Apollo (BYO key) is the first; it's self-host-only (vendor ToS),
 * so on Cloud the API reports `available:false` and we show why instead of a
 * key field. Keys are validated + stored encrypted by the API and never shown
 * again — this page only reports connection state.
 */
export default function ConnectorsSettingsPage(): React.JSX.Element {
  const [status, setStatus] = useState<ApolloAccountStatus | null>(null);
  const [snovStatus, setSnovStatus] = useState<SnovAccountStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [apollo, snov] = await Promise.all([
        getApolloStatus(),
        getSnovStatus(),
      ]);
      setStatus(apollo);
      setSnovStatus(snov);
    } catch (err) {
      setLoadError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (status === null || snovStatus === null) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Discovery sources
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect a data source so campaigns can discover companies matching
            your ICP. Keys are stored encrypted and never shown again.
          </p>
        </div>

        <ApolloConnectorCard status={status} onConnected={() => void load()} />
        <SnovConnectorCard status={snovStatus} onConnected={() => void load()} />
      </section>
    </div>
  );
}

function ApolloConnectorCard({
  status,
  onConnected,
}: {
  status: ApolloAccountStatus;
  onConnected: () => void;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await connectApollo(trimmed);
      setApiKey('');
      onConnected();
    } catch (err) {
      // The API returns a 400 with a human reason for a rejected key.
      setError(
        err instanceof ApiError
          ? err.body.replace(/^.*?:\s*/, '') || `Request failed (${err.status})`
          : formatError(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-muted-foreground" />
            Apollo
          </CardTitle>
          <ApolloStatusBadge status={status} />
        </div>
        <CardDescription>
          {!status.available
            ? 'Apollo discovery is available on self-hosted getbeyond only — its API terms don’t permit a hosted integration.'
            : status.connected
              ? 'A key is configured. Discovery runs against Apollo for new campaigns. Paste a new key to replace it.'
              : 'Add your Apollo API key to discover companies matching each campaign’s ICP. Find it in Apollo under Settings → Integrations → API.'}
        </CardDescription>
      </CardHeader>
      {status.available ? (
        <CardContent>
          <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
            <div className="min-w-[16rem] flex-1 space-y-1">
              <label htmlFor="apollo-api-key" className="text-xs font-medium">
                Apollo API key
              </label>
              <Input
                id="apollo-api-key"
                type="password"
                autoComplete="off"
                placeholder={status.connected ? '••••••••••••' : 'Paste key…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={submitting}
              />
            </div>
            <Button type="submit" disabled={submitting || !apiKey.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" /> Validating…
                </>
              ) : status.connected ? (
                <>Replace key</>
              ) : (
                <>Connect</>
              )}
            </Button>
          </form>
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

function ApolloStatusBadge({
  status,
}: {
  status: ApolloAccountStatus;
}): React.JSX.Element {
  if (!status.available) {
    return (
      <Badge variant="outline">
        <Info className="mr-1 h-3 w-3" />
        Self-host only
      </Badge>
    );
  }
  if (!status.connected) {
    return <Badge variant="outline">Not connected</Badge>;
  }
  // Connected but the account isn't active (expired key / tripped circuit).
  if (status.status && status.status !== 'active') {
    return (
      <Badge variant="warning">
        <TriangleAlert className="mr-1 h-3 w-3" />
        Needs attention
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <Check className="mr-1 h-3 w-3" />
      Connected
    </Badge>
  );
}

function SnovConnectorCard({
  status,
  onConnected,
}: {
  status: SnovAccountStatus;
  onConnected: () => void;
}): React.JSX.Element {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = clientId.trim().length > 0 && clientSecret.trim().length > 0;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await connectSnov(clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      onConnected();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.body.replace(/^.*?:\s*/, '') || `Request failed (${err.status})`
          : formatError(err),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-muted-foreground" />
            Snov.io
          </CardTitle>
          <SnovStatusBadge status={status} />
        </div>
        <CardDescription>
          {status.connected
            ? 'Credentials are configured. Snov finds contacts + verified emails for the company domains you import. Paste new credentials to replace them.'
            : 'Add your Snov API credentials to find contacts and verified emails for a list of company domains. Find them in Snov under Settings → API.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
          <div className="min-w-[14rem] flex-1 space-y-1">
            <label htmlFor="snov-client-id" className="text-xs font-medium">
              API User ID
            </label>
            <Input
              id="snov-client-id"
              type="text"
              autoComplete="off"
              placeholder={status.connected ? '••••••••••••' : 'Paste user ID…'}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="min-w-[14rem] flex-1 space-y-1">
            <label htmlFor="snov-client-secret" className="text-xs font-medium">
              API Secret
            </label>
            <Input
              id="snov-client-secret"
              type="password"
              autoComplete="off"
              placeholder={status.connected ? '••••••••••••' : 'Paste secret…'}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button type="submit" disabled={submitting || !canSubmit}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" /> Validating…
              </>
            ) : status.connected ? (
              <>Replace credentials</>
            ) : (
              <>Connect</>
            )}
          </Button>
        </form>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function SnovStatusBadge({
  status,
}: {
  status: SnovAccountStatus;
}): React.JSX.Element {
  if (!status.connected) {
    return <Badge variant="outline">Not connected</Badge>;
  }
  if (status.status && status.status !== 'active') {
    return (
      <Badge variant="warning">
        <TriangleAlert className="mr-1 h-3 w-3" />
        Needs attention
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <Check className="mr-1 h-3 w-3" />
      Connected
    </Badge>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError)
    return `${err.status} — ${err.body.slice(0, 200)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
