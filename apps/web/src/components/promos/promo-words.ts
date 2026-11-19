import { percentText } from '@/components/accounts/money';
import { formatDate, formatMoney, plural } from '@/lib/format';
import type { Promo } from './types';

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** A moment in the viewer's own time zone, with the year: `1 Dec 2026, 09:30`. */
export function momentText(value: string): string {
  return dateTime.format(new Date(value));
}

/** "10% off every night", "₹500 off the stay". */
export function discountText(promo: Pick<Promo, 'kind' | 'value' | 'currency'>): string {
  return promo.kind === 'percent'
    ? `${percentText(promo.value)}% off every night`
    : `${formatMoney(promo.value, promo.currency ?? 'INR')} off the stay`;
}

/** What a stay has to be like for the code to apply, beyond its dates. */
export function conditionsText(promo: Pick<Promo, 'minNights' | 'ratePlanIds'>): string[] {
  const conditions: string[] = [];
  if (promo.minNights > 1) conditions.push(`Stays of ${promo.minNights} nights or more`);
  if (promo.ratePlanIds?.length) {
    conditions.push(`Only ${plural(promo.ratePlanIds.length, 'chosen rate')}`);
  }
  return conditions;
}

/** When bookings can be made with the code, and for which nights. */
export function validityText(
  promo: Pick<Promo, 'bookFrom' | 'bookTo' | 'stayFrom' | 'stayTo'>,
): string[] {
  const lines: string[] = [];
  if (promo.bookFrom && promo.bookTo) {
    lines.push(`Bookings made ${momentText(promo.bookFrom)} to ${momentText(promo.bookTo)}`);
  } else if (promo.bookFrom) {
    lines.push(`Bookings made from ${momentText(promo.bookFrom)}`);
  } else if (promo.bookTo) {
    lines.push(`Bookings made until ${momentText(promo.bookTo)}`);
  }
  if (promo.stayFrom && promo.stayTo) {
    lines.push(`Nights from ${formatDate(promo.stayFrom)} to ${formatDate(promo.stayTo)}`);
  } else if (promo.stayFrom) {
    lines.push(`Nights from ${formatDate(promo.stayFrom)}`);
  } else if (promo.stayTo) {
    lines.push(`Nights up to ${formatDate(promo.stayTo)}`);
  }
  return lines.length > 0 ? lines : ['Any time, any dates'];
}

export type PromoState = 'active' | 'off' | 'expired' | 'used_up' | 'upcoming';

/**
 * Whether a guest could use the code right now, as the website decides it. `today` is the
 * date at the property (or where the viewer is, for a code valid everywhere).
 */
export function promoState(promo: Promo, now: Date, today: string): PromoState {
  if (!promo.active) return 'off';
  if (promo.bookTo && now >= new Date(promo.bookTo)) return 'expired';
  // Every night has to fall in the stay window, and no stay starts in the past.
  if (promo.stayTo && promo.stayTo < today) return 'expired';
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) return 'used_up';
  if (promo.bookFrom && now < new Date(promo.bookFrom)) return 'upcoming';
  return 'active';
}

export const STATE_LABELS: Record<PromoState, string> = {
  active: 'Active',
  off: 'Switched off',
  expired: 'Expired',
  used_up: 'Used up',
  upcoming: 'Not started',
};

export const STATE_TONES: Record<PromoState, 'success' | 'neutral' | 'warning' | 'info'> = {
  active: 'success',
  off: 'neutral',
  expired: 'warning',
  used_up: 'warning',
  upcoming: 'info',
};

/** "3 of 50", or "3, no limit". */
export function usesText(promo: Pick<Promo, 'usedCount' | 'maxUses'>): string {
  return promo.maxUses === null
    ? `${promo.usedCount}, no limit`
    : `${promo.usedCount} of ${promo.maxUses}`;
}
