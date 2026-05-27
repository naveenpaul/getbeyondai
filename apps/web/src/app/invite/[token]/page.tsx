'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MailCheck, ShieldAlert } from 'lucide-react';
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
  acceptInvite,
  ApiError,
  type InviteLookupResponse,
  lookupInvite,
  switchActiveOrg,
} from '@/lib/api-client';
import { signIn, useSession } from '@/lib/auth-client';

/**
 * Invite landing.
 *
 *   1. Fetch the invite metadata (public endpoint).
 *   2. If signed in with matching email → "Accept" button → POST accept
 *      → flip active org → land on /research/new.
 *   3. If signed in with a different email → tell the user to sign out
 *      and try again with the invited address.
 *   4. If signed out → magic-link form pre-filled with the invited email
 *      (locked). After sign-in, the user.create hook detours new accounts
 *      straight into the inviting org; the page re-renders post-redirect
 *      and the user can click Accept to complete (or land already-attached).
 *
 * Expired / revoked / accepted invites show terminal messages with no CTA.
 */
export default function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): React.JSX.Element {
  const { token } = use(params);
  const session = useSession();

  const [invite, setInvite] = useState<InviteLookupResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await lookupInvite(token);
        if (!cancelled) setInvite(result);
      } catch (err) {
        if (cancelled) return;
        setLookupError(
          err instanceof ApiError
            ? err.status === 404
              ? 'This invite link is not valid.'
              : `${err.status} — ${err.body.slice(0, 200)}`
            : err instanceof Error
              ? err.message
              : 'Unknown error',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="container flex min-h-screen items-center justify-center py-12">
      <Card className="w-full max-w-md">
        {lookupError ? (
          <Terminal title="Invite unavailable" message={lookupError} />
        ) : !invite || session.isPending ? (
          <Loading />
        ) : invite.status !== 'pending' ? (
          <Terminal
            title={
              invite.status === 'accepted'
                ? 'Already accepted'
                : invite.status === 'expired'
                  ? 'Invite expired'
                  : 'Invite revoked'
            }
            message={
              invite.status === 'accepted'
                ? 'This invite has already been accepted. Sign in to access the org.'
                : invite.status === 'expired'
                  ? 'This invite has expired. Ask the admin to send a new one.'
                  : 'This invite has been revoked.'
            }
          />
        ) : session.data ? (
          <AcceptPanel
            token={token}
            invite={invite}
            sessionEmail={
              (session.data.user as { email?: string }).email ?? ''
            }
          />
        ) : (
          <SignInToAcceptPanel invite={invite} token={token} />
        )}
      </Card>
    </main>
  );
}

function Loading(): React.JSX.Element {
  return (
    <CardContent className="flex items-center justify-center py-10">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </CardContent>
  );
}

function Terminal({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.JSX.Element {
  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </>
  );
}

function AcceptPanel({
  token,
  invite,
  sessionEmail,
}: {
  token: string;
  invite: InviteLookupResponse;
  sessionEmail: string;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailMatches =
    sessionEmail.toLowerCase() === invite.invitedEmail.toLowerCase();

  async function onAccept(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { orgId } = await acceptInvite(token);
      await switchActiveOrg(orgId);
      router.replace('/research/new');
    } catch (err) {
      setSubmitting(false);
      setError(
        err instanceof ApiError
          ? `${err.status} — ${err.body.slice(0, 200)}`
          : err instanceof Error
            ? err.message
            : 'Unknown error',
      );
    }
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Join {invite.orgName ?? 'this organization'}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as <strong>{invite.role}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!emailMatches ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            This invite is for <strong>{invite.invitedEmail}</strong> but
            you&apos;re signed in as <strong>{sessionEmail}</strong>. Sign out
            and sign in with the invited address.
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Button
          className="w-full"
          onClick={onAccept}
          disabled={submitting || !emailMatches}
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" /> Accepting…
            </>
          ) : (
            <>Accept invite</>
          )}
        </Button>
      </CardContent>
    </>
  );
}

function SignInToAcceptPanel({
  invite,
  token,
}: {
  invite: InviteLookupResponse;
  token: string;
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // After sign-in we come back to this page (the user.create hook
      // attaches new users straight into the inviting org; existing users
      // will see the Accept button when they return).
      const { error: signInError } = await signIn.magicLink({
        email: invite.invitedEmail,
        callbackURL: `/invite/${token}`,
      });
      if (signInError) {
        setError(signInError.message ?? 'Could not send magic link');
        setSubmitting(false);
        return;
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Join {invite.orgName ?? 'this organization'}</CardTitle>
        <CardDescription>
          You&apos;ve been invited to join as <strong>{invite.role}</strong>.
          Sign in to accept.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <MailCheck className="h-4 w-4" />
              <span>Magic link sent to {invite.invitedEmail}</span>
            </div>
            <p className="text-muted-foreground">
              Open the link from your inbox to finish accepting the invite.
            </p>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="email"
                type="email"
                readOnly
                value={invite.invitedEmail}
                aria-readonly
              />
              <p className="text-xs text-muted-foreground">
                The invite is locked to this address.
              </p>
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" /> Sending…
                </>
              ) : (
                <>Send magic link</>
              )}
            </Button>
          </form>
        )}
      </CardContent>
    </>
  );
}
