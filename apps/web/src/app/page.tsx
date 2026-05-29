'use client';

import Link from 'next/link';
import {
  ArrowRight,
  FileText,
  Loader2,
  Mail,
  Search,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useIdentity } from '@/lib/use-identity';

/**
 * Home page.
 *
 * Unauthenticated visitors see the marketing card with a "sign in" CTA.
 * Authenticated users see a workbench with one tile per surface
 * (contacts, research, drafter, drafts inbox, settings).
 */
export default function HomePage(): React.JSX.Element {
  const { status, identity } = useIdentity();

  if (status === 'loading') {
    return (
      <main className="container flex min-h-screen items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (status === 'signed_out' || !identity) {
    return <UnauthenticatedHome />;
  }

  return <Workbench email={identity.email} />;
}

function UnauthenticatedHome(): React.JSX.Element {
  return (
    <main className="container flex min-h-screen flex-col items-center justify-center py-16">
      <div className="mx-auto max-w-2xl space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            AI GTM teammates for solo founders.
          </h1>
          <p className="mx-auto max-w-xl text-lg text-muted-foreground">
            Audit every prompt, every claim, every source — in code and in
            the app.
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link href="/login">
            <Button size="lg">
              Sign in <ArrowRight />
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-6 pt-12 text-left sm:grid-cols-3">
          <Feature
            title="Cite or abstain"
            body="Every claim links to a source the agent actually fetched. The runtime drops claims with no citation — no hallucinations reach the draft."
          />
          <Feature
            title="Open source"
            body="AGPLv3. Read the prompts, audit the tool calls, fork it if you want. The trust positioning is enforced by the code, not the marketing."
          />
          <Feature
            title="Cost-aware by design"
            body="Per-run budget cap, model + tool costs logged on every call, audit log primary in the schema. Solo founders can afford to run this."
          />
        </div>
      </div>
    </main>
  );
}

function Workbench({ email }: { email: string | null }): React.JSX.Element {
  return (
    <main className="container space-y-8 py-12">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Workbench</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {email ?? 'unknown'}.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          href="/contacts"
          icon={<Users className="h-4 w-4" />}
          title="Contacts"
          body="Browse the people in your org. Run Researcher or SDR Drafter against any row."
        />
        <Tile
          href="/research/new"
          icon={<Search className="h-4 w-4" />}
          title="Run Researcher"
          body="Cited research brief on any person or company."
        />
        <Tile
          href="/draft/sdr/new"
          icon={<Mail className="h-4 w-4" />}
          title="Draft an email"
          body="SDR Drafter writes one cold-outreach email per contact."
        />
        <Tile
          href="/drafts"
          icon={<FileText className="h-4 w-4" />}
          title="Drafts inbox"
          body="Review what your teammates have produced. Every claim has a citation or is flagged abstained."
        />
        <Tile
          href="/settings/team"
          icon={<Users className="h-4 w-4" />}
          title="Team settings"
          body="Invite teammates, manage roles."
        />
      </div>
    </main>
  );
}

function Tile({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <Link href={href} className="block group">
      <Card className="h-full transition-colors group-hover:border-foreground/30">
        <CardHeader className="space-y-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </div>
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
            Open <ArrowRight className="h-3 w-3" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

function Feature({
  title,
  body,
}: {
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
