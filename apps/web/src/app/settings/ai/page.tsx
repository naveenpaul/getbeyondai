'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Info, Loader2, X } from 'lucide-react';
import type {
  LlmProviderName,
  LlmProviderStatus,
  LlmSettingsResponse,
  TeammateRoutingConfig,
  TestLlmCredentialResponse,
} from '@getbeyond/shared';
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
  getLlmSettings,
  saveLlmCredential,
  saveLlmRouting,
  testLlmCredential,
} from '@/lib/api-client';

/**
 * Settings → AI. Two concerns, two sections:
 *
 *   1. Provider keys — the org brings its own key per provider. The API only
 *      ever reports whether a key is configured (never the key), so this page
 *      shows a "Connected" badge for configured providers and a masked
 *      password input to set/replace the key. Nothing here can leak a secret.
 *   2. Teammate routing — each teammate is routed to a provider (and optional
 *      model overrides). A teammate uses its routed provider's key at run time.
 *
 * State is held as the full settings response and patched in place after each
 * save, avoiding a full refetch round-trip on every mutation.
 */

const PROVIDER_LABELS: Record<LlmProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/** Provider order for the routing <select>; mirrors LlmProviderName. */
const PROVIDER_OPTIONS: readonly LlmProviderName[] = ['anthropic', 'openai'];

export default function AiSettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<LlmSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await getLlmSettings());
    } catch (err) {
      setLoadError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Patch a single provider's configured status in place after a key save.
  const markProviderConfigured = useCallback((provider: LlmProviderName) => {
    setSettings((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            providers: prev.providers.map((p) =>
              p.provider === provider ? { ...p, configured: true } : p,
            ),
          },
    );
  }, []);

  // Replace a teammate's routing config in place after a routing save.
  const applyRouting = useCallback((next: TeammateRoutingConfig) => {
    setSettings((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            teammates: prev.teammates.map((t) =>
              t.teammate === next.teammate ? next : t,
            ),
          },
    );
  }, []);

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

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Provider keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Bring your own key for each provider. Keys are stored encrypted and
            never shown again — we only report whether one is configured.
          </p>
        </div>

        {settings.envFallbackEnabled ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Self-host env fallback is active; org keys override it.
            </span>
          </div>
        ) : null}

        <div className="space-y-4">
          {settings.providers.map((status) => (
            <ProviderKeyCard
              key={status.provider}
              status={status}
              onSaved={() => markProviderConfigured(status.provider)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Teammate routing
          </h2>
          <p className="text-sm text-muted-foreground">
            Route each teammate to a provider. A teammate uses its routed
            provider&apos;s key, and changes take effect on the teammate&apos;s
            next run.
          </p>
        </div>

        <Card>
          <CardContent className="pt-6">
            {settings.teammates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No teammates to route yet.
              </p>
            ) : (
              <ul className="divide-y">
                {settings.teammates.map((config) => (
                  <TeammateRoutingRow
                    key={config.teammate}
                    config={config}
                    providerDefaults={settings.providerDefaults}
                    onSaved={applyRouting}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ProviderKeyCard({
  status,
  onSaved,
}: {
  status: LlmProviderStatus;
  onSaved: () => void;
}): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // Result of the last live verify this session. Null until the user tests —
  // we don't auto-verify on load (a provider call per card per page load).
  const [testResult, setTestResult] = useState<TestLlmCredentialResponse | null>(
    null,
  );

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await saveLlmCredential({ provider: status.provider, apiKey: trimmed });
      setApiKey('');
      // The save path already verified the key (a bad key is rejected with a
      // 400), so a successful save means it authenticated.
      setTestResult({ provider: status.provider, ok: true, error: null });
      onSaved();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onTest(): Promise<void> {
    setTesting(true);
    setError(null);
    try {
      setTestResult(await testLlmCredential(status.provider));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setTesting(false);
    }
  }

  const inputId = `api-key-${status.provider}`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">
            {PROVIDER_LABELS[status.provider]}
          </CardTitle>
          <KeyStatusBadge configured={status.configured} test={testResult} />
        </div>
        <CardDescription>
          {status.configured
            ? 'A key is configured. Test it below, or save a new key to replace it.'
            : 'Add a key to enable this provider.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
          <div className="min-w-[16rem] flex-1 space-y-1">
            <label htmlFor={inputId} className="text-xs font-medium">
              API key
            </label>
            <Input
              id={inputId}
              type="password"
              autoComplete="off"
              placeholder={status.configured ? '••••••••••••' : 'sk-…'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button type="submit" disabled={submitting || !apiKey.trim()}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" /> Saving…
              </>
            ) : (
              <>Save key</>
            )}
          </Button>
          {status.configured ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void onTest()}
              disabled={testing || submitting}
            >
              {testing ? (
                <>
                  <Loader2 className="animate-spin" /> Testing…
                </>
              ) : (
                <>Test key</>
              )}
            </Button>
          ) : null}
        </form>
        {testResult && !testResult.ok && testResult.error ? (
          <p className="mt-2 text-sm text-destructive">{testResult.error}</p>
        ) : null}
        {testResult?.ok ? (
          <p className="mt-2 text-sm text-emerald-600">
            Key verified — it authenticates with {PROVIDER_LABELS[status.provider]}.
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Honest key status. The plain "a key is stored" state is deliberately NOT green
 * — green is reserved for a key that actually authenticated (a passed test or a
 * just-saved key, which the save path verifies). This is the fix for a stored-
 * but-invalid key masquerading as "Connected".
 */
function KeyStatusBadge({
  configured,
  test,
}: {
  configured: boolean;
  test: TestLlmCredentialResponse | null;
}): React.JSX.Element {
  if (test) {
    return test.ok ? (
      <Badge variant="success">
        <Check className="mr-1 h-3 w-3" />
        Verified
      </Badge>
    ) : (
      <Badge variant="destructive">
        <X className="mr-1 h-3 w-3" />
        Invalid key
      </Badge>
    );
  }
  if (configured) {
    return <Badge variant="secondary">Key stored — untested</Badge>;
  }
  return <Badge variant="outline">Not configured</Badge>;
}

function TeammateRoutingRow({
  config,
  providerDefaults,
  onSaved,
}: {
  config: TeammateRoutingConfig;
  providerDefaults: LlmSettingsResponse['providerDefaults'];
  onSaved: (next: TeammateRoutingConfig) => void;
}): React.JSX.Element {
  const [provider, setProvider] = useState<LlmProviderName>(config.provider);
  const [modelPrimary, setModelPrimary] = useState(config.modelPrimary);
  const [modelFast, setModelFast] = useState(config.modelFast);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching provider resets the model fields to the new provider's defaults.
  // Model ids are provider-specific (an OpenAI route can't use a Claude id), so
  // carrying the old provider's ids over would persist an invalid combo. The
  // user can still type an override before saving.
  function onProviderChange(next: LlmProviderName): void {
    setProvider(next);
    setModelPrimary(providerDefaults[next].modelPrimary);
    setModelFast(providerDefaults[next].modelFast);
  }

  // Dirty when any field diverges from the persisted config — gates the Save
  // button so unchanged rows can't fire a no-op PUT.
  const dirty =
    provider !== config.provider ||
    modelPrimary !== config.modelPrimary ||
    modelFast !== config.modelFast;

  async function onSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const trimmedPrimary = modelPrimary.trim();
      const trimmedFast = modelFast.trim();
      const saved = await saveLlmRouting({
        teammate: config.teammate,
        provider,
        // Omit empty model fields so the server applies provider defaults.
        ...(trimmedPrimary ? { modelPrimary: trimmedPrimary } : {}),
        ...(trimmedFast ? { modelFast: trimmedFast } : {}),
      });
      onSaved(saved);
      // Reflect any server-applied defaults back into the inputs.
      setProvider(saved.provider);
      setModelPrimary(saved.modelPrimary);
      setModelFast(saved.modelFast);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const baseId = `routing-${config.teammate}`;

  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1 space-y-1">
          <span className="text-sm font-medium">
            {humanizeTeammate(config.teammate)}
          </span>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${baseId}-provider`} className="text-xs font-medium">
            Provider
          </label>
          <select
            id={`${baseId}-provider`}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as LlmProviderName)}
            disabled={submitting}
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${baseId}-primary`} className="text-xs font-medium">
            Primary model
          </label>
          <Input
            id={`${baseId}-primary`}
            className="w-44"
            placeholder="Provider default"
            value={modelPrimary}
            onChange={(e) => setModelPrimary(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${baseId}-fast`} className="text-xs font-medium">
            Fast model
          </label>
          <Input
            id={`${baseId}-fast`}
            className="w-44"
            placeholder="Provider default"
            value={modelFast}
            onChange={(e) => setModelFast(e.target.value)}
            disabled={submitting}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => void onSave()}
          disabled={submitting || !dirty}
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" /> Saving…
            </>
          ) : (
            <>Save</>
          )}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </li>
  );
}

/**
 * Turns a teammate slug (`sdr-drafter`, `sdr_drafter`) into a display label
 * (`Sdr Drafter`). The contract leaves `teammate` as a free-form string, so we
 * humanize rather than map a fixed enum — unknown teammates still render
 * sensibly. Pure; a unit-test target if a web test runner is added.
 */
function humanizeTeammate(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatError(err: unknown): string {
  if (err instanceof ApiError)
    return `${err.status} — ${err.body.slice(0, 200)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
