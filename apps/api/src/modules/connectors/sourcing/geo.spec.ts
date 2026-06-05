import { describe, expect, it } from 'vitest';
import { canonicalCity, canonicalCountry } from './geo';

describe('canonicalCountry', () => {
  it('recognizes canonical country names (case-insensitive)', () => {
    expect(canonicalCountry('India')).toBe('India');
    expect(canonicalCountry('  united kingdom ')).toBe('United Kingdom');
    expect(canonicalCountry('GERMANY')).toBe('Germany');
  });

  it('normalizes common aliases', () => {
    expect(canonicalCountry('US')).toBe('United States');
    expect(canonicalCountry('usa')).toBe('United States');
    expect(canonicalCountry('uk')).toBe('United Kingdom');
    expect(canonicalCountry('england')).toBe('United Kingdom');
    expect(canonicalCountry('UAE')).toBe('United Arab Emirates');
  });

  it('returns null for non-countries (cities/regions)', () => {
    expect(canonicalCountry('Bengaluru')).toBeNull();
    expect(canonicalCountry('California')).toBeNull();
    expect(canonicalCountry('')).toBeNull();
  });
});

describe('canonicalCity', () => {
  it('de-aliases renamed cities to the vendor-indexed form', () => {
    // Verified live: PDL indexes "bangalore", not "bengaluru".
    expect(canonicalCity('Bengaluru')).toBe('bangalore');
    expect(canonicalCity('Bombay')).toBe('mumbai');
    expect(canonicalCity('NYC')).toBe('new york');
  });

  it('lowercases an unknown city as-is', () => {
    expect(canonicalCity('London')).toBe('london');
    expect(canonicalCity('  Berlin ')).toBe('berlin');
  });

  it('returns null for blank input', () => {
    expect(canonicalCity('   ')).toBeNull();
    expect(canonicalCity('')).toBeNull();
  });
});
