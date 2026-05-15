import { beforeAll, describe, expect, it } from 'vitest';
import {
  CredentialEncryptionError,
  decryptCredentials,
  encryptCredentials,
  generateMasterKey,
  loadMasterKey,
} from './credential-encryption';

let masterKey: Buffer;

beforeAll(() => {
  masterKey = loadMasterKey(generateMasterKey());
});

describe('loadMasterKey', () => {
  it('accepts a freshly-generated 32-byte base64 key', () => {
    const k = loadMasterKey(generateMasterKey());
    expect(k.byteLength).toBe(32);
  });

  it('rejects empty string with reason=invalid_key', () => {
    try {
      loadMasterKey('');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialEncryptionError);
      expect((err as CredentialEncryptionError).reason).toBe('invalid_key');
    }
  });

  it('rejects wrong-length key with reason=invalid_key', () => {
    const tooShort = Buffer.alloc(16).toString('base64'); // 16 bytes, not 32
    try {
      loadMasterKey(tooShort);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialEncryptionError).reason).toBe('invalid_key');
    }
  });

  it('error message never leaks the actual base64 key value', () => {
    const k = Buffer.from('a'.repeat(31)).toString('base64'); // 31 bytes → wrong size
    try {
      loadMasterKey(k);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(k);
    }
  });
});

describe('encryptCredentials + decryptCredentials — round-trip', () => {
  it('round-trips a typical OAuth credentials shape', () => {
    const plaintext = {
      accessToken: 'eyJ-fake-jwt',
      refreshToken: 'refresh-token-here',
      expiresAt: '2026-05-15T10:00:00.000Z',
    };
    const sealed = encryptCredentials(plaintext, masterKey);
    expect(decryptCredentials(sealed, masterKey)).toEqual(plaintext);
  });

  it('round-trips a BYO-key shape', () => {
    const plaintext = { apiKey: 'apo_test_key_xyz' };
    const sealed = encryptCredentials(plaintext, masterKey);
    expect(decryptCredentials(sealed, masterKey)).toEqual(plaintext);
  });

  it('round-trips nested objects + unicode + escape-y characters', () => {
    const plaintext = {
      accessToken: 'tok-📧',
      meta: { scopes: ['contacts.read', 'contacts.write'], emoji: '🔐' },
      json: '{"nested":"value"}',
      quotes: 'she said "hi"',
      slashes: 'a\\b/c',
    };
    const sealed = encryptCredentials(plaintext, masterKey);
    expect(decryptCredentials(sealed, masterKey)).toEqual(plaintext);
  });
});

describe('encryptCredentials — nonce randomness', () => {
  it('produces different ciphertexts for the same plaintext (random nonce)', () => {
    const plaintext = { accessToken: 'same' };
    const a = encryptCredentials(plaintext, masterKey);
    const b = encryptCredentials(plaintext, masterKey);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('sealed output includes the nonce(12) + tag(16) overhead', () => {
    const plaintext = { k: 'v' };
    const json = JSON.stringify(plaintext);
    const sealed = encryptCredentials(plaintext, masterKey);
    expect(sealed.byteLength).toBe(12 + json.length + 16);
  });
});

describe('decryptCredentials — error paths', () => {
  it('rejects truncated ciphertext with reason=malformed_ciphertext', () => {
    const tooShort = Buffer.alloc(10); // below 12 + 16 minimum
    try {
      decryptCredentials(tooShort, masterKey);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialEncryptionError);
      expect((err as CredentialEncryptionError).reason).toBe(
        'malformed_ciphertext',
      );
    }
  });

  it('rejects ciphertext encrypted with a different key (reason=decrypt_failed)', () => {
    const plaintext = { accessToken: 'tok' };
    const sealed = encryptCredentials(plaintext, masterKey);
    const otherKey = loadMasterKey(generateMasterKey());
    try {
      decryptCredentials(sealed, otherKey);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialEncryptionError).reason).toBe('decrypt_failed');
    }
  });

  it('rejects tampered ciphertext (reason=decrypt_failed)', () => {
    const sealed = encryptCredentials({ k: 'v' }, masterKey);
    sealed[15] = (sealed[15] ?? 0) ^ 0xff; // flip a byte in the ciphertext region
    try {
      decryptCredentials(sealed, masterKey);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as CredentialEncryptionError).reason).toBe('decrypt_failed');
    }
  });

  it('error message never reveals plaintext on decrypt_failed', () => {
    const sealed = encryptCredentials(
      { secret: 'do-not-leak-this-plaintext' },
      masterKey,
    );
    const otherKey = loadMasterKey(generateMasterKey());
    try {
      decryptCredentials(sealed, otherKey);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('do-not-leak-this-plaintext');
    }
  });
});

describe('generateMasterKey', () => {
  it('produces a different 32-byte key on each call (random)', () => {
    const k1 = loadMasterKey(generateMasterKey());
    const k2 = loadMasterKey(generateMasterKey());
    expect(k1.byteLength).toBe(32);
    expect(k2.byteLength).toBe(32);
    expect(Buffer.compare(k1, k2)).not.toBe(0);
  });
});
