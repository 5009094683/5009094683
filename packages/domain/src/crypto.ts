import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getEnv } from '@pms/config';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function keys(): { current: Buffer; all: Buffer[] } {
  const env = getEnv();
  const current = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
  const previous = (env.APP_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, 'base64'));
  return { current, all: [current, ...previous] };
}

/** Short identifier of a key, stored with the ciphertext so rotation can pick the right key. */
function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * Encrypts a secret for storage (AES-256-GCM, random 96-bit nonce).
 * Output: `v1:<key id>:<nonce>:<ciphertext>:<auth tag>`, all base64url.
 */
export function encryptSecret(plaintext: string): string {
  const { current } = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, current, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    keyId(current),
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join(':');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('Stored secret has an unknown format');
  }
  const [, id, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const { all } = keys();
  const key = all.find((k) => keyId(k) === id);
  if (!key) {
    throw new Error('Stored secret was encrypted with a key that is no longer configured');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const FILE_MAGIC = Buffer.from('PMSF1');

/**
 * Encrypts a file for the file store (AES-256-GCM). Layout: a five-byte
 * marker, the four-byte key id, the 12-byte nonce, the 16-byte tag, then the
 * ciphertext.
 */
export function encryptBytes(plain: Buffer): Buffer {
  const { current } = keys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, current, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([
    FILE_MAGIC,
    Buffer.from(keyId(current), 'hex'),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

export function decryptBytes(stored: Buffer): Buffer {
  const header = FILE_MAGIC.length + 4 + 12 + 16;
  if (stored.length < header || !stored.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
    throw new Error('Stored file has an unknown format');
  }
  let offset = FILE_MAGIC.length;
  const id = stored.subarray(offset, (offset += 4)).toString('hex');
  const iv = stored.subarray(offset, (offset += 12));
  const tag = stored.subarray(offset, (offset += 16));
  const key = keys().all.find((k) => keyId(k) === id);
  if (!key) throw new Error('Stored file was encrypted with a key that is no longer configured');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(stored.subarray(offset)), decipher.final()]);
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(stored: string): T {
  return JSON.parse(decryptSecret(stored)) as T;
}

/** True when the value was encrypted with a key other than the current one. */
export function needsReencryption(stored: string): boolean {
  const id = stored.split(':')[1];
  return id !== keyId(keys().current);
}

/** Opaque random token for cookies, links and API keys. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacSha256Base64(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against itself so timing does not reveal the length difference early.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-friendly code without look-alike characters (no I, O, 0, 1). */
export function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    // 256 is a multiple of 32, so the modulo introduces no bias.
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}
