import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt with N=2^15, r=8, p=1 needs about 32 MiB per hash, which is above
// Node's default memory cap, hence the explicit maxmem.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, length, { N: n, r, p, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash` with base64url fields. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await derive(password, salt, n, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when the stored hash uses weaker parameters than the current ones. */
export function passwordNeedsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return (
    parts[0] !== 'scrypt' || Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Used when the account does not
 * exist, so response time does not reveal which emails are registered.
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
}

const MIN_LENGTH = 10;

/** Returns a problem description, or null when the password is acceptable. */
export function passwordProblem(
  password: string,
  context: { email?: string; name?: string } = {},
): string | null {
  if (password.length < MIN_LENGTH)
    return `Password must be at least ${MIN_LENGTH} characters long`;
  if (password.length > 200) return 'Password must be at most 200 characters long';
  const lower = password.toLowerCase();
  const emailLocal = context.email?.split('@')[0]?.toLowerCase();
  if (emailLocal && emailLocal.length >= 4 && lower.includes(emailLocal)) {
    return 'Password must not contain your email address';
  }
  if (/^(.)\1+$/.test(password)) return 'Password must not be a single repeated character';
  if (['password', '1234567890', 'qwertyuiop'].some((weak) => lower.startsWith(weak))) {
    return 'Password is too easy to guess';
  }
  return null;
}
