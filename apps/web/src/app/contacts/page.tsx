'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ApiError,
  listContacts,
  type ContactListItem,
} from '@/lib/api-client';

/**
 * Contacts table — the entry point for testing the teammates against real
 * data. Each row has "Research" and "Draft email" actions that pre-fill
 * the corresponding teammate form.
 *
 * CSV upload UI is intentionally not here yet: the import endpoint requires
 * a ConnectorAccount of kind 'csv' and a column mapping, neither of which
 * has a setup UI. Seeding contacts via Prisma Studio / SQL works for now;
 * a guided CSV flow lands with the connectors module.
 */

const PAGE_SIZE = 25;

export default function ContactsPage(): React.JSX.Element {
  const [items, setItems] = useState<ContactListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [pendingQ, setPendingQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextOffset: number, query: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await listContacts({
          limit: PAGE_SIZE,
          offset: nextOffset,
          q: query || undefined,
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
    void load(0, '');
  }, [load]);

  function onSearch(e: React.FormEvent): void {
    e.preventDefault();
    setQ(pendingQ);
    void load(0, pendingQ);
  }

  function gotoPage(nextOffset: number): void {
    void load(nextOffset, q);
  }

  return (
    <main className="container space-y-6 py-12">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Contacts</CardTitle>
            <CardDescription>
              People in your org. Run Researcher or SDR Drafter against any
              row.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <form
              onSubmit={onSearch}
              className="flex items-center gap-2"
              role="search"
            >
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={pendingQ}
                  onChange={(e) => setPendingQ(e.target.value)}
                  placeholder="Search name, email, company"
                  className="pl-7 w-72"
                  aria-label="Search contacts"
                />
              </div>
              <Button type="submit" variant="secondary" size="sm">
                Search
              </Button>
            </form>
            <Link href="/contacts/import">
              <Button size="sm">
                <Upload className="h-3.5 w-3.5" />
                Import CSV
              </Button>
            </Link>
          </div>
        </CardHeader>

        <CardContent>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState hasQuery={q.length > 0} />
          ) : (
            <>
              <ContactsTable items={items} />
              <Pagination
                offset={offset}
                limit={PAGE_SIZE}
                total={total}
                onChange={gotoPage}
                disabled={loading}
              />
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function ContactsTable({
  items,
}: {
  items: ContactListItem[];
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">Email</th>
            <th className="py-2 pr-3 font-medium">Title</th>
            <th className="py-2 pr-3 font-medium">Company</th>
            <th className="py-2 pr-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((c) => (
            <ContactRow key={c.id} contact={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContactRow({ contact }: { contact: ContactListItem }): React.JSX.Element {
  const name =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—';
  const email = contact.primaryEmail ?? '';
  const researchTarget = email
    ? email
    : [name, contact.company].filter((v) => v && v !== '—').join(' at ');

  return (
    <tr className="hover:bg-muted/30">
      <td className="py-2 pr-3">
        <div className="font-medium">{name}</div>
        {contact.linkedinUrl ? (
          <a
            href={contact.linkedinUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            LinkedIn <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </td>
      <td className="py-2 pr-3 font-mono text-xs">{email || '—'}</td>
      <td className="py-2 pr-3 text-muted-foreground">
        {contact.title ?? '—'}
      </td>
      <td className="py-2 pr-3 text-muted-foreground">
        {contact.company ?? '—'}
      </td>
      <td className="py-2 pr-3 text-right">
        <div className="inline-flex items-center gap-2">
          <Link
            href={`/research/new?target=${encodeURIComponent(researchTarget)}`}
          >
            <Button variant="secondary" size="sm">
              Research
            </Button>
          </Link>
          {email ? (
            <Link
              href={`/draft/sdr/new?email=${encodeURIComponent(email)}`}
            >
              <Button size="sm">Draft email</Button>
            </Link>
          ) : null}
        </div>
      </td>
    </tr>
  );
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
    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
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

function EmptyState({ hasQuery }: { hasQuery: boolean }): React.JSX.Element {
  if (hasQuery) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        No contacts match your search.
      </div>
    );
  }
  return (
    <div className="space-y-3 py-16 text-center">
      <p className="text-sm font-medium">No contacts yet.</p>
      <p className="text-xs text-muted-foreground">
        Import a CSV to get started.
      </p>
      <Link href="/contacts/import" className="inline-block">
        <Button size="sm">
          <Upload className="h-3.5 w-3.5" />
          Import CSV
        </Button>
      </Link>
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.status} — ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
