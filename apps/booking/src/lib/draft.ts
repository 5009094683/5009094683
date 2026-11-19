/**
 * What a guest has typed into the booking form, kept for the browser tab only.
 * It lets them go back to choose another room, or book again after a payment
 * that did not go through, without typing everything a second time. Storage
 * can be switched off in a browser: everything here then quietly does nothing.
 */

const DRAFT_KEY = 'booking-form';
const FORM_KEY = 'booking-form-address';
const ATTEMPT_KEY = 'booking-attempt';

export interface Draft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country: string;
  arrivalTime: string;
  specialRequests: string;
}

const FIELDS: (keyof Draft)[] = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'country',
  'arrivalTime',
  'specialRequests',
];

function read(key: string): unknown {
  try {
    return JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or switched off.
  }
}

export function readDraft(): Partial<Draft> {
  const saved = read(DRAFT_KEY);
  if (typeof saved !== 'object' || saved === null) return {};
  const draft: Partial<Draft> = {};
  for (const field of FIELDS) {
    const value = (saved as Record<string, unknown>)[field];
    if (typeof value === 'string') draft[field] = value;
  }
  return draft;
}

export function writeDraft(values: Draft): void {
  const draft: Partial<Draft> = {};
  for (const field of FIELDS) draft[field] = values[field];
  write(DRAFT_KEY, draft);
}

export function clearDraft(): void {
  write(DRAFT_KEY, null);
  write(FORM_KEY, null);
  write(ATTEMPT_KEY, null);
}

/**
 * A name for one attempt to book, sent with it and with every retry of it, so that the server
 * makes one booking however many times the attempt arrives. Anything different about the
 * booking makes it a new attempt with a new name. Null where the browser cannot make one;
 * the attempt is then sent without, as before.
 */
export function attemptId(booking: unknown): string | null {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return null;
  const key = JSON.stringify(booking);
  const saved = read(ATTEMPT_KEY);
  if (typeof saved === 'object' && saved !== null) {
    const { key: savedKey, id } = saved as Record<string, unknown>;
    if (savedKey === key && typeof id === 'string') return id;
  }
  const id = crypto.randomUUID();
  write(ATTEMPT_KEY, { key, id });
  return id;
}

/** Notes which booking form a booking was made from, so the guest can be sent back to it. */
export function rememberForm(token: string, address: string): void {
  write(FORM_KEY, { token, address });
}

/** The booking form a booking was made from in this tab, if it was. */
export function rememberedForm(token: string): string | null {
  const saved = read(FORM_KEY);
  if (typeof saved !== 'object' || saved === null) return null;
  const { token: savedToken, address } = saved as Record<string, unknown>;
  if (savedToken !== token || typeof address !== 'string') return null;
  // Only ever a page of this site.
  return /^\/[a-z0-9_-]+\/book\?/i.test(address) ? address : null;
}
