/**
 * Signal registry — the catalog of buying-signal *types* (Stage 6 of the
 * prospecting pipeline).
 *
 * This is the connectors-`registry.ts` philosophy applied to signals: a signal
 * is DATA (a definition entry), not an enum value or a column. Adding "they just
 * hired a VP of Sales" later = add one `SignalDefinition` below (+ a research
 * question or connector param). No migration, no schema change, no orchestrator
 * edit. That is the test for "can we add signals in the future" — and it passes.
 *
 * Two things stay cleanly separate:
 *   - the DEFINITION (here) — what a signal is, how it's acquired, when it decays.
 *   - the OBSERVATION (`CompanySignal` rows) — did company X have it, with proof.
 * And a third, per-run: the ICP `signalSpec` (see `signal-spec.ts`) selects which
 * definitions a given list cares about + their weights.
 */

/** The user's three buying-signal buckets. */
export type SignalCategory =
  /** Do they have the problem we solve? (fit) */
  | 'fit'
  /** Do they have a reason to act NOW? (trigger / timing) */
  | 'timing'
  /** Can we actually reach the right person? (reachability) */
  | 'reachability';

/**
 * How a signal is USED in the pipeline (the plan's three modes):
 *   - filter:  pushed down into discovery to narrow the company pull (Stage 1).
 *   - derive:  the Researcher reads the web and cites it (Stage 4).
 *   - monitor: re-evaluated over time by the brain (future; seam only).
 */
export type SignalMode = 'filter' | 'derive' | 'monitor';

/** How a signal's value is actually obtained. The extensible part. */
export type SignalAcquisition =
  /** Push a filter param down to a discovery connector (ZoomInfo/Apollo). */
  | { kind: 'connector_filter'; param: string }
  /** A research question the Researcher answers + cites. */
  | { kind: 'research'; question: string }
  /** An external trigger feed (future). */
  | { kind: 'feed'; source: string }
  /** Derived from our own pipeline output (e.g. the contact waterfall). */
  | { kind: 'computed'; from: string };

export interface SignalDefinition {
  /** Stable key — referenced by `signalSpec` and persisted on `CompanySignal.key`. */
  readonly key: string;
  readonly label: string;
  readonly category: SignalCategory;
  readonly mode: SignalMode;
  readonly acquisition: SignalAcquisition;
  /**
   * Days after `detectedAt` the signal stops counting as "now". `undefined` =
   * never decays (a fit signal like "uses a competitor" stays true until
   * disproven; a timing signal like "recently funded" goes stale). This is what
   * makes "reason to act NOW" mean something — see `signal-scoring.ts`.
   */
  readonly decayDays?: number;
  readonly description: string;
}

/**
 * The seed catalog. Representative across all three categories + acquisition
 * kinds; extend freely. Keys are snake_case and stable (they're persisted).
 */
const DEFINITIONS: readonly SignalDefinition[] = [
  // --- fit: do they have the problem we solve? ---
  {
    key: 'has_problem',
    label: 'Has the problem we solve',
    category: 'fit',
    mode: 'derive',
    acquisition: {
      kind: 'research',
      question:
        'Is there evidence this company has the specific problem the product solves?',
    },
    description:
      'Core fit signal: web-derived, cited evidence the company actually has the ' +
      'pain. Never decays — it stays true until disproven.',
  },
  {
    key: 'uses_competing_tool',
    label: 'Uses a competing / adjacent tool',
    category: 'fit',
    mode: 'derive',
    acquisition: {
      kind: 'research',
      question: 'Does this company use a competing or adjacent tool today?',
    },
    description:
      'Strong fit proxy — using a competitor proves the problem is real and ' +
      'budgeted. Cited from job posts, tech-stack pages, case studies.',
  },

  // --- timing: do they have a reason to act NOW? ---
  {
    key: 'recently_funded',
    label: 'Recently raised funding',
    category: 'timing',
    mode: 'filter',
    acquisition: { kind: 'connector_filter', param: 'fundingDateWithinMonths' },
    description:
      'Fresh capital = budget + mandate to buy. Pushable down to ZoomInfo/Apollo ' +
      'discovery as a filter; decays fast (a round 18 months ago is not "now").',
    decayDays: 180,
  },
  {
    key: 'hiring_for_role',
    label: 'Hiring for a relevant role',
    category: 'timing',
    mode: 'derive',
    acquisition: {
      kind: 'research',
      question:
        'Is this company actively hiring for a role that implies our problem ' +
        '(e.g. hiring SDRs when we sell a sales tool)?',
    },
    description:
      'An open req is a dated, citable intent signal. Decays — a job post from ' +
      'last quarter is weaker than one from last week.',
    decayDays: 60,
  },
  {
    key: 'leadership_change',
    label: 'New relevant leadership',
    category: 'timing',
    mode: 'derive',
    acquisition: {
      kind: 'research',
      question:
        'Has this company recently hired or promoted a leader in the function ' +
        'we sell into?',
    },
    description:
      'New leaders re-evaluate the stack in their first 90 days — a classic ' +
      'act-now window. Cited from announcements / LinkedIn.',
    decayDays: 90,
  },

  // --- reachability: can we reach the right person? ---
  {
    key: 'reachable_decision_maker',
    label: 'Reachable decision-maker found',
    category: 'reachability',
    mode: 'monitor',
    acquisition: { kind: 'computed', from: 'contact_waterfall' },
    description:
      'Computed AFTER sourcing, not researched: did the waterfall return a ' +
      'verified-email contact in the target persona? A company can be a perfect ' +
      'fit and still unreachable — this is the difference between a list and a ' +
      'list you can act on.',
  },
];

/** Indexed by key for O(1) lookup. */
const BY_KEY: ReadonlyMap<string, SignalDefinition> = new Map(
  DEFINITIONS.map((d) => [d.key, d]),
);

export class UnknownSignalError extends Error {
  constructor(public readonly key: string) {
    super(`No signal definition registered for key "${key}"`);
    this.name = 'UnknownSignalError';
  }
}

/** All registered signal definitions (stable order). */
export function listSignalDefinitions(): readonly SignalDefinition[] {
  return DEFINITIONS;
}

/** Look up a definition, or throw `UnknownSignalError` if the key is unregistered. */
export function getSignalDefinition(key: string): SignalDefinition {
  const def = BY_KEY.get(key);
  if (!def) throw new UnknownSignalError(key);
  return def;
}

/** Whether a signal key is registered. */
export function isKnownSignal(key: string): boolean {
  return BY_KEY.has(key);
}

/** Definitions in a given category (for building category-scoped UIs/specs). */
export function signalsByCategory(
  category: SignalCategory,
): readonly SignalDefinition[] {
  return DEFINITIONS.filter((d) => d.category === category);
}
