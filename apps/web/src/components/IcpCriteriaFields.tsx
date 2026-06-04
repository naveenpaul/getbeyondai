'use client';

import { useState } from 'react';
import type { IcpCriteriaInput } from '@getbeyond/shared';
import { Input } from '@/components/ui/input';

/**
 * Controlled inputs for EXPLICIT ICP (Ideal Customer Profile) constraints.
 *
 * These are optional pins on top of the LLM-derived ICP. The backend treats a
 * provided field as an authoritative override (an explicit `[]` clears an array,
 * an explicit `null` clears an employee bound), so the COMPOSER — not this
 * component — is responsible for omitting fields the user left blank (see
 * `cleanIcpCriteria` below). This component is a dumb, fully-controlled view:
 * it renders whatever `value` holds and reports edits via `onChange`.
 *
 * The array fields (industries, keywords, funding stages, locations) are edited
 * as raw comma-separated text. We deliberately do NOT split-on-comma inside this
 * component's `value` round-trip — that would eat a comma the user is mid-typing
 * and fight the caret. Instead the local text state is the source of truth for
 * the inputs, and parsing to `string[]` happens here on each keystroke so the
 * controlled `value` always reflects the parsed arrays. Trailing/leading commas
 * and blank segments are dropped; a field with no non-blank segments parses to
 * `[]` (the composer then decides whether to send or omit it).
 */

interface IcpCriteriaFieldsProps {
  value: IcpCriteriaInput;
  onChange: (next: IcpCriteriaInput) => void;
  disabled?: boolean;
}

/**
 * Parse a comma-separated string into a trimmed, blank-free string array.
 * Pure — exported for the cleaning helper and as a unit-test target if a web
 * test runner is added. `"a, b ,,c "` → `["a", "b", "c"]`; `""`/`" , "` → `[]`.
 */
export function parseCommaList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse a number input's raw string into a nullable number for an employee
 * bound. Blank → `null` (the composer omits null bounds). A non-numeric or
 * negative value is treated as "unset" (`null`) so the payload never carries a
 * garbage bound. Pure; testable.
 */
export function parseEmployeeBound(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

/** Render a nullable employee bound back into an input string. */
function boundToInput(bound: number | null | undefined): string {
  return bound === null || bound === undefined ? '' : String(bound);
}

export function IcpCriteriaFields({
  value,
  onChange,
  disabled = false,
}: IcpCriteriaFieldsProps): React.JSX.Element {
  function patch(next: Partial<IcpCriteriaInput>): void {
    onChange({ ...value, ...next });
  }

  return (
    <div className="space-y-4">
      <TextListField
        id="icp-industries"
        label="Industries"
        hint="e.g. SaaS, Fintech, Healthcare"
        initial={value.industries ?? []}
        disabled={disabled}
        onChange={(industries) => patch({ industries })}
      />
      <TextListField
        id="icp-keywords"
        label="Keywords"
        hint="e.g. devtools, API-first, PLG"
        initial={value.keywords ?? []}
        disabled={disabled}
        onChange={(keywords) => patch({ keywords })}
      />
      <TextListField
        id="icp-funding-stages"
        label="Funding stages"
        hint="e.g. Seed, Series A, Series B"
        initial={value.fundingStages ?? []}
        disabled={disabled}
        onChange={(fundingStages) => patch({ fundingStages })}
      />
      <TextListField
        id="icp-locations"
        label="Locations"
        hint="e.g. United States, EMEA, Remote"
        initial={value.locations ?? []}
        disabled={disabled}
        onChange={(locations) => patch({ locations })}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[8rem] flex-1 space-y-1">
          <label htmlFor="icp-employees-min" className="text-xs font-medium">
            Employees (min)
          </label>
          <Input
            id="icp-employees-min"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Any"
            className="tabular-nums"
            value={boundToInput(value.employeeCountMin)}
            disabled={disabled}
            onChange={(e) =>
              patch({ employeeCountMin: parseEmployeeBound(e.target.value) })
            }
          />
        </div>
        <div className="min-w-[8rem] flex-1 space-y-1">
          <label htmlFor="icp-employees-max" className="text-xs font-medium">
            Employees (max)
          </label>
          <Input
            id="icp-employees-max"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="Any"
            className="tabular-nums"
            value={boundToInput(value.employeeCountMax)}
            disabled={disabled}
            onChange={(e) =>
              patch({ employeeCountMax: parseEmployeeBound(e.target.value) })
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A labelled comma-separated text input that surfaces a `string[]` to its parent.
 *
 * The RAW text is local state — it must be, so the separators the user types
 * (commas, the space after a comma, a trailing comma before the next item)
 * survive on screen. Feeding the parsed-then-rejoined array back as the input
 * value would eat a comma the instant it's typed and make a second item
 * impossible to enter. Instead we keep the text locally and lift the PARSED
 * array up via `onChange` on every keystroke, so the parent's value is always
 * current for the payload while the field stays freely typable. Seeded once from
 * the initial array (the composer never resets these fields externally).
 *
 * Matches the settings form idiom: `text-xs font-medium` label over an `<Input>`.
 */
function TextListField({
  id,
  label,
  hint,
  initial,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  initial: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [text, setText] = useState(() => initial.join(', '));

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}{' '}
        <span className="font-normal text-muted-foreground">
          (comma-separated)
        </span>
      </label>
      <Input
        id={id}
        type="text"
        placeholder={hint}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseCommaList(e.target.value));
        }}
      />
    </div>
  );
}
