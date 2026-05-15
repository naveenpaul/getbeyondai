import { describe, expect, it } from 'vitest';
import { InvalidEmailError, normalizeEmail } from './identity';

describe('normalizeEmail — happy path (8-case test matrix from eng-review D2)', () => {
  it('passes already-canonical addresses through unchanged', () => {
    expect(normalizeEmail('sarah@acme.com')).toBe('sarah@acme.com');
  });

  it('lowercases the local-part', () => {
    expect(normalizeEmail('SARAH@acme.com')).toBe('sarah@acme.com');
  });

  it('lowercases the domain', () => {
    expect(normalizeEmail('sarah@ACME.com')).toBe('sarah@acme.com');
  });

  it('lowercases both local and domain', () => {
    expect(normalizeEmail('Sarah@Acme.Com')).toBe('sarah@acme.com');
  });

  it('strips Gmail-style +suffix from local-part', () => {
    expect(normalizeEmail('sarah+work@acme.com')).toBe('sarah@acme.com');
  });

  it('strips everything after the first + when multiple plus chars exist', () => {
    expect(normalizeEmail('sarah+work+priority@acme.com')).toBe(
      'sarah@acme.com',
    );
  });

  it('PRESERVES subdomains (sarah@mail.acme.com is NOT sarah@acme.com)', () => {
    expect(normalizeEmail('sarah@mail.acme.com')).toBe('sarah@mail.acme.com');
    // Cross-check: two different inputs produce two different identities.
    expect(normalizeEmail('sarah@acme.com')).not.toBe(
      normalizeEmail('sarah@mail.acme.com'),
    );
  });

  it('combined: plus + uppercase + subdomain', () => {
    expect(normalizeEmail('Sarah+Work@MAIL.ACME.com')).toBe(
      'sarah@mail.acme.com',
    );
  });
});

describe('normalizeEmail — trimming + preserved structure', () => {
  it('trims leading whitespace', () => {
    expect(normalizeEmail('   sarah@acme.com')).toBe('sarah@acme.com');
  });

  it('trims trailing whitespace', () => {
    expect(normalizeEmail('sarah@acme.com   ')).toBe('sarah@acme.com');
  });

  it('trims leading + trailing whitespace', () => {
    expect(normalizeEmail('\t  sarah@acme.com  \n')).toBe('sarah@acme.com');
  });

  it('treats trailing + as plus-suffix consumed (strip and validate)', () => {
    // 'sarah+@acme.com' — plus at end. Strip to 'sarah'. Still valid.
    expect(normalizeEmail('sarah+@acme.com')).toBe('sarah@acme.com');
  });

  it('preserves dots in local-part (sarah.jones is not sarah)', () => {
    // Gmail collapses these; most providers don't. v1 takes the conservative path.
    expect(normalizeEmail('sarah.jones@acme.com')).toBe('sarah.jones@acme.com');
  });

  it('preserves multiple subdomain levels', () => {
    expect(normalizeEmail('sarah@mail.east.acme.com')).toBe(
      'sarah@mail.east.acme.com',
    );
  });
});

describe('normalizeEmail — InvalidEmailError reasons', () => {
  it("throws 'empty' for empty string", () => {
    expect(() => normalizeEmail('')).toThrow(InvalidEmailError);
    try {
      normalizeEmail('');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('empty');
    }
  });

  it("throws 'empty' for whitespace-only string", () => {
    try {
      normalizeEmail('   \t\n   ');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEmailError);
      expect((err as InvalidEmailError).reason).toBe('empty');
    }
  });

  it("throws 'empty' for null", () => {
    try {
      normalizeEmail(null as unknown as string);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('empty');
    }
  });

  it("throws 'empty' for undefined", () => {
    try {
      normalizeEmail(undefined as unknown as string);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('empty');
    }
  });

  it("throws 'too_long' for >254 chars", () => {
    const longLocal = 'a'.repeat(250);
    try {
      normalizeEmail(`${longLocal}@acme.com`);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('too_long');
    }
  });

  it("throws 'no_at' when no @ present", () => {
    try {
      normalizeEmail('sarah-acme.com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('no_at');
    }
  });

  it("throws 'multiple_at' when multiple @ present", () => {
    try {
      normalizeEmail('sarah@@acme.com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('multiple_at');
    }
  });

  it("throws 'invalid_local' for @acme.com (empty local)", () => {
    try {
      normalizeEmail('@acme.com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('invalid_local');
    }
  });

  it("throws 'invalid_domain' for sarah@ (empty domain)", () => {
    try {
      normalizeEmail('sarah@');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('invalid_domain');
    }
  });

  it("throws 'invalid_local' when + consumes the entire local-part", () => {
    try {
      normalizeEmail('+work@acme.com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('invalid_local');
    }
  });

  it("throws 'whitespace_in_local' for internal whitespace in local", () => {
    try {
      normalizeEmail('sarah jones@acme.com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('whitespace_in_local');
    }
  });

  it("throws 'whitespace_in_domain' for internal whitespace in domain", () => {
    try {
      normalizeEmail('sarah@acme com');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('whitespace_in_domain');
    }
  });

  it("throws 'invalid_domain' for domain without a dot (no TLD)", () => {
    try {
      normalizeEmail('sarah@acme');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as InvalidEmailError).reason).toBe('invalid_domain');
    }
  });
});

describe('InvalidEmailError — error payload', () => {
  it('preserves the original input on the error object', () => {
    try {
      normalizeEmail('not-an-email');
    } catch (err) {
      expect((err as InvalidEmailError).input).toBe('not-an-email');
    }
  });

  it('error.name is "InvalidEmailError" for instanceof and toString', () => {
    try {
      normalizeEmail('');
    } catch (err) {
      expect((err as Error).name).toBe('InvalidEmailError');
    }
  });

  it('error message contains both the reason and the offending input', () => {
    try {
      normalizeEmail('foo@@bar');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('multiple_at');
      expect(msg).toContain('foo@@bar');
    }
  });
});
