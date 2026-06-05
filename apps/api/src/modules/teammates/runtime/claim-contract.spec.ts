import { describe, expect, it } from 'vitest';
import {
  ClaimContractError,
  ClaimSchema,
  EMIT_DRAFT_TOOL,
  EmitDraftArgsSchema,
} from './claim-contract';

/**
 * The persistence path is covered in the integration spec (real Postgres
 * + real Citation rows). This file pins the Zod schema's contract surface
 * and the emit_draft tool definition.
 */

describe('ClaimSchema', () => {
  it('accepts a claim with citationId set', () => {
    const result = ClaimSchema.safeParse({
      text: 'Acme raised $5M Series A on 2026-04-12.',
      citationId: 'cit-1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a claim with citationId=null + abstained=true', () => {
    const result = ClaimSchema.safeParse({
      text: 'Founder spouse name unknown.',
      citationId: null,
      abstained: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an abstained claim that OMITS citationId, defaulting it to null', () => {
    // Regression: the model emits an abstention by leaving the key off entirely.
    // `.nullable()` alone required the key present → zod rejected it and the
    // model looped to no_draft_emitted. It must now parse with citationId=null.
    const result = ClaimSchema.safeParse({
      text: 'No verifiable information was found.',
      abstained: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.citationId).toBeNull();
  });

  it('defaults abstained to false when not provided', () => {
    const result = ClaimSchema.parse({
      text: 'x',
      citationId: 'cit-1',
    });
    expect(result.abstained).toBe(false);
  });

  it('rejects a claim with empty text', () => {
    const result = ClaimSchema.safeParse({ text: '', citationId: 'cit-1' });
    expect(result.success).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(
      ClaimSchema.safeParse({ text: 'x', citationId: null, confidence: 1.5 })
        .success,
    ).toBe(false);
    expect(
      ClaimSchema.safeParse({ text: 'x', citationId: null, confidence: -0.1 })
        .success,
    ).toBe(false);
  });

  it('accepts confidence at the boundary values', () => {
    expect(
      ClaimSchema.safeParse({ text: 'x', citationId: 'c', confidence: 0 })
        .success,
    ).toBe(true);
    expect(
      ClaimSchema.safeParse({ text: 'x', citationId: 'c', confidence: 1 })
        .success,
    ).toBe(true);
  });

  it('does NOT itself reject "uncited and not abstained" — that filter lives in persistDraftFromEmitArgs', () => {
    // The schema validates the SHAPE. The drop-uncited rule is a runtime
    // enforcement step that produces drop counts for the audit log,
    // not a parse failure.
    const result = ClaimSchema.safeParse({
      text: 'Acme is great.',
      citationId: null,
      abstained: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('EmitDraftArgsSchema', () => {
  it('accepts a research_brief with one cited claim', () => {
    const result = EmitDraftArgsSchema.safeParse({
      type: 'research_brief',
      content: { headline: 'Acme', summary: 'A SaaS startup' },
      claims: [{ text: 'Founded in 2022', citationId: 'cit-1' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown draft types', () => {
    const result = EmitDraftArgsSchema.safeParse({
      type: 'tiktok_short',
      content: {},
      claims: [{ text: 'x', citationId: 'c' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty claims array', () => {
    const result = EmitDraftArgsSchema.safeParse({
      type: 'research_brief',
      content: {},
      claims: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts mixed claims (some cited, some abstained)', () => {
    const result = EmitDraftArgsSchema.safeParse({
      type: 'research_brief',
      content: { headline: 'x' },
      claims: [
        { text: 'cited fact', citationId: 'cit-1' },
        { text: 'no source', citationId: null, abstained: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts arbitrary content object shape', () => {
    expect(
      EmitDraftArgsSchema.safeParse({
        type: 'email',
        content: { subject: 's', body: 'b', randomField: 42 },
        claims: [{ text: 't', citationId: 'c' }],
      }).success,
    ).toBe(true);
  });
});

describe('EMIT_DRAFT_TOOL', () => {
  it('has the well-known name "emit_draft"', () => {
    expect(EMIT_DRAFT_TOOL.name).toBe('emit_draft');
  });

  it('declares the input_schema as a JSON-Schema object', () => {
    expect(EMIT_DRAFT_TOOL.input_schema.type).toBe('object');
    expect(EMIT_DRAFT_TOOL.input_schema.required).toContain('type');
    expect(EMIT_DRAFT_TOOL.input_schema.required).toContain('content');
    expect(EMIT_DRAFT_TOOL.input_schema.required).toContain('claims');
  });

  it('description includes the citation-required language so the model gets it', () => {
    expect(EMIT_DRAFT_TOOL.description).toContain('citation');
    expect(EMIT_DRAFT_TOOL.description).toContain('drop');
  });
});

describe('ClaimContractError', () => {
  it('is a typed Error with a code field', () => {
    const err = new ClaimContractError('no_valid_claims', 'zero claims left');
    expect(err.code).toBe('no_valid_claims');
    expect(err.name).toBe('ClaimContractError');
    expect(err.message).toContain('zero claims left');
  });
});
