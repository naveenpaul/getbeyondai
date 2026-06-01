'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Brain, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Shared shell for the Settings section. Renders a serif section heading plus
 * a small tab row so the settings sub-pages (Team, AI) reach each other —
 * previously /settings/team was only linked from the user menu and /settings/ai
 * had no entry point at all.
 *
 * A tab is active when the pathname matches its href exactly or sits beneath
 * it, mirroring the active-section logic in AppNav.
 */

interface SettingsTab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SETTINGS_TABS: readonly SettingsTab[] = [
  { href: '/settings/team', label: 'Team', icon: Users },
  { href: '/settings/ai', label: 'AI', icon: Brain },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();

  return (
    <div className="container py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <nav
        aria-label="Settings"
        className="mt-4 flex items-center gap-1 border-b border-border/60"
      >
        {SETTINGS_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = isActive(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-8">{children}</div>
    </div>
  );
}
