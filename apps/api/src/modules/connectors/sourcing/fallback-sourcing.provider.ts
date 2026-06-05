import { Logger } from '@nestjs/common';
import { SourcingUnavailableError } from './sourcing-provider';
import type {
  FindCandidatesOptions,
  IcpCriteria,
  SourcingProvider,
  SourcingResult,
} from './sourcing-provider';

/**
 * Tries an ordered list of sourcing providers, falling through to the next when
 * one is *user-fixably* unavailable at runtime — a `SourcingUnavailableError`
 * (PDL out of credits, a rejected/expired key, a tripped circuit breaker). The
 * first provider to return a result wins, even an empty one ("no matches" is an
 * answer, not a failure). If EVERY provider is unavailable, the last actionable
 * error is re-thrown so the orchestrator surfaces it gracefully. Any other error
 * (DB down, transport) bubbles immediately so pg-boss can retry.
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
    for (const provider of this.providers) {
      try {
        return await provider.findCandidates(icp, opts);
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
    }
    // Every provider was unavailable — surface the last actionable message so
    // the orchestrator completes gracefully (ICP still shown) with a fix-it hint.
    throw (
      lastUnavailable ??
      new SourcingUnavailableError('No sourcing provider was available.')
    );
  }
}
