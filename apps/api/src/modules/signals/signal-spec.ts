import { z } from 'zod';
import { isKnownSignal } from './signal-definition';

/**
 * The ICP `signalSpec` — "for THIS prospecting list, here are the signals I care
 * about and how much each matters." Defined once at the ICP (the plan's
 * "defined-at-ICP" half); stored as JSON on `CompanyBrain.icp` so it needs no
 * column of its own. Each item references a `SignalDefinition` by key; the
 * registry is the source of truth for what the signal *is*.
 *
 * This is the read side of extensibility: a new signal becomes selectable the
 * moment its definition is registered — no change here.
 */

export interface SignalSpecItem {
  /** → `SignalDefinition.key`. Must be a registered signal. */
  key: string;
  /** Relative importance in (0, 1]. Used by the scorer to weight contribution. */
  weight: number;
  /** If true, a company missing this signal (present + fresh) is disqualified. */
  required?: boolean;
  /** Per-run acquisition params (e.g. { withinMonths: 12 } for recently_funded). */
  params?: Record<string, unknown>;
}

export type SignalSpec = SignalSpecItem[];

const SignalSpecItemSchema = z.object({
  key: z.string().min(1),
  weight: z.number().gt(0).lte(1),
  required: z.boolean().optional(),
  params: z.record(z.unknown()).optional(),
});

/**
 * A signalSpec is an array of items with:
 *   - every key registered in the signal registry,
 *   - no duplicate keys (one weight per signal),
 *   - weights in (0, 1].
 * An empty array is valid — it means "no signal preference" (neutral ranking).
 */
const SignalSpecSchema = z
  .array(SignalSpecItemSchema)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [i, item] of items.entries()) {
      const { key } = item;
      if (!isKnownSignal(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'key'],
          message: `unknown signal key "${key}" (not in the registry)`,
        });
      }
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'key'],
          message: `duplicate signal key "${key}"`,
        });
      }
      seen.add(key);
    }
  });

/**
 * Parse + validate a raw signalSpec (e.g. from `CompanyBrain.icp.signalSpec`).
 * Throws a `ZodError` with field-pathed messages on any invalid item. Returns a
 * typed, registry-checked `SignalSpec`.
 */
export function parseSignalSpec(raw: unknown): SignalSpec {
  return SignalSpecSchema.parse(raw);
}

/** Non-throwing variant — returns `{ success, data | error }`. */
export function safeParseSignalSpec(raw: unknown) {
  return SignalSpecSchema.safeParse(raw);
}
