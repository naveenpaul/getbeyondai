import type {
  CompanySignal,
  PrismaClient,
  SignalSource,
  SignalStatus,
} from '@prisma/client';
import { isKnownSignal } from './signal-definition';

/**
 * Persistence for `CompanySignal` — the observed-per-company signal record
 * (Stage 6). Function-style over an injected `PrismaClient`, mirroring
 * `contact-upsert.ts`; no NestJS module wiring yet (nothing consumes it until
 * the orchestrator integration increment).
 *
 * Two invariants are enforced at THIS write boundary rather than in the DB:
 *   1. `key` must be a registered signal (registry is the source of truth).
 *   2. cite-or-abstain — a `present` signal sourced from `research` MUST carry a
 *      `citationId` (architecture invariant: every asserted fact cites or
 *      abstains, same rule as `Claim`). Connector/computed/feed signals don't
 *      need a web citation; their provenance is the connector record itself.
 */

/** A signal observation to persist. `value`/`citationId`/`detectedAt` optional. */
export interface SignalObservation {
  prospectId: string;
  key: string;
  status: SignalStatus;
  source: SignalSource;
  value?: Record<string, unknown>;
  citationId?: string | null;
  /** When the underlying event happened (drives "act now" + decay). */
  detectedAt?: Date | null;
}

export class InvalidSignalObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSignalObservationError';
  }
}

/**
 * Validate an observation against the registry + the cite-or-abstain rule.
 * Pure (no DB) so it's unit-testable; called by `upsertCompanySignal` before any
 * write. Throws `InvalidSignalObservationError` on violation.
 */
export function validateSignalObservation(obs: SignalObservation): void {
  if (!isKnownSignal(obs.key)) {
    throw new InvalidSignalObservationError(
      `unknown signal key "${obs.key}" (not in the registry)`,
    );
  }
  if (
    obs.status === 'present' &&
    obs.source === 'research' &&
    !obs.citationId
  ) {
    throw new InvalidSignalObservationError(
      `signal "${obs.key}" is present + research-sourced but has no citationId ` +
        `(cite-or-abstain)`,
    );
  }
}

/**
 * Upsert one signal observation for a company. Idempotent on
 * `(prospectId, key)` — re-evaluation UPDATES the row (refreshing `status`,
 * `value`, `evaluatedAt`) rather than appending a duplicate. That is what makes
 * the "signals get refreshed later / monitor" loop work without row explosion.
 *
 * `evaluatedAt` is bumped to now on every write (when WE last checked);
 * `detectedAt` reflects when the event happened and is caller-supplied.
 */
export async function upsertCompanySignal(
  prisma: PrismaClient,
  obs: SignalObservation,
): Promise<CompanySignal> {
  validateSignalObservation(obs);

  const value = (obs.value ?? {}) as object;
  const data = {
    status: obs.status,
    source: obs.source,
    value,
    citationId: obs.citationId ?? null,
    detectedAt: obs.detectedAt ?? null,
    evaluatedAt: new Date(),
  };

  return prisma.companySignal.upsert({
    where: { prospectId_key: { prospectId: obs.prospectId, key: obs.key } },
    create: { prospectId: obs.prospectId, key: obs.key, ...data },
    update: data,
  });
}

/** All signals observed for a candidate, newest evaluation first. */
export async function listCompanySignals(
  prisma: PrismaClient,
  prospectId: string,
): Promise<CompanySignal[]> {
  return prisma.companySignal.findMany({
    where: { prospectId },
    orderBy: { evaluatedAt: 'desc' },
  });
}
