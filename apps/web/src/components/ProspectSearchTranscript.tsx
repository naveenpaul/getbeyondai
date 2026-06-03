'use client';

import {
  Check,
  CircleAlert,
  Compass,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { QualifiedProspect } from '@getbeyond/shared';
import { Badge } from '@/components/ui/badge';
import { CitationChip } from '@/components/CitationChip';
import { cn } from '@/lib/utils';
import {
  buildProspectSearchTranscript,
  type ProspectSearchRow,
} from '@/lib/prospect-search-transcript';
import type { ProspectSearchEvent } from '@getbeyond/shared';

interface ProspectSearchTranscriptProps {
  events: ProspectSearchEvent[];
  /** True once a terminal prospectSearch event has arrived (stream closed). */
  terminated: boolean;
}

/**
 * Live transcript for a prospectSearch run. Purely view — it derives its rows from
 * the event array via the pure `buildProspectSearchTranscript` reducer, and the SSE
 * subscription lives in the page via useProspectSearchStream.
 *
 * Three row kinds render distinctly: phase lines (icp/sourcing narration),
 * tool lines ("running: <tool>" — the what's-being-run view), and prospect
 * result cards (fitScore + cited claims).
 */
export function ProspectSearchTranscript({
  events,
  terminated,
}: ProspectSearchTranscriptProps): React.JSX.Element {
  const { rows } = buildProspectSearchTranscript(events);

  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {terminated ? (
          'No activity recorded for this search.'
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Starting the prospectSearch…
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <TranscriptRow key={row.key} row={row} />
      ))}
    </div>
  );
}

function TranscriptRow({ row }: { row: ProspectSearchRow }): React.JSX.Element {
  switch (row.kind) {
    case 'phase':
      return (
        <FeedLine
          icon={<Compass className="h-3.5 w-3.5 text-muted-foreground" />}
          primary={row.primary}
          secondary={row.secondary}
        />
      );
    case 'tool':
      return (
        <FeedLine
          icon={
            row.inFlight ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : row.isError ? (
              <CircleAlert className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            )
          }
          primary={row.primary}
          secondary={row.secondary}
          isError={row.isError}
        />
      );
    case 'prospect':
      return (
        <ProspectCard
          prospect={row.prospect}
          index={row.index}
          total={row.total}
        />
      );
    case 'terminal':
      return (
        <div className="flex items-baseline gap-2 pt-1 text-sm">
          <span className="mt-1 self-start">
            {row.isError ? (
              <CircleAlert className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
            )}
          </span>
          <div className="flex flex-1 flex-wrap items-baseline gap-x-2">
            <span className={row.isError ? 'text-destructive' : 'text-foreground'}>
              {row.primary}
            </span>
            {row.secondary ? (
              <span className="text-xs text-muted-foreground">
                {row.secondary}
              </span>
            ) : null}
            <Badge
              variant={row.isError ? 'destructive' : 'success'}
              className="ml-auto"
            >
              {row.isError ? 'failed' : 'completed'}
            </Badge>
          </div>
        </div>
      );
  }
}

function FeedLine({
  icon,
  primary,
  secondary,
  isError,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  isError?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="mt-1 self-start">{icon}</span>
      <div className="flex flex-1 flex-wrap items-baseline gap-x-2">
        <span className={isError ? 'text-destructive' : 'text-foreground'}>
          {primary}
        </span>
        {secondary ? (
          <span className="text-xs text-muted-foreground">{secondary}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A qualified prospect rendered as a result card: name + fit score, the
 * one-line rationale, and the cited firmographic claims. Each cited claim gets
 * a CitationChip; abstained claims render the muted "no source" tag — the
 * cite-or-abstain trust contract surfaced inline.
 */
function ProspectCard({
  prospect,
  index,
  total,
}: {
  prospect: QualifiedProspect;
  index: number;
  total: number;
}): React.JSX.Element {
  // Footnote numbering deduplicated by citationId, mirroring ResearchDraftCard.
  const citationIdToIndex = new Map<string, number>();
  let nextIndex = 1;
  for (const claim of prospect.claims) {
    if (claim.citationId && !citationIdToIndex.has(claim.citationId)) {
      citationIdToIndex.set(claim.citationId, nextIndex++);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-foreground">{prospect.name}</span>
            {prospect.domain ? (
              <span className="truncate font-mono text-xs text-muted-foreground">
                {prospect.domain}
              </span>
            ) : null}
          </div>
          {prospect.linkedinUrl ? (
            <a
              href={prospect.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              LinkedIn
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <FitScore score={prospect.fitScore} />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {index + 1} of {total}
          </span>
        </div>
      </div>

      {prospect.rationale ? (
        <p className="mt-2 text-sm leading-relaxed text-foreground">
          {prospect.rationale}
        </p>
      ) : null}

      {prospect.claims.length > 0 ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          {prospect.claims.map((claim) => {
            const idx = claim.citationId
              ? citationIdToIndex.get(claim.citationId)
              : undefined;
            return (
              <li key={claim.id} className="text-foreground">
                {claim.text}
                {claim.abstained ? (
                  <CitationChip index={0} url={null} abstained />
                ) : idx !== undefined ? (
                  <CitationChip index={idx} url={claim.citationUrl} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <ProspectContacts contacts={prospect.contacts ?? []} />
    </div>
  );
}

/**
 * Stage 5 contacts sourced at a company — who to actually reach out to.
 * Source-agnostic: each contact shows its connector + email verification.
 */
function ProspectContacts({
  contacts,
}: {
  contacts: NonNullable<QualifiedProspect['contacts']>;
}): React.JSX.Element | null {
  if (contacts.length === 0) return null;
  return (
    <div className="mt-3 border-t pt-3">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Contacts ({contacts.length})
      </p>
      <ul className="space-y-1.5 text-sm">
        {contacts.map((c, i) => {
          const name =
            [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '—';
          return (
            <li
              key={`${c.email ?? c.linkedinUrl ?? name}-${i}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="font-medium text-foreground">{name}</span>
              {c.title ? (
                <span className="text-xs text-muted-foreground">{c.title}</span>
              ) : null}
              {c.email ? (
                <span className="font-mono text-xs text-foreground">{c.email}</span>
              ) : null}
              {c.emailVerification === 'verified' ? (
                <span className="text-[11px] font-medium text-emerald-600">
                  ✓ verified
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {c.emailVerification ?? 'unknown'}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">· {c.source}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 0..1 fit/similarity rendered as a percentage badge, color-graded. */
function FitScore({ score }: { score: number }): React.JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  const variant =
    pct >= 75 ? 'success' : pct >= 50 ? 'secondary' : 'warning';
  return (
    <Badge variant={variant} className={cn('tabular-nums')}>
      {pct}% fit
    </Badge>
  );
}
