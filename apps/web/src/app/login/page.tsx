'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { signIn, useSession } from '@/lib/auth-client';

/**
 * Sign-in via email magic link (T6.3).
 *
 *   1. User enters email + clicks "Send magic link"
 *   2. API mints a token, persists Verification, sends the URL
 *      (dev: stdout · prod: Resend — see auth.config.ts)
 *   3. User clicks the link in their inbox → /api/auth/magic-link/verify
 *   4. better-auth sets the session cookie, redirects to `callbackURL`
 *      (defaults to /research/new on first sign-in)
 *
 * If the user is already signed in, redirect immediately.
 */
export default function LoginPage(): React.JSX.Element {
  // useSearchParams is client-only; Next 15's static generation invariant
  // requires it inside a Suspense boundary or the build will refuse to
  // prerender this route.
  return (
    <Suspense
      fallback={
        <main className="container flex min-h-screen items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackURL = searchParams.get('next') ?? '/research/new';

  const session = useSession();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → bounce.
  if (session.data && !session.isPending) {
    router.replace(callbackURL);
    return <></>;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting || !email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: signInError } = await signIn.magicLink({
        email: email.trim(),
        callbackURL,
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
    <main className="container flex min-h-screen items-center justify-center py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to getbeyond</CardTitle>
          <CardDescription>
            We&apos;ll email you a one-tap link. No passwords.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                <MailCheck className="h-4 w-4" />
                <span>Magic link sent to {email}</span>
              </div>
              <p className="text-muted-foreground">
                Click the link from your inbox to finish signing in. The link
                expires in 15 minutes.
              </p>
              <p className="text-xs text-muted-foreground">
                Dev mode? Check the API process stdout — the link prints
                there too.
              </p>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="text-sm font-medium text-foreground"
                >
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  autoFocus
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                />
              </div>

              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !email.trim()}
              >
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
      </Card>
    </main>
  );
}
