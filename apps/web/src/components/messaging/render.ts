import { addDays, diffDays, displayMoney } from '@pms/domain/shared';
import { plural } from '@/lib/format';
import type { Property } from '@/lib/types';

/**
 * The server's own way of filling in `{{name}}` placeholders, so that a preview reads exactly
 * as the message that is sent: a name with no value is left out, and the gaps it leaves are
 * closed up.
 */
export { renderTemplate } from '@pms/domain/shared';

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** The names used as `{{name}}` in the texts, in lower case, each once, in order of appearance. */
export function placeholdersIn(...texts: (string | null | undefined)[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(PLACEHOLDER)) names.add(match[1]!.toLowerCase());
  }
  return [...names];
}

/**
 * Curly brackets that are not part of a complete `{{name}}`: a bracket short, a space in the
 * name, a number. The server leaves such text alone, so a guest would read it exactly as typed.
 * Each piece comes with the word the brackets are around, to point at it.
 */
export function strayBrackets(...texts: (string | null | undefined)[]): string[] {
  const pieces = new Set<string>();
  for (const text of texts) {
    const rest = (text ?? '').replace(PLACEHOLDER, ' ');
    for (const match of rest.matchAll(/\{+[^{}\n]{0,40}\}+|\{+[\w-]*|\}+/g)) pieces.add(match[0]);
  }
  return [...pieces];
}

const longDateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `Saturday 12 December 2026`: how the server writes a date in a message. */
export function longDate(date: string): string {
  return longDateFormat.format(new Date(`${date}T00:00:00Z`));
}

/** What a property contributes to a message. Empty text where the property has nothing filled in. */
export function propertyValues(property: Property | undefined): Record<string, string> {
  if (!property) return {};
  return {
    property_name: property.name,
    property_address: [
      property.addressLine1,
      property.addressLine2,
      property.city,
      property.state,
      property.postalCode,
    ]
      .filter(Boolean)
      .join(', '),
    property_phone: property.phone ?? '',
    property_email: property.email ?? '',
    check_in_time: property.checkInTime,
    check_out_time: property.checkOutTime,
    arrival_instructions: property.settings.arrivalInstructions ?? '',
  };
}

/** `2 adults, 1 child` */
export function guestsText(adults: number, children: number): string {
  return (
    plural(adults, 'adult') + (children > 0 ? `, ${plural(children, 'child', 'children')}` : '')
  );
}

/**
 * Values for an invented booking, to show what a template reads like. The property's own
 * details are real, so that a line which would be empty for it is seen to be left out.
 */
export function sampleValues(
  variables: Record<string, string>,
  property: Property | undefined,
  today: string,
): Record<string, string> {
  const currency = property?.currency ?? 'INR';
  const checkIn = addDays(today, 7);
  const checkOut = addDays(checkIn, 3);
  const samples: Record<string, string> = {
    guest_name: 'Asha Rao',
    guest_first_name: 'Asha',
    property_name: 'Your property',
    property_address: '',
    property_phone: '',
    property_email: '',
    check_in_time: '14:00',
    check_out_time: '11:00',
    arrival_instructions: '',
    ...propertyValues(property),
    booking_code: 'K7GUQ8CD',
    check_in: longDate(checkIn),
    check_out: longDate(checkOut),
    nights: plural(diffDays(checkIn, checkOut), 'night'),
    rooms: '1 x Deluxe Room',
    guests: guestsText(2, 0),
    total: displayMoney(1_512_000, currency),
    paid: displayMoney(500_000, currency),
    balance: displayMoney(1_012_000, currency),
    booking_link: 'https://book.example.com/booking/sample',
    checkin_link: 'https://book.example.com/booking/sample/check-in',
    amount: displayMoney(500_000, currency),
    pay_link: 'https://book.example.com/booking/sample/pay',
  };
  // A name the server has added since this was written still shows as something readable.
  for (const [name, description] of Object.entries(variables)) {
    if (!(name in samples)) samples[name] = `(${description})`;
  }
  return samples;
}
