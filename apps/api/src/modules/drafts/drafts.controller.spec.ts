import { describe, expect, it } from 'vitest';
import { clampInt, previewFromContent } from './drafts.controller';

/**
 * Unit tests for the pure helpers inside drafts.controller. The
 * controller itself is covered by drafts.controller.integration.spec
 * (real DB); these exercise the corner branches the integration suite
 * can't conveniently reach.
 */

describe('clampInt', () => {
  it('returns the fallback when raw is undefined', () => {
    expect(clampInt(undefined, 50, 1, 100)).toBe(50);
  });

  it('returns the fallback on non-numeric input', () => {
    expect(clampInt('xyz', 50, 1, 100)).toBe(50);
  });

  it('clamps to min when input is below it', () => {
    expect(clampInt('-5', 50, 0, 100)).toBe(0);
  });

  it('clamps to max when input is above it', () => {
    expect(clampInt('9999', 50, 0, 100)).toBe(100);
  });

  it('returns the parsed value when in range', () => {
    expect(clampInt('25', 50, 0, 100)).toBe(25);
  });
});

describe('previewFromContent', () => {
  it('returns empty string for null content', () => {
    expect(previewFromContent(null)).toBe('');
  });

  it('returns empty string for primitive content', () => {
    expect(previewFromContent('a string')).toBe('');
    expect(previewFromContent(42)).toBe('');
    expect(previewFromContent(true)).toBe('');
  });

  it('returns empty string for an array', () => {
    expect(previewFromContent(['a', 'b'])).toBe('');
  });

  it('returns empty string when no candidate field is a non-empty string', () => {
    expect(previewFromContent({})).toBe('');
    expect(previewFromContent({ subject: '', body: '', headline: '' })).toBe('');
    expect(
      previewFromContent({ subject: 42, body: null, headline: false }),
    ).toBe('');
  });

  it('prefers subject over headline / body', () => {
    expect(
      previewFromContent({ subject: 'subj', headline: 'head', body: 'b' }),
    ).toBe('subj');
  });

  it('falls back to headline when subject is missing', () => {
    expect(previewFromContent({ headline: 'head', body: 'b' })).toBe('head');
  });

  it('falls back to content when subject / headline / body are all missing', () => {
    expect(previewFromContent({ content: 'fallback' })).toBe('fallback');
  });

  it('truncates with an ellipsis past the preview ceiling', () => {
    const long = 'x'.repeat(500);
    const out = previewFromContent({ body: long });
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(241);
  });
});
