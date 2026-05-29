'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  ApiError,
  getDraft,
  type DraftDetailResponse,
} from '@/lib/api-client';

/**
 * Single-draft detail view. Shows the rendered body + every Claim the
 * teammate emitted, each tied to its Citation. This is the trust
 * surface: you can see exactly what the teammate fetched to back every
 * factual statement.
 */
export default function DraftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const [draft, setDraft] = useState<DraftDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const res = await getDraft(id);
        if (!aborted) setDraft(res);
      } catch (err) {
        if (!aborted) setError(formatError(err));
      } finally {
        if (!aborted) setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [id]);

  if (loading) {
    return (
      <main className="container flex min-h-screen items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (error || !draft) {
    return (
      <main className="container space-y-6 py-12">
        <Link
          href="/drafts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Inbox
        </Link>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? 'Draft not found.'}
        </div>
      </main>
    );
  }

  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/drafts"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Inbox
      </Link>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="capitalize">
                {draft.type.replace(/_/g, ' ')}
              </CardTitle>
              <CardDescription className="font-mono text-xs">
                {draft.teammate} · {draft.id}
              </CardDescription>
            </div>
            <Badge variant="secondary">{draft.status}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <RecipientLine recipient={draft.recipient} />
          <Separator />
          <DraftBody content={draft.content} />
          <Separator />
          <ClaimsList claims={draft.claims} />
        </CardContent>
      </Card>
    </main>
  );
}

function RecipientLine({
  recipient,
}: {
  recipient: unknown;
}): React.JSX.Element | null {
  if (recipient === null || typeof recipient !== 'object') return null;
  const r = recipient as { email?: unknown; name?: unknown };
  const email = typeof r.email === 'string' ? r.email : null;
  const name = typeof r.name === 'string' ? r.name : null;
  if (!email && !name) return null;
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">To: </span>
      {name ? <span className="font-medium">{name}</span> : null}
      {name && email ? ' ' : null}
      {email ? (
        <span className="font-mono text-xs text-muted-foreground">
          &lt;{email}&gt;
        </span>
      ) : null}
    </div>
  );
}

function DraftBody({ content }: { content: unknown }): React.JSX.Element {
  if (content === null || typeof content !== 'object') {
    return (
      <p className="text-sm italic text-muted-foreground">
        No body content.
      </p>
    );
  }
  const c = content as Record<string, unknown>;
  const subject = typeof c.subject === 'string' ? c.subject : null;
  const headline = typeof c.headline === 'string' ? c.headline : null;
  const body =
    typeof c.body === 'string'
      ? c.body
      : typeof c.content === 'string'
        ? c.content
        : null;

  return (
    <div className="space-y-3">
      {subject ? (
        <div>
          <div className="text-xs uppercase text-muted-foreground">
            Subject
          </div>
          <p className="text-sm font-medium">{subject}</p>
        </div>
      ) : null}
      {headline ? (
        <div>
          <div className="text-xs uppercase text-muted-foreground">
            Headline
          </div>
          <p className="text-sm font-medium">{headline}</p>
        </div>
      ) : null}
      {body ? (
        <div>
          <div className="text-xs uppercase text-muted-foreground">
            {subject ? 'Body' : 'Content'}
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{body}</p>
        </div>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          No body content.
        </p>
      )}
    </div>
  );
}

function ClaimsList({
  claims,
}: {
  claims: DraftDetailResponse['claims'];
}): React.JSX.Element {
  if (claims.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No claims attached to this draft.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-xs uppercase text-muted-foreground">
        Claims ({claims.length})
      </div>
      <ul className="space-y-3">
        {claims.map((claim) => (
          <li
            key={claim.id}
            className="rounded-md border border-border/60 p-3 text-sm"
          >
            <div className="flex items-start gap-2">
              {claim.abstained ? (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="leading-snug">{claim.text}</p>
                {claim.abstained ? (
                  <div className="text-xs italic text-amber-700">
                    Abstained — teammate flagged this as unverifiable.
                  </div>
                ) : claim.citation ? (
                  <a
                    href={claim.citation.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded border border-border/40 bg-muted/30 p-2 text-xs hover:bg-muted/60"
                  >
                    <div className="flex items-center gap-1 font-medium">
                      {claim.citation.title ?? claim.citation.url}
                      <ExternalLink className="h-3 w-3" />
                    </div>
                    <div className="truncate font-mono text-muted-foreground">
                      {claim.citation.url}
                    </div>
                    {claim.citation.excerpt ? (
                      <p className="mt-1 line-clamp-3 italic text-muted-foreground">
                        &ldquo;{claim.citation.excerpt}&rdquo;
                      </p>
                    ) : null}
                  </a>
                ) : (
                  <div className="text-xs italic text-destructive">
                    No citation attached — runtime should have dropped this
                    claim.
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Draft not found in your org.';
    return `${err.status} — ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
