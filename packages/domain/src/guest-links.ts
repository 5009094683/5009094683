import { createHmac } from 'node:crypto';
import { getEnv } from '@pms/config';
import { safeEqual } from './crypto';
import { addDays, type DateString } from './dates';

/**
 * Links that let a guest open their own booking without an account: to pay,
 * to see or cancel it, to check in online.
 *
 * The token is the reservation id, a version and an expiry, signed with a key
 * derived from the application key. Nothing is stored, so the same link can
 * be put in every message about the booking. Raising the reservation's
 * `guestTokenVersion` makes all earlier links stop working.
 */

const CONTEXT = 'pms-guest-link-v1';
const MAC_BYTES = 16;

function signingKeys(): Buffer[] {
  const env = getEnv();
  const raw = [env.APP_ENCRYPTION_KEY, ...(env.APP_ENCRYPTION_KEY_PREVIOUS?.split(',') ?? [])];
  return raw
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => createHmac('sha256', Buffer.from(k, 'base64')).update(CONTEXT).digest());
}

function mac(key: Buffer, payload: Buffer): string {
  return createHmac('sha256', key)
    .update(payload)
    .digest()
    .subarray(0, MAC_BYTES)
    .toString('base64url');
}

export interface GuestLinkSubject {
  id: string;
  guestTokenVersion: number;
  checkOut: DateString;
}

/** Links keep working for two months after departure, so the invoice stays reachable. */
function expiryOf(checkOut: DateString): number {
  return Math.floor(Date.parse(`${addDays(checkOut, 60)}T00:00:00Z`) / 1000);
}

export function guestToken(reservation: GuestLinkSubject): string {
  const payload = Buffer.alloc(22);
  Buffer.from(reservation.id.replace(/-/g, ''), 'hex').copy(payload, 0);
  payload.writeUInt16BE(reservation.guestTokenVersion & 0xffff, 16);
  payload.writeUInt32BE(expiryOf(reservation.checkOut), 18);
  return `${payload.toString('base64url')}.${mac(signingKeys()[0]!, payload)}`;
}

export interface GuestTokenClaims {
  reservationId: string;
  version: number;
  expiresAt: Date;
}

/**
 * Checks the signature and expiry. The caller must still compare `version`
 * with the reservation's current `guestTokenVersion`.
 */
export function readGuestToken(token: string, now: Date = new Date()): GuestTokenClaims | null {
  const [body, signature, ...rest] = token.split('.');
  if (!body || !signature || rest.length > 0) return null;
  let payload: Buffer;
  try {
    payload = Buffer.from(body, 'base64url');
  } catch {
    return null;
  }
  if (payload.length !== 22) return null;
  if (!signingKeys().some((key) => safeEqual(mac(key, payload), signature))) return null;
  const hex = payload.subarray(0, 16).toString('hex');
  const expiresAt = new Date(payload.readUInt32BE(18) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    reservationId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    version: payload.readUInt16BE(16),
    expiresAt,
  };
}

/** Where on the booking site a guest manages their booking. */
export function guestBookingUrl(reservation: GuestLinkSubject, path = ''): string {
  const base = getEnv().BOOKING_URL.replace(/\/+$/, '');
  return `${base}/booking/${guestToken(reservation)}${path}`;
}
