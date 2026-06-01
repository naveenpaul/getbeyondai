'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileText, Mail, Search, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UserMenu } from '@/components/UserMenu';
import { useIdentity } from '@/lib/use-identity';

/**
 * Persistent navigation for the authenticated app shell.
 *
 * Renders the logo (always) plus a primary nav + user menu (only when
 * signed in). The current section is highlighted by matching the active
 * pathname against each item's `match` prefix — so deep routes like
 * `/research/new` light up "Researcher" and `/draft/sdr/new` lights up
 * "SDR Drafter". This replaces the ad-hoc per-page back-links that made
 * the five surfaces feel like separate islands.
 *
 * Visibility mirrors the old UserMenu contract: nothing app-specific shows
 * while the session is loading or on signed-out/landing/login — just the
 * logo, as before.
 */

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Pathname prefix that marks this section active. Distinct from `href`
   * because the nav points at the entry route (e.g. `/research/new`) while
   * the section spans every route under its base (e.g. `/research/...`).
   */
  match: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/contacts', label: 'Contacts', icon: Users, match: '/contacts' },
  { href: '/research/new', label: 'Researcher', icon: Search, match: '/research' },
  { href: '/draft/sdr/new', label: 'SDR Drafter', icon: Mail, match: '/draft' },
  { href: '/drafts', label: 'Drafts', icon: FileText, match: '/drafts' },
];

/** True when `pathname` falls within the section rooted at `match`. */
function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

export function AppNav(): React.JSX.Element {
  const pathname = usePathname();
  const { status } = useIdentity();
  const signedIn = status === 'authenticated';

  return (
    <header className="border-b border-border/60">
      <div className="container flex h-12 items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            getbeyond ai
          </Link>
          {signedIn ? (
            <nav
              aria-label="Primary"
              className="hidden items-center gap-1 sm:flex"
            >
              {NAV_ITEMS.map((item) => {
                const active = isActive(pathname, item.match);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          ) : null}
        </div>
        <UserMenu />
      </div>
    </header>
  );
}
