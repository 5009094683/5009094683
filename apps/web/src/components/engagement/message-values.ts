import { diffDays, displayMoney } from '@pms/domain/shared';
import {
  guestsText,
  longDate,
  placeholdersIn,
  propertyValues,
} from '@/components/messaging/render';
import type { MessageTemplate } from '@/components/messaging/types';
import { plural } from '@/lib/format';
import type { Property, Reservation } from '@/lib/types';
import type { GuestLinks, StayMoney } from './types';

/** Stands in a preview for a value only the server knows at the moment it sends. */
export const FILLED_IN_LATER = '(filled in when it is sent)';

/**
 * What each `{{name}}` stands for in a message about this reservation. It follows
 * `templateVariables` in packages/domain/src/messaging.ts, so the preview reads as the message
 * the server then sends.
 */
export function reservationValues(
  reservation: Reservation,
  property: Property | undefined,
  links: GuestLinks | undefined,
  money: StayMoney | undefined,
): Record<string, string> {
  const rooms = new Map<string, number>();
  for (const room of reservation.rooms) {
    if (room.status === 'cancelled' || room.status === 'no_show') continue;
    rooms.set(room.roomTypeName, (rooms.get(room.roomTypeName) ?? 0) + 1);
  }
  return {
    ...propertyValues(property),
    guest_name: reservation.guestName,
    guest_first_name: reservation.guestName.split(/\s+/)[0] ?? reservation.guestName,
    booking_code: reservation.code,
    check_in: longDate(reservation.checkIn),
    check_out: longDate(reservation.checkOut),
    nights: plural(diffDays(reservation.checkIn, reservation.checkOut), 'night'),
    rooms: [...rooms]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${count} x ${name}`)
      .join(', '),
    guests: guestsText(reservation.adults, reservation.children),
    total: money ? displayMoney(money.total, money.currency) : FILLED_IN_LATER,
    paid: money ? displayMoney(money.paid, money.currency) : FILLED_IN_LATER,
    balance: money ? displayMoney(Math.max(0, money.balance), money.currency) : FILLED_IN_LATER,
    booking_link: links?.url ?? FILLED_IN_LATER,
    checkin_link: links?.checkInUrl ?? FILLED_IN_LATER,
  };
}

/**
 * The wording the server picks for a key: the property's own in the guest's language, else the
 * property's, else the organisation's. Follows `findTemplate` in packages/domain/src/messaging.ts.
 */
export function versionFor(
  templates: MessageTemplate[],
  key: string,
  propertyId: string,
  language: string | null | undefined,
): MessageTemplate | null {
  const wanted = language?.toLowerCase().slice(0, 2) ?? 'en';
  const score = (template: MessageTemplate): number =>
    (template.propertyId === propertyId ? 4 : template.propertyId ? -100 : 0) +
    (template.language.slice(0, 2) === wanted ? 2 : template.language === 'en' ? 1 : 0);
  return (
    templates
      .filter((template) => template.key === key && template.active && score(template) >= 0)
      .sort((a, b) => score(b) - score(a))[0] ?? null
  );
}

/** A template about a payment request: it only makes sense with an amount and a link to pay. */
export function asksForPayment(template: MessageTemplate): boolean {
  const names = placeholdersIn(template.subject, template.body);
  return names.includes('amount') || names.includes('pay_link');
}
