'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ApiError,
  listDrafts,
  type DraftListItem,
  type DraftStatus,
} from '@/lib/api-client';

/**
 * Drafts inbox. Filterable by status. Each row links to the draft detail
 * page which shows the body + cited claims.
 *
 * This is the human review surface — the v1 "approval queue" is just
 * this page + the detail view. Send / approve buttons land later, after
 * one real send destination (Gmail or Resend) is wired.
 */

const STATUSES: Array<{ key: DraftStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'edited', label: 'Edited' },
  { key: 'sent', label: 'Sent' },
  { key: 'rejected', label: 'Rejected' },
];

const PAGE_SIZE = 25;

export default function DraftsInboxPage(): React.JSX.Element {
  const [items, setItems] = useState<DraftListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<DraftStatus | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (
      nextOffset: number,
      filterStatus: DraftStatus | 'all',
    ): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await listDrafts({
          status: filterStatus === 'all' ? undefined : filterStatus,
          limit: PAGE_SIZE,
          offset: nextOffset,
        });
        setItems(res.items);
        setTotal(res.total);
        setOffset(res.offset);
      } catch (err) {
        setError(formatError(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(0, status);
  }, [load, status]);

  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Home
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Drafts inbox</CardTitle>
          <CardDescription>
            Outputs from every teammate, awaiting your review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <Button
                key={s.key}
                size="sm"
                variant={status === s.key ? 'default' : 'ghost'}
                onClick={() => setStatus(s.key)}
              >
                {s.label}
              </Button>
            ))}
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState status={status} />
          ) : (
            <>
              <ul className="divide-y">
                {items.map((d) => (
                  <DraftRow key={d.id} draft={d} />
                ))}
              </ul>
              <Pagination
                offset={offset}
                limit={PAGE_SIZE}
                total={total}
                onChange={(n) => void load(n, status)}
                disabled={loading}
              />
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function DraftRow({ draft }: { draft: DraftListItem }): React.JSX.Element {
  const recipient = formatRecipient(draft.recipient);
  return (
    <li>
      <Link
        href={`/drafts/${encodeURIComponent(draft.id)}`}
        className="flex items-start justify-between gap-4 py-3 hover:bg-muted/30"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{draft.teammate}</span>
            <span>·</span>
            <span>{draft.type}</span>
            {recipient ? (
              <>
                <span>·</span>
                <span className="truncate">{recipient}</span>
              </>
            ) : null}
          </div>
          <p className="line-clamp-2 text-sm">
            {draft.contentPreview || (
              <span className="italic text-muted-foreground">No preview</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={draft.status} />
          <span className="text-xs text-muted-foreground">
            {formatRelative(draft.createdAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}

function StatusBadge({
  status,
}: {
  status: DraftStatus;
}): React.JSX.Element {
  const variants: Record<DraftStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'secondary',
    approved: 'default',
    edited: 'outline',
    sent: 'default',
    rejected: 'destructive',
    partial: 'destructive',
    failed: 'destructive',
  };
  return <Badge variant={variants[status]}>{status}</Badge>;
}

function Pagination({
  offset,
  limit,
  total,
  onChange,
  disabled,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (nextOffset: number) => void;
  disabled: boolean;
}): React.JSX.Element {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <div>
        {from}–{to} of {total}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function EmptyState({
  status,
}: {
  status: DraftStatus | 'all';
}): React.JSX.Element {
  return (
    <div className="py-16 text-center text-sm text-muted-foreground">
      No {status === 'all' ? '' : status} drafts yet. Start a{' '}
      <Link href="/research/new" className="underline">
        research run
      </Link>{' '}
      or{' '}
      <Link href="/draft/sdr/new" className="underline">
        draft an email
      </Link>{' '}
      to see results here.
    </div>
  );
}

function formatRecipient(recipient: unknown): string {
  if (recipient === null || typeof recipient !== 'object') return '';
  const r = recipient as { email?: unknown; name?: unknown };
  const parts: string[] = [];
  if (typeof r.name === 'string' && r.name) parts.push(r.name);
  if (typeof r.email === 'string' && r.email) parts.push(`<${r.email}>`);
  return parts.join(' ');
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status} — ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
