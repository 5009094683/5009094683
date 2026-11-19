import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  timeStep,
  totpCode,
  verifyTotp,
} from './totp';

// Reference values from RFC 6238 appendix B (SHA-1, secret "12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [seconds: number, code: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(hotp(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(code);
    }
  });

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter, 6)).toBe(code));
  });

  it('round-trips base32 and matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts the current code and one step of clock drift either way', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-11-13T10:00:10Z');
    const step = timeStep(now);
    expect(verifyTotp(secret, totpCode(secret, now), { now })).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 30_000)), { now })).toBe(
      step - 1,
    );
    expect(verifyTotp(secret, totpCode(secret, new Date(now.getTime() + 30_000)), { now })).toBe(
      step + 1,
    );
    expect(
      verifyTotp(secret, totpCode(secret, new Date(now.getTime() - 90_000)), { now }),
    ).toBeNull();
  });

  it('refuses a code that was already used', () => {
    const secret = generateTotpSecret();
    const now = new Date('2026-11-13T10:00:10Z');
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, { now, lastStep: null });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, { now, lastStep: step })).toBeNull();
  });

  it('refuses malformed and wrong codes', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abcdef')).toBeNull();
    expect(verifyTotp(secret, '12345')).toBeNull();
    const now = new Date('2026-11-13T10:00:10Z');
    const right = totpCode(secret, now);
    const wrong = right === '000000' ? '000001' : '000000';
    expect(verifyTotp(secret, wrong, { now, window: 0 })).toBeNull();
  });

  it('builds an otpauth URL authenticator apps accept', () => {
    const url = new URL(
      otpauthUrl({ secret: 'ABC234', account: 'a@b.co', issuer: 'Sea Breeze Hotels' }),
    );
    expect(url.protocol).toBe('otpauth:');
    expect(decodeURIComponent(url.pathname)).toContain('Sea Breeze Hotels:a@b.co');
    expect(url.searchParams.get('secret')).toBe('ABC234');
    expect(url.searchParams.get('period')).toBe('30');
    expect(url.searchParams.get('digits')).toBe('6');
  });

  it('generates distinct recovery codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });
});
