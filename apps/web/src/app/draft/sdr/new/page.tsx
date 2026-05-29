'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
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
  lookupContactByEmail,
  postSdrDrafterRun,
} from '@/lib/api-client';

/**
 * Start an SDR Drafter run.
 *
 * Inputs:
 *   - contact email (resolved server-side to a Contact.id via /contacts/lookup)
 *   - optional briefDraftId (URL param ?brief= — populated when navigating
 *     here from a finished Researcher run)
 *   - optional founder angle ("intro for case study", "follow-up on pricing")
 */
export default function SdrDrafterNewPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <main className="container flex min-h-screen items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </main>
      }
    >
      <SdrDrafterForm />
    </Suspense>
  );
}

function SdrDrafterForm(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const briefDraftId = params.get('brief') ?? '';

  const [email, setEmail] = useState(params.get('email') ?? '');
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const contact = await lookupContactByEmail(email.trim());
      const { runId } = await postSdrDrafterRun({
        contactId: contact.id,
        briefDraftId: briefDraftId || undefined,
        goal: goal.trim() || undefined,
      });
      router.push(`/draft/sdr/${encodeURIComponent(runId)}`);
    } catch (err) {
      setSubmitting(false);
      setError(formatError(err, email.trim()));
    }
  }

  return (
    <main className="container space-y-6 py-12">
      <Link
        href="/research/new"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle>Draft an outreach email</CardTitle>
          <CardDescription>
            Enter the recipient&apos;s email — they need to already be in
            your contacts (via HubSpot sync or CSV import).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Recipient email
              </label>
              <Input
                id="email"
                type="email"
                autoFocus
                required
                placeholder="sarah@acme.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="goal" className="text-sm font-medium">
                Angle <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="goal"
                placeholder="follow-up on pricing question · intro for our case study"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                A short note on what the email is for. Leave blank for a
                cold intro.
              </p>
            </div>

            {briefDraftId ? (
              <div className="rounded-md border border-muted bg-muted/30 p-3 text-xs text-muted-foreground">
                Using research brief{' '}
                <span className="font-mono">{briefDraftId}</span> as context.
              </div>
            ) : null}

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting || !email.trim()}>
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" /> Starting…
                  </>
                ) : (
                  <>Draft →</>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function formatError(err: unknown, email: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404 && err.body.includes('contact')) {
      return `No contact in your org matches ${email}. Import them first (HubSpot sync or CSV).`;
    }
    return `${err.status} — ${err.body.slice(0, 200)}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
