import { Logger } from '@nestjs/common';
import { SourcingUnavailableError } from './sourcing-provider';
import type {
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';

/**
 * Tries an ordered list of sourcing providers, falling through to the next one
 * whenever the current provider yields no usable candidates — whether because it
 * is *user-fixably* unavailable (a `SourcingUnavailableError`: PDL out of
 * credits, a rejected/expired key, a tripped circuit breaker) OR because it ran
 * fine but matched nothing. The first provider that actually FINDS companies
 * wins; we keep trying the rest only while the running tally is still empty.
 *
 * Terminal outcome when no provider found anything:
 *   - If any provider was unavailable, the last actionable error is re-thrown so
 *     the orchestrator surfaces it gracefully ("PDL is out of credits — top up")
 *     instead of silently completing with a later source's empty result. This is
 *     the load-bearing fix: a fixable problem on the capable source must not be
 *     masked by a geo-incapable source's legitimate "0 matches".
 *   - If every provider ran fine and simply matched nothing, the first (primary)
 *     provider's empty result is returned — a true cross-source "no matches" the
 *     user has nothing to fix.
 *
 * Any other error (DB down, transport) bubbles immediately so pg-boss can retry.
 *
 * The list is capability-ordered by the worker (city goals prefer PDL/Apollo
 * over ZoomInfo), so a fall-through degrades to a still-sensible source rather
 * than a geo-incapable one. Used only for auto-discovery; an explicitly chosen
 * provider is run alone (no silent switching).
 */
export class FallbackSourcingProvider implements SourcingProvider {
  private readonly logger = new Logger(FallbackSourcingProvider.name);
  /** The ordered providers — exposed for wiring/introspection + tests. */
  readonly providers: readonly SourcingProvider[];
  /** Surfaces the primary (first-tried) provider on the run's events. */
  readonly name: string;

  constructor(providers: readonly SourcingProvider[]) {
    if (providers.length === 0) {
      throw new Error('FallbackSourcingProvider requires at least one provider');
    }
    this.providers = providers;
    this.name = providers[0]!.name;
  }

  async findCandidates(
    icp: IcpCriteria,
    opts?: FindCandidatesOptions,
  ): Promise<SourcingResult> {
    let lastUnavailable: SourcingUnavailableError | null = null;
    // The primary provider's empty result — the answer we return only if EVERY
    // provider ran fine and genuinely matched nothing (a true no-match the user
    // can't fix). Kept from the first empty so the summary names the preferred
    // source, not the geo-incapable fallback.
    let firstEmpty: SourcingResult | null = null;
    for (const provider of this.providers) {
      let res: SourcingResult;
      try {
        res = await provider.findCandidates(icp, opts);
      } catch (err) {
        if (err instanceof SourcingUnavailableError) {
          // User-fixable for THIS provider — log + try the next capable one
          // rather than dead-ending the search (no silent degradation).
          this.logger.warn(
            `sourcing via ${provider.name} unavailable: ${err.userMessage} — falling through to next provider`,
          );
          lastUnavailable = err;
          continue;
        }
        throw err;
      }
      // Found companies → this provider wins.
      if (res.candidates.length > 0) return res;
      // Ran fine but matched nothing → remember the primary's empty answer and
      // keep trying the next source (it may have coverage this one lacked).
      this.logger.warn(
        `sourcing via ${provider.name} found no companies — falling through to next provider`,
      );
      if (firstEmpty === null) firstEmpty = res;
    }
    // No provider found anything. If one was fixably unavailable, surface that
    // so the orchestrator completes gracefully with a fix-it hint ("top up PDL")
    // rather than masking it behind a later source's legitimate "0 matches".
    if (lastUnavailable) throw lastUnavailable;
    // Every provider ran fine and simply matched nothing — a true cross-source
    // no-match. Return the primary's empty result (never null here: the loop ran
    // at least once and produced either a result or a thrown error).
    return (
      firstEmpty ?? {
        candidates: [],
        summary: 'No sourcing provider returned any companies.',
      }
    );
  }
}
