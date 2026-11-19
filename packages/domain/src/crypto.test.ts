import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@pms/config';
import {
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  needsReencryption,
  randomCode,
  safeEqual,
} from './crypto';

const originalKey = process.env.APP_ENCRYPTION_KEY;
const originalPrevious = process.env.APP_ENCRYPTION_KEY_PREVIOUS;

function setKeys(current: string | undefined, previous?: string) {
  if (current === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  else process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous;
  resetEnvCache();
}

afterEach(() => setKeys(originalKey, originalPrevious));

describe('secret encryption', () => {
  it('round-trips text and JSON', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(stored)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptJson(encryptJson({ apiKey: 'k', n: 1 }))).toEqual({ apiKey: 'k', n: 1 });
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('detects tampering', () => {
    const parts = encryptSecret('guest-passport-number').split(':');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    ciphertext[0] = ciphertext[0]! ^ 0x01;
    parts[3] = ciphertext.toString('base64url');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('still decrypts with a previous key after rotation, and flags the value for re-encryption', () => {
    const oldKey = randomBytes(32).toString('base64');
    const newKey = randomBytes(32).toString('base64');
    setKeys(oldKey);
    const stored = encryptSecret('rotate-me');
    expect(needsReencryption(stored)).toBe(false);

    setKeys(newKey, oldKey);
    expect(decryptSecret(stored)).toBe('rotate-me');
    expect(needsReencryption(stored)).toBe(true);
    expect(needsReencryption(encryptSecret('rotate-me'))).toBe(false);

    setKeys(newKey);
    expect(() => decryptSecret(stored)).toThrow(/no longer configured/);
  });
});

describe('helpers', () => {
  it('compares strings without leaking length through exceptions', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('generates codes without look-alike characters', () => {
    for (let i = 0; i < 50; i++) expect(randomCode(8)).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
