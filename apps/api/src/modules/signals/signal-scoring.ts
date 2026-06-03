import {
  getSignalDefinition,
  isKnownSignal,
  type SignalDefinition,
} from './signal-definition';
import type { SignalSpec } from './signal-spec';

/**
 * Signal scoring — turns a company's observed signals + the ICP `signalSpec`
 * into a single rank-able number, and decides whether a company is disqualified.
 *
 * This is the read side of Stage 6: discovery + research + the waterfall WRITE
 * `CompanySignal` rows; ranking READS them through here. Kept pure (no Prisma,
 * no Date.now — `now` is injected) so it's fully unit-testable and deterministic.
 *
 * The load-bearing idea: a *timing* signal only counts if it's FRESH. "Recently
 * funded" detected 18 months ago is the same fact as one from last week but the
 * opposite signal — decay is what makes "reason to act NOW" mean something.
 */

/** The minimal shape the scorer needs from a `CompanySignal` row. */
export interface SignalObservationView {
  key: string;
  status: 'present' | 'absent' | 'unknown';
  /** When the underlying event happened. Null for absent/unknown. */
  detectedAt: Date | null;
}

export interface SignalContribution {
  key: string;
  status: SignalObservationView['status'];
  /** present AND within the definition's decay window (or non-decaying). */
  fresh: boolean;
  /** The spec weight for this signal. */
  weight: number;
  /** weight when (present && fresh), else 0. */
  contribution: number;
  /** True when this is a `required` signal that isn't present+fresh. */
  disqualifies: boolean;
}

export interface SignalScore {
  /** Normalized to [0, 1]: sum(contribution) / sum(weight). 1 for an empty spec. */
  score: number;
  /** True if any `required` signal is not present + fresh. */
  disqualified: boolean;
  breakdown: SignalContribution[];
}

/**
 * Is a present signal still "now"? A non-decaying definition (no `decayDays`) is
 * fresh whenever present. A decaying one is fresh only if `detectedAt` is within
 * `decayDays` of `now`. A present signal with no `detectedAt` but a decay window
 * cannot be proven fresh, so it is treated as stale (conservative).
 */
export function isFresh(
  def: SignalDefinition,
  observation: Pick<SignalObservationView, 'status' | 'detectedAt'>,
  now: Date,
): boolean {
  if (observation.status !== 'present') return false;
  if (def.decayDays === undefined) return true;
  if (!observation.detectedAt) return false;
  const ageMs = now.getTime() - observation.detectedAt.getTime();
  // Future-dated detections (clock skew) count as fresh, not stale.
  const maxAgeMs = def.decayDays * 24 * 60 * 60 * 1000;
  return ageMs <= maxAgeMs;
}

/**
 * Score a company's signals against the ICP signalSpec.
 *
 * - Each spec item contributes its full weight when its signal is present AND
 *   fresh; otherwise 0.
 * - `required` items not present+fresh set `disqualified = true` (a hard gate,
 *   independent of the numeric score).
 * - Score is normalized by total weight so it's comparable across specs.
 * - An empty spec scores 1.0 (no preference → neutral, nothing disqualifies).
 *
 * Unknown keys in the spec are skipped defensively (a registry shrink shouldn't
 * crash ranking) but the spec validator (`parseSignalSpec`) rejects them at the
 * write boundary, so this should not happen in practice.
 */
export function scoreCandidate(
  observations: SignalObservationView[],
  spec: SignalSpec,
  now: Date,
): SignalScore {
  if (spec.length === 0) {
    return { score: 1, disqualified: false, breakdown: [] };
  }

  const byKey = new Map(observations.map((o) => [o.key, o]));
  const breakdown: SignalContribution[] = [];
  let weightSum = 0;
  let contributionSum = 0;
  let disqualified = false;

  for (const item of spec) {
    if (!isKnownSignal(item.key)) continue; // defensive; validated upstream
    const def = getSignalDefinition(item.key);
    const obs = byKey.get(item.key);
    const status = obs?.status ?? 'unknown';
    const fresh = obs
      ? isFresh(def, { status: obs.status, detectedAt: obs.detectedAt }, now)
      : false;
    const contribution = fresh ? item.weight : 0;
    const disqualifies = item.required === true && !fresh;

    if (disqualifies) disqualified = true;
    weightSum += item.weight;
    contributionSum += contribution;
    breakdown.push({
      key: item.key,
      status,
      fresh,
      weight: item.weight,
      contribution,
      disqualifies,
    });
  }

  // weightSum is > 0 here: spec is non-empty and items have weight in (0,1].
  // (If every item were an unknown key it could be 0 — guard anyway.)
  const score = weightSum > 0 ? contributionSum / weightSum : 0;
  return { score, disqualified, breakdown };
}
