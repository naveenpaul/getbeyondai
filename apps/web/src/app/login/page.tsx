'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { signIn, signUp, useSession } from '@/lib/auth-client';

/**
 * Sign-in / sign-up via email + password (T6.3).
 *
 * Email+password is the default because it has no email-transport
 * dependency — a self-hoster can run getbeyond with nothing but Postgres.
 * (The magic-link server route stays available for deployments that have
 * wired an email provider; it just isn't surfaced here.)
 *
 *   1. New user → "Create account": signUp.email({ email, password, name }).
 *      Server autoSignIn mints a session immediately; org + owner membership
 *      are created by databaseHooks (auth.config.ts).
 *   2. Returning user → "Sign in": signIn.email({ email, password }).
 *   3. On success the session cookie is set → redirect to `callbackURL`.
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

type Mode = 'sign-in' | 'sign-up';

/** Friendly default display name from the email local-part. */
function deriveName(email: string): string {
  return email.split('@')[0] || email;
}

function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Clamp `next` to a same-origin relative path. The old magic-link flow
  // handed callbackURL to better-auth, which validates it against
  // trustedOrigins; the client-side router.replace below has no such guard, so
  // an unvalidated `next` (e.g. ?next=https://evil.com or //evil.com) would be
  // an open redirect — phish the user through a real login, then bounce them
  // off-origin. Only accept paths starting with a single '/'.
  const rawNext = searchParams.get('next');
  const callbackURL =
    rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
      ? rawNext
      : '/';

  const session = useSession();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → bounce.
  if (session.data && !session.isPending) {
    router.replace(callbackURL);
    return <></>;
  }

  const canSubmit =
    email.trim().length > 0 && password.length >= 8 && !submitting;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmed = email.trim();
      const { error: authError } =
        mode === 'sign-up'
          ? await signUp.email({
              email: trimmed,
              password,
              name: deriveName(trimmed),
            })
          : await signIn.email({ email: trimmed, password });

      if (authError) {
        setError(
          authError.message ??
            (mode === 'sign-up'
              ? 'Could not create account'
              : 'Invalid email or password'),
        );
        setSubmitting(false);
        return;
      }
      router.replace(callbackURL);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  function toggleMode(): void {
    setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in'));
    setError(null);
  }

  const isSignUp = mode === 'sign-up';

  return (
    <main className="container flex min-h-screen items-center justify-center py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {isSignUp
              ? 'Create your getbeyond ai account'
              : 'Sign in to getbeyond ai'}
          </CardTitle>
          <CardDescription>
            {isSignUp
              ? 'Use your email and a password (at least 8 characters).'
              : 'Sign in with your email and password.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="text-sm font-medium text-foreground"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                placeholder={
                  isSignUp ? 'At least 8 characters' : 'Your password'
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" />{' '}
                  {isSignUp ? 'Creating account…' : 'Signing in…'}
                </>
              ) : isSignUp ? (
                'Create account'
              ) : (
                'Sign in'
              )}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              onClick={toggleMode}
              disabled={submitting}
              className="font-medium text-foreground underline underline-offset-4 hover:no-underline disabled:opacity-50"
            >
              {isSignUp ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
