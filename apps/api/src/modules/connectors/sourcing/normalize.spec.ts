import { describe, expect, it } from 'vitest';
import { normalizeCompanyName, normalizeDomain } from './normalize';

describe('normalizeDomain', () => {
  it('strips scheme, www, path, query, and fragment; lowercases', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1#y')).toBe('acme.com');
  });

  it('handles a bare hostname', () => {
    expect(normalizeDomain('Acme.com')).toBe('acme.com');
  });

  it('keeps a meaningful subdomain (no over-stripping)', () => {
    expect(normalizeDomain('https://blog.acme.com')).toBe('blog.acme.com');
  });

  it('returns null for blank / nullish input', () => {
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('   ')).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain(undefined)).toBeNull();
  });

  it('returns null when only a scheme is present', () => {
    expect(normalizeDomain('https://')).toBeNull();
  });

  it('returns null for a value with no TLD (LLM junk: "null", bare name)', () => {
    // Live-run regression: gpt-4o-mini emitted the string "null" for a missing
    // domain; a real domain must have a dot, so these are rejected.
    expect(normalizeDomain('null')).toBeNull();
    expect(normalizeDomain('none')).toBeNull();
    expect(normalizeDomain('Acme Corp')).toBeNull();
  });
});

describe('normalizeCompanyName', () => {
  it('lowercases, strips punctuation, and drops a trailing legal suffix', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyName('Acme')).toBe('acme');
  });

  it('collapses "Acme Inc" and "acme" to the same token', () => {
    expect(normalizeCompanyName('Acme Inc')).toBe(
      normalizeCompanyName('acme'),
    );
  });

  it('strips multiple trailing suffix words (pvt ltd)', () => {
    expect(normalizeCompanyName('Aaritya Broking Private Limited')).toBe(
      'aaritya broking',
    );
    expect(normalizeCompanyName('Foo Pvt Ltd')).toBe('foo');
  });

  it('does NOT strip a suffix word that is not trailing', () => {
    // "co" here is part of the brand, not a trailing suffix.
    expect(normalizeCompanyName('Co-op Software')).toBe('co op software');
  });

  it('never strips the whole name to empty (keeps single suffix-only token)', () => {
    // A name that is JUST a suffix word stays (length>1 guard) — better a token
    // than null when that's all we have.
    expect(normalizeCompanyName('Limited')).toBe('limited');
  });

  it('returns null for blank / nullish / punctuation-only input', () => {
    expect(normalizeCompanyName('')).toBeNull();
    expect(normalizeCompanyName('   ')).toBeNull();
    expect(normalizeCompanyName('—  .')).toBeNull();
    expect(normalizeCompanyName(null)).toBeNull();
    expect(normalizeCompanyName(undefined)).toBeNull();
  });
});
