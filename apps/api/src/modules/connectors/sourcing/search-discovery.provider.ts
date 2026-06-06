import { Logger } from '@nestjs/common';
import type { SearchOutput } from '../../teammates/runtime/search/search-provider';
import { SearchProviderError } from '../../teammates/runtime/search/search-provider';
import type {
  CandidateCompany,
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';
import { excludeWins, type WinKey } from './exclude-wins';
import { normalizeDomain } from './normalize';
import {
  DISCOVERY_NORMALIZE_SYSTEM_PROMPT,
  DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT,
  buildDiscoveryQueryUserPrompt,
  buildNormalizeUserPrompt,
  parseDiscoveredCompanies,
  parseDiscoveryQueries,
  selectExemplars,
  type RawDiscoveredCompany,
} from './search-discovery.prompts';

/**
 * Search-discovery sourcing provider (Phase B) — the keyless, Cloud-safe
 * discovery front-end that finds companies similar to a user's WINS by searching
 * the web, where structured vendors (PDL/ZoomInfo) can't (e.g. "raised in the
 * last 3 months"). Plan: docs/plans/signals-and-discovery-pipeline.md.
 *
 * Flow (each LLM step is STRICT-JSON via the injected `chat`, invariant #3; both
 * calls share one audited `news_discovery` AgentRun + the per-run budget,
 * invariant #8 — composed by the worker factory):
 *
 *   icp + intent + ≤5 win exemplars
 *        │  chat → parseDiscoveryQueries (≤3 vectors)        review #3: no explosion
 *        ▼
 *   searcher.search(q) × queries → dedupe by url
 *        │  chat → parseDiscoveredCompanies (drops fund/ecosystem noise)
 *        ▼
 *   resolve domain INLINE → drop domainless                  review #1: no ghost domains
 *        │
 *        ▼
 *   recency filter (D2) → excludeWins (name|domain)          review #1: suppress wins
 *        │                                                   BEFORE expensive qualify
 *        ▼
 *   dedupe by domain‖name → cap to limit → CandidateCompany[]
 *
 * Boundary: lives in connectors/sourcing and depends only on neutral edges
 * (`searcher`, `chat`, `resolveDomain`) so it unit-tests with fakes. The worker
 * wires the concrete SearchProvider, the callModel-backed chat, and the searxng
 * domain resolver.
 */

const DEFAULT_PER_QUERY_COUNT = 10;
const DEFAULT_LIMIT = 25;

/** Minimal web-search edge (a `SearchProvider`, narrowed for injection). */
export interface DiscoverySearcher {
  search(query: string, opts?: { count?: number }): Promise<SearchOutput>;
}

/** Single-shot LLM text completion edge (STRICT-JSON in/out). */
export type DiscoveryChat = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

export interface SearchDiscoveryDeps {
  searcher: DiscoverySearcher;
  chat: DiscoveryChat;
  /**
   * Resolve a company's corporate domain by name (the D1 searxng enrichment
   * seam), run INLINE so exclude-wins + qualify see a real domain. When omitted,
   * candidates keep whatever domain normalization found (and domainless ones are
   * dropped per `dropDomainless`).
   */
  resolveDomain?: (name: string) => Promise<string | null>;
  /** Win company names — used as lookalike exemplars in query building. */
  winNames: readonly string[];
  /** Win identities (name + optional domain) — used to suppress already-owned companies. */
  winKeys: readonly WinKey[];
  /** Free-text goal/intent fed to the query builder. */
  intent: string;
  /** `research`-mode signal questions to weave into queries (empty in B-alone). */
  signalQuestions?: readonly string[];
  /** Recency window in months; when set, stale (older) dated candidates are dropped. */
  withinMonths?: number | null;
  /** Injected clock for the recency filter (testability). Defaults to new Date(). */
  now?: Date;
  /** Results requested per query. */
  perQueryCount?: number;
  /**
   * Drop candidates whose domain can't be resolved (review #1 default for search-
   * discovery: no domain → can't research or source contacts). Default true.
   */
  dropDomainless?: boolean;
}

export class SearchDiscoverySourcingProvider implements SourcingProvider {
  readonly name = 'search-discovery';
  private readonly logger = new Logger(SearchDiscoverySourcingProvider.name);
  private readonly deps: SearchDiscoveryDeps;

  constructor(deps: SearchDiscoveryDeps) {
    this.deps = deps;
  }

  async findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const dropDomainless = this.deps.dropDomainless ?? true;

    // 1. Build search vectors from the ICP + intent + win exemplars.
    const exemplars = selectExemplars(this.deps.winNames);
    let queries;
    try {
      const raw = await this.deps.chat(
        DISCOVERY_QUERY_BUILDER_SYSTEM_PROMPT,
        buildDiscoveryQueryUserPrompt(
          icp,
          this.deps.intent,
          exemplars,
          this.deps.signalQuestions ?? [],
        ),
      );
      queries = parseDiscoveryQueries(raw);
    } catch (err) {
      // A query-builder LLM failure isn't a search fault we should hard-fail on;
      // return empty so the fallback chain can try another source.
      this.logger.warn(`query build failed: ${describe(err)}`);
      return { candidates: [], summary: buildSummary(0, 0, 0) };
    }
    if (queries.length === 0) {
      return { candidates: [], summary: buildSummary(0, 0, 0) };
    }

    // 2. Run each query; collect + dedupe results by URL. A per-query failure
    //    (engine down / rate-limited) is skipped, not fatal.
    const perQuery = this.deps.perQueryCount ?? DEFAULT_PER_QUERY_COUNT;
    const byUrl = new Map<string, SearchOutput['results'][number]>();
    for (const q of queries) {
      try {
        const out = await this.deps.searcher.search(q.q, { count: perQuery });
        for (const r of out.results) {
          if (r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
        }
      } catch (err) {
        if (err instanceof SearchProviderError) {
          this.logger.warn(`search "${q.q}" failed: ${err.message} — skipping`);
          continue;
        }
        throw err;
      }
    }
    const results = [...byUrl.values()];
    if (results.length === 0) {
      return { candidates: [], summary: buildSummary(0, 0, 0) };
    }

    // 3. Normalize raw hits → companies (drops funds/ecosystem noise).
    let raw: RawDiscoveredCompany[];
    try {
      const text = await this.deps.chat(
        DISCOVERY_NORMALIZE_SYSTEM_PROMPT,
        buildNormalizeUserPrompt(results),
      );
      raw = parseDiscoveredCompanies(text);
    } catch (err) {
      this.logger.warn(`normalize failed: ${describe(err)}`);
      return { candidates: [], summary: buildSummary(0, 0, 0) };
    }

    // 4. Resolve domain INLINE (review #1), then drop domainless.
    const resolved = await this.resolveDomains(raw, dropDomainless);

    // 5. Recency filter (D2): drop dated candidates older than the window; keep
    //    undated (the query already biased toward recent — don't lose recall).
    const fresh = filterByRecency(
      resolved,
      this.deps.withinMonths ?? null,
      this.deps.now ?? new Date(),
    );

    // 6. Exclude-wins on name|domain BEFORE the expensive qualify step.
    const { kept, excluded } = excludeWins(fresh, this.deps.winKeys);
    if (excluded.length) {
      this.logger.log(`exclude-wins suppressed ${excluded.length} already-owned companies`);
    }

    // 7. Dedupe by domain‖name; cap to limit.
    const deduped = dedupe(kept, limit);
    return {
      candidates: deduped,
      summary: buildSummary(deduped.length, raw.length, excluded.length),
    };
  }

  /** Map raw companies → CandidateCompany, resolving domain inline; drop domainless. */
  private async resolveDomains(
    raw: ReadonlyArray<RawDiscoveredCompany>,
    dropDomainless: boolean,
  ): Promise<CandidateCompany[]> {
    const out: CandidateCompany[] = [];
    for (const c of raw) {
      let domain = normalizeDomain(c.domain);
      if (!domain && this.deps.resolveDomain) {
        try {
          domain = normalizeDomain(await this.deps.resolveDomain(c.name));
        } catch (err) {
          this.logger.warn(`domain resolve failed for "${c.name}": ${describe(err)}`);
        }
      }
      if (!domain && dropDomainless) continue;
      out.push(toCandidate(c, domain));
    }
    return out;
  }
}

/**
 * Keep candidates that are either undated or whose announced date is within
 * `withinMonths` of `now`. Pure. `withinMonths` null/≤0 → no filtering. An
 * unparseable date is treated as undated (kept).
 */
export function filterByRecency(
  candidates: ReadonlyArray<CandidateCompany>,
  withinMonths: number | null,
  now: Date,
): CandidateCompany[] {
  if (!withinMonths || withinMonths <= 0) return [...candidates];
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - withinMonths);
  return candidates.filter((c) => {
    const iso = (c.raw['announcedDate'] as string | null | undefined) ?? null;
    if (!iso) return true; // undated → keep (don't lose recall)
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return true; // unparseable → treat as undated
    return t >= cutoff.getTime();
  });
}

/** Dedupe candidates by domain (falling back to lowercased name), cap to limit. */
function dedupe(
  candidates: ReadonlyArray<CandidateCompany>,
  limit: number,
): CandidateCompany[] {
  const byKey = new Map<string, CandidateCompany>();
  for (const c of candidates) {
    const key = (c.domain ?? c.name).toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, c);
    if (byKey.size >= limit) break;
  }
  return [...byKey.values()];
}

/** RawDiscoveredCompany → CandidateCompany, carrying the funding signal in `raw`. */
function toCandidate(
  c: RawDiscoveredCompany,
  domain: string | null,
): CandidateCompany {
  return {
    name: c.name,
    domain,
    linkedinUrl: null,
    employeeCount: null,
    fundingStage: c.fundingStage,
    raw: {
      source: 'search-discovery',
      sourceUrl: c.sourceUrl,
      amountUsd: c.amountUsd,
      announcedDate: c.announcedDate,
      fundingStage: c.fundingStage,
    },
  };
}

function buildSummary(kept: number, extracted: number, excluded: number): string {
  if (kept === 0) {
    return excluded > 0
      ? `Search-discovery: all ${excluded} matches were already in your list`
      : 'Search-discovery found no new companies for this ICP';
  }
  const noun = kept === 1 ? 'company' : 'companies';
  const suff = excluded > 0 ? ` (${excluded} already owned, suppressed)` : '';
  return `Search-discovery: ${kept} ${noun} from ${extracted} extracted${suff}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
