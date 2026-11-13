import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../crypto';

// Time-based one-time passwords per RFC 6238 (HMAC-SHA1, 30-second steps,
// six digits), the profile every authenticator app supports.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP value (RFC 4226) for a counter. */
export function hotp(secret: Buffer, counter: number, digits: number = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function timeStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

export function totpCode(secretBase32: string, now: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), timeStep(now));
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matched step, or null. A step at or before `lastStep`
 * is refused so an observed code cannot be used twice.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { now?: Date; lastStep?: number | null; window?: number } = {},
): number | null {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const current = timeStep(options.now);
  const window = options.window ?? 1;
  let matched: number | null = null;
  // Check every candidate without an early exit to keep timing uniform.
  for (let step = current - window; step <= current + window; step++) {
    if (safeEqual(hotp(secret, step), normalized)) matched = step;
  }
  if (matched === null) return null;
  if (options.lastStep !== undefined && options.lastStep !== null && matched <= options.lastStep) {
    return null;
  }
  return matched;
}

export function otpauthUrl(params: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Ten single-use recovery codes, formatted `XXXXX-XXXXX`. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(10);
    let code = '';
    for (let j = 0; j < 10; j++) code += alphabet[bytes[j]! % alphabet.length];
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-z0-9]/gi, '').toUpperCase();
}
