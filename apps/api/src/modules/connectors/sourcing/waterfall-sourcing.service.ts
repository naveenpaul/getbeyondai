import type { ConnectorKind, NormalizedContact } from '@getbeyond/shared';

/**
 * Waterfall contact sourcing (prospecting pipeline Stage 5).
 *
 * For one company domain, pull contacts across connectors in priority order with
 * a **chase-verified** policy (eng-review A3):
 *
 *   - Run connectors in priority order (default `[zoominfo, snov]`).
 *   - Cost-aware: BEFORE each connector, if the company is already "satisfied"
 *     (enough contacts meeting the threshold), stop — don't spend the next
 *     connector's credits.
 *   - Merge by person identity (LinkedIn URL, else email). On a collision the
 *     better email wins: verified > unverified > unknown; ties keep the
 *     earlier (higher-priority) connector's record.
 *   - If no connector yields a verified email for a person, the best unverified
 *     one is kept (labelled) — we never drop a contact that has any email.
 *   - A connector that throws (5xx/circuit-broken) does not abort the company;
 *     the waterfall falls through to the next connector.
 *
 * Granularity note: this waterfalls at the DOMAIN level, not per-person, because
 * `SourceAdapter.syncContacts` streams per-domain. "Chase verified" therefore
 * means: escalate to the next connector when the current set isn't satisfied.
 * Per-person chase would need a finer adapter interface — deferred.
 *
 * Decoupling: the service knows nothing about credentials or vendor adapters.
 * The orchestrator passes `WaterfallConnector`s that already bind creds +
 * breaker hooks; the service only consumes their per-domain stream. Keeps Stage 5
 * unit-testable with fakes and the credential boundary (invariant #6) intact.
 */

/** A connector bound to creds + breaker hooks, ready to stream one domain. */
export interface WaterfallConnector {
  readonly kind: ConnectorKind;
  /** Stream contacts for a single company domain (mirrors syncContacts, bound). */
  sourceForDomain(domain: string): AsyncIterable<NormalizedContact>;
}

export interface WaterfallOptions {
  /**
   * 'verified' (default): a contact counts toward "satisfied" only with a
   * verified email — the waterfall chases verification across connectors.
   * 'any': any email counts — stop as soon as the cap is met.
   */
  threshold?: 'verified' | 'any';
  /** Cap on contacts returned per company. Also the early-stop target. */
  contactsPerCompany?: number;
}

const VERIFICATION_RANK: Record<string, number> = {
  verified: 2,
  unverified: 1,
  unknown: 0,
};

function rankOf(contact: NormalizedContact): number {
  return VERIFICATION_RANK[contact.emailVerification ?? 'unknown'] ?? 0;
}

/** Stable per-person identity: LinkedIn URL if present, else the email. */
function identityKey(contact: NormalizedContact): string {
  return (contact.linkedinUrl ?? contact.emailRaw).trim().toLowerCase();
}

export class WaterfallSourcingService {
  /**
   * Pull merged contacts for one company across the given connectors.
   * Returns verified-first, capped to `contactsPerCompany`.
   */
  async sourceCompany(
    domain: string,
    connectors: readonly WaterfallConnector[],
    opts: WaterfallOptions = {},
  ): Promise<NormalizedContact[]> {
    const cleanDomain = domain.trim();
    if (!cleanDomain) return [];

    const threshold = opts.threshold ?? 'verified';
    const cap = opts.contactsPerCompany;
    const byIdentity = new Map<string, NormalizedContact>();

    for (const connector of connectors) {
      // Cost-aware early stop: skip this connector's credit spend if the company
      // is already satisfied by what earlier connectors returned.
      if (this.isSatisfied(byIdentity, threshold, cap)) break;
      try {
        for await (const incoming of connector.sourceForDomain(cleanDomain)) {
          const key = identityKey(incoming);
          const existing = byIdentity.get(key);
          byIdentity.set(key, this.preferBetter(existing, incoming));
        }
      } catch {
        // Breaker fall-through: a connector failure must not abort the whole
        // company. Move on to the next connector in the waterfall.
        continue;
      }
    }

    return this.finalize(byIdentity, cap);
  }

  /** True when enough contacts already meet the threshold to skip more connectors. */
  private isSatisfied(
    byIdentity: ReadonlyMap<string, NormalizedContact>,
    threshold: 'verified' | 'any',
    cap: number | undefined,
  ): boolean {
    // With no cap there's no count to satisfy — always run every connector so we
    // maximize verified coverage.
    if (cap === undefined) return false;
    let count = 0;
    for (const contact of byIdentity.values()) {
      if (threshold === 'any' || contact.emailVerification === 'verified') {
        count += 1;
        if (count >= cap) return true;
      }
    }
    return false;
  }

  /** Keep the better of two records for the same person; existing wins ties. */
  private preferBetter(
    existing: NormalizedContact | undefined,
    incoming: NormalizedContact,
  ): NormalizedContact {
    if (!existing) return incoming;
    // Strictly-better verification replaces; equal rank keeps the earlier
    // (higher-priority) connector's record.
    return rankOf(incoming) > rankOf(existing) ? incoming : existing;
  }

  /** Verified-first ordering, then cap — so the cap keeps the best emails. */
  private finalize(
    byIdentity: ReadonlyMap<string, NormalizedContact>,
    cap: number | undefined,
  ): NormalizedContact[] {
    // Stable sort by descending verification rank; insertion order breaks ties.
    const ordered = [...byIdentity.values()]
      .map((contact, index) => ({ contact, index }))
      .sort((a, b) => rankOf(b.contact) - rankOf(a.contact) || a.index - b.index)
      .map((entry) => entry.contact);
    return cap === undefined ? ordered : ordered.slice(0, cap);
  }
}

/** Registry singleton — stateless, safe to share. */
export const waterfallSourcingService = new WaterfallSourcingService();
