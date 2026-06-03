'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  FileText,
  Mail,
  Menu,
  Megaphone,
  Search,
  Users,
  X,
} from 'lucide-react';
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
 * The desktop nav (`hidden sm:flex`) is the primary affordance. Below the
 * `sm` breakpoint it collapses behind a hamburger button that toggles a
 * panel exposing the same four items with the same active highlight; the
 * panel closes on navigation.
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
  // Campaigns is the home/primary surface. Its `match` is '/' but we special-
  // case the home route in `isActive` so it doesn't light up under every path.
  { href: '/', label: 'Prospects', icon: Megaphone, match: '/campaigns' },
  { href: '/contacts', label: 'Contacts', icon: Users, match: '/contacts' },
  { href: '/research/new', label: 'Researcher', icon: Search, match: '/research' },
  { href: '/draft/sdr/new', label: 'SDR Drafter', icon: Mail, match: '/draft' },
  { href: '/drafts', label: 'Drafts', icon: FileText, match: '/drafts' },
];

const MOBILE_NAV_PANEL_ID = 'app-nav-mobile-panel';

/**
 * True when `pathname` falls within the section rooted at `match`. The
 * Campaigns section spans both the home list (`/`, which IS the campaign list)
 * and the `/campaigns/...` detail routes, so it gets a small special case.
 */
function isActive(pathname: string, match: string): boolean {
  if (match === '/campaigns') {
    return pathname === '/' || pathname === '/campaigns' || pathname.startsWith('/campaigns/');
  }
  return pathname === match || pathname.startsWith(`${match}/`);
}

export function AppNav(): React.JSX.Element {
  const pathname = usePathname();
  const { status } = useIdentity();
  const signedIn = status === 'authenticated';
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile panel whenever the route changes (navigation) so it
  // never lingers open over a freshly loaded page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <header className="border-b border-border/60">
      <div className="container flex h-12 items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          {signedIn ? (
            <button
              type="button"
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileOpen}
              aria-controls={MOBILE_NAV_PANEL_ID}
              onClick={() => setMobileOpen((open) => !open)}
              className="-ml-1.5 inline-flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground sm:hidden"
            >
              {mobileOpen ? (
                <X className="h-3.5 w-3.5" />
              ) : (
                <Menu className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <Link href="/" className="text-sm font-semibold tracking-tight">
            getbeyond ai
          </Link>
          {signedIn ? (
            <nav
              aria-label="Primary"
              className="hidden items-center gap-1 sm:flex"
            >
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  active={isActive(pathname, item.match)}
                />
              ))}
            </nav>
          ) : null}
        </div>
        <UserMenu />
      </div>

      {signedIn && mobileOpen ? (
        <nav
          id={MOBILE_NAV_PANEL_ID}
          aria-label="Primary"
          className="border-t border-border/60 sm:hidden"
        >
          <div className="container flex flex-col gap-1 py-2">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(pathname, item.match)}
                onClick={() => setMobileOpen(false)}
              />
            ))}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

/**
 * A single nav entry, shared by the desktop bar and the mobile panel so the
 * active-section highlight and styling stay identical across both.
 */
function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
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
}
