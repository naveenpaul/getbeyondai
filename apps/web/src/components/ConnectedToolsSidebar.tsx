'use client';

import { Database, Globe, Search, Wrench } from 'lucide-react';
import type { SourcingConfig } from '@getbeyond/shared';

/**
 * Always-open right rail listing the tools + sources in play for a prospectSearch
 * — the Claude-web-shaped "connected tools" panel.
 *
 * The sourcing source is reflected from the prospectSearch's own SourcingConfig; the
 * runtime tools (web search, page fetch) are a sensible static-for-now list of
 * what the Researcher uses while qualifying prospects. The point is the
 * persistent layout, not a live tool registry — when the backend exposes a
 * per-prospectSearch tool manifest this list can bind to it.
 *
 * Desktop: persistent column (the parent grid keeps it open). Mobile: the
 * parent collapses it below the chat (see the prospectSearch page layout).
 */

interface ConnectedToolsSidebarProps {
  /** The prospectSearch's sourcing config, if known, to label the source row. */
  sourcing?: SourcingConfig | null;
}

interface ToolEntry {
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  detail: string;
}

function describeSource(sourcing?: SourcingConfig | null): ToolEntry {
  if (sourcing?.provider === 'contact_list') {
    return {
      icon: Database,
      name: 'Imported contact list',
      detail: `Prospect pool · list ${sourcing.listId}`,
    };
  }
  if (sourcing?.provider === 'apollo') {
    return {
      icon: Database,
      name: 'Apollo firmographic search',
      detail: 'Prospect pool · reserved (BYO key)',
    };
  }
  if (sourcing?.provider === 'zoominfo') {
    return {
      icon: Database,
      name: 'ZoomInfo company search',
      detail: 'Prospect pool · BYO key (self-host)',
    };
  }
  return {
    icon: Database,
    name: 'Prospect source',
    detail: 'Set when the search starts',
  };
}

const RUNTIME_TOOLS: readonly ToolEntry[] = [
  {
    icon: Search,
    name: 'Web search',
    detail: 'SearXNG · finds firmographic signals',
  },
  {
    icon: Globe,
    name: 'Page fetch',
    detail: 'Reads sources cited in each prospect',
  },
];

export function ConnectedToolsSidebar({
  sourcing,
}: ConnectedToolsSidebarProps): React.JSX.Element {
  const source = describeSource(sourcing);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Wrench className="h-3.5 w-3.5" />
          Connected tools
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          What this prospectSearch can read from while it qualifies prospects.
        </p>
      </div>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Source
        </h3>
        <ToolRow entry={source} />
      </section>

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Runtime tools
        </h3>
        <div className="space-y-2">
          {RUNTIME_TOOLS.map((tool) => (
            <ToolRow key={tool.name} entry={tool} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ToolRow({ entry }: { entry: ToolEntry }): React.JSX.Element {
  const Icon = entry.icon;
  return (
    <div className="flex items-start gap-2.5 rounded-md border bg-card p-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{entry.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {entry.detail}
        </div>
      </div>
    </div>
  );
}
