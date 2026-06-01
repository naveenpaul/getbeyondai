import { describe, expect, it } from 'vitest';
import {
  isModelForProvider,
  modelMismatchMessage,
} from './model-namespace';

/**
 * Provider↔model namespace guard — the pure rule behind the write-time
 * (saveRouting) and run-time (LlmResolver) checks. Explicit vitest imports.
 */

describe('isModelForProvider', () => {
  it('accepts anthropic ids under anthropic', () => {
    expect(isModelForProvider('anthropic', 'claude-sonnet-4-6')).toBe(true);
    expect(isModelForProvider('anthropic', 'claude-haiku-4-5-20251001')).toBe(
      true,
    );
    // Forward-compatible: a future family member still matches by prefix.
    expect(isModelForProvider('anthropic', 'claude-5-opus')).toBe(true);
  });

  it('accepts openai ids under openai (gpt + o-series + chatgpt)', () => {
    expect(isModelForProvider('openai', 'gpt-4.1')).toBe(true);
    expect(isModelForProvider('openai', 'gpt-4.1-mini')).toBe(true);
    expect(isModelForProvider('openai', 'o3-mini')).toBe(true);
    expect(isModelForProvider('openai', 'chatgpt-4o-latest')).toBe(true);
    expect(isModelForProvider('openai', 'gpt-5-future')).toBe(true);
  });

  it('rejects the exact cross-provider mistake that broke campaign runs', () => {
    expect(isModelForProvider('openai', 'claude-sonnet-4-6')).toBe(false);
    expect(isModelForProvider('anthropic', 'gpt-4.1')).toBe(false);
  });

  it('rejects an empty or unrecognized id', () => {
    expect(isModelForProvider('openai', '')).toBe(false);
    expect(isModelForProvider('anthropic', 'mistral-large')).toBe(false);
  });
});

describe('modelMismatchMessage', () => {
  it('names the field, the bad model, the provider, and the expected prefixes', () => {
    const msg = modelMismatchMessage('openai', 'claude-sonnet-4-6', 'modelPrimary');
    expect(msg).toContain('modelPrimary');
    expect(msg).toContain('claude-sonnet-4-6');
    expect(msg).toContain('openai');
    expect(msg).toContain('gpt-');
  });
});
