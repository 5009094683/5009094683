import { formatDay, formatMoney, toMinor } from '@/lib/format';
import type { FolioLine, PaymentMethod, TaxedKind } from './types';

export const KIND_LABELS: Record<TaxedKind, string> = {
  room: 'Room',
  food: 'Food and drink',
  service: 'Service',
  extra: 'Extra',
  fee: 'Fee',
};

export const TAXED_KINDS: TaxedKind[] = ['room', 'food', 'service', 'extra', 'fee'];

/** Kinds staff post by hand, most used first. Room charges normally come from the night audit. */
export const CHARGE_OPTIONS: { value: TaxedKind; label: string; example: string }[] = [
  { value: 'food', label: 'Food and drink', example: 'Dinner for two' },
  { value: 'service', label: 'Service', example: 'Laundry' },
  { value: 'extra', label: 'Extra', example: 'Extra bed' },
  { value: 'fee', label: 'Fee', example: 'Late check-out' },
  { value: 'room', label: 'Room charge (manual)', example: 'Extra night' },
];

/** Ways staff take money. Online and channel payments are recorded by the system, never typed in. */
export const STAFF_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

export const REFERENCE_HINT =
  'The terminal slip number, the UPI reference or the last four digits of the card. Never the whole card number.';

const CHARGE_KINDS: readonly string[] = ['room', 'food', 'service', 'extra', 'fee', 'discount'];

/** Charges and discounts carry tax and go on invoices; payments, refunds and transfers do not. */
export function isCharge(line: Pick<FolioLine, 'kind'>): boolean {
  return CHARGE_KINDS.includes(line.kind);
}

export const lineTotal = (line: Pick<FolioLine, 'amount' | 'taxAmount'>): number =>
  line.amount + line.taxAmount;

/** "Room 204" for a numbered room; a named one ("Garden Villa") is its own name. */
export function roomLabel(unitName: string): string {
  return /^\d/.test(unitName) ? `Room ${unitName}` : unitName;
}

/**
 * A line's description as staff read it. The system writes a room night as
 * "Standard Room, night of 2026-11-13": the date is shown the way the rest of the bill shows
 * dates. `roomNames` (unit name by reservation room) adds which room the night was for, which
 * matters when one booking has several rooms of the same type.
 */
export function lineDescription(
  line: Pick<FolioLine, 'kind' | 'description' | 'reservationRoomId'>,
  roomNames?: Record<string, string>,
): string {
  if (line.kind !== 'room') return line.description;
  const text = line.description.replace(
    /\bnight of (\d{4}-\d{2}-\d{2})$/,
    (_, day: string) => `night of ${formatDay(day)}`,
  );
  const room = line.reservationRoomId ? roomNames?.[line.reservationRoomId] : undefined;
  return room ? `${text} · ${roomLabel(room)}` : text;
}

export type BalanceTone = 'danger' | 'success' | 'info';

/** How a balance is worded everywhere: owed, settled, or in credit. */
export function balanceText(
  balance: number,
  currency: string,
): { text: string; tone: BalanceTone } {
  if (balance > 0)
    return { text: `Balance owed ${formatMoney(balance, currency)}`, tone: 'danger' };
  if (balance < 0) return { text: `In credit ${formatMoney(-balance, currency)}`, tone: 'info' };
  return { text: 'Settled', tone: 'success' };
}

export const BALANCE_TEXT_TONES: Record<BalanceTone, string> = {
  danger: 'text-danger-700',
  success: 'text-success-700',
  info: 'text-info-700',
};

/** Minor units for an amount typed in major units, or null unless it is a number above zero. */
export function parseAmount(text: string, currency: string): number | null {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(value)) return null;
  const minor = toMinor(value, currency);
  return minor > 0 ? minor : null;
}

/**
 * The server refuses a payment reference that could be a card number. Checking with the same
 * pattern here keeps such a number from leaving the browser at all.
 */
export function looksLikeCardNumber(reference: string): boolean {
  return /\b(?:\d[ -]?){13,19}\b/.test(reference);
}

export const CARD_NUMBER_ERROR =
  'That looks like a card number. Enter the slip number or the last four digits only.';
