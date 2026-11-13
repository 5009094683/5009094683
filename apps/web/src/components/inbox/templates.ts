import { diffDays, displayMoney } from '@pms/domain/shared';
import { plural } from '@/lib/format';
import type { Property, Reservation } from '@/lib/types';
import type { Conversation, GuestLinks, MessageTemplate, StayMoney } from './types';

/*
 * The API has no way to show a template filled in without sending it, so the filling in is
 * repeated here. It follows `renderTemplate`, `templateVariables` and `findTemplate` in
 * packages/domain/src/messaging.ts, so a template reads the same whether the server sends it
 * by itself or staff send it from the inbox.
 */

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Fills `{{name}}` placeholders. A name with no value is left out, and the gaps it leaves are closed up. */
export function fillTemplate(text: string, values: Record<string, string>): string {
  return text
    .replace(PLACEHOLDER, (_match, name: string) => values[name.toLowerCase()] ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The placeholder names a text uses that there is nothing to put in for. */
export function unfilled(text: string, values: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]?.toLowerCase();
    if (name && !values[name]) names.add(name);
  }
  return [...names];
}

const longDate = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const day = (date: string): string => longDate.format(new Date(`${date}T00:00:00Z`));

export interface TemplateFacts {
  conversation: Pick<Conversation, 'contactName' | 'contactAddress'>;
  reservation: Reservation | undefined;
  property: Property | undefined;
  links: GuestLinks | undefined;
  money: StayMoney | undefined;
}

/** What each placeholder stands for with this guest. A name is missing when it is not known. */
export function templateValues({
  conversation,
  reservation,
  property,
  links,
  money,
}: TemplateFacts): Record<string, string> {
  const values: Record<string, string> = {};
  // Without a booking the contact may be known only by an address, which is no way to greet anyone.
  const guestName =
    reservation?.guestName ??
    (conversation.contactName !== conversation.contactAddress ? conversation.contactName : '');
  if (guestName) {
    values.guest_name = guestName;
    values.guest_first_name = guestName.split(/\s+/)[0] ?? guestName;
  }
  if (property) {
    values.property_name = property.name;
    values.property_address = [
      property.addressLine1,
      property.addressLine2,
      property.city,
      property.state,
      property.postalCode,
    ]
      .filter(Boolean)
      .join(', ');
    values.property_phone = property.phone ?? '';
    values.property_email = property.email ?? '';
    values.check_in_time = property.checkInTime;
    values.check_out_time = property.checkOutTime;
    values.arrival_instructions = property.settings.arrivalInstructions ?? '';
  }
  if (reservation) {
    const rooms = new Map<string, number>();
    for (const room of reservation.rooms) {
      if (room.status === 'cancelled' || room.status === 'no_show') continue;
      rooms.set(room.roomTypeName, (rooms.get(room.roomTypeName) ?? 0) + 1);
    }
    values.booking_code = reservation.code;
    values.check_in = day(reservation.checkIn);
    values.check_out = day(reservation.checkOut);
    values.nights = plural(diffDays(reservation.checkIn, reservation.checkOut), 'night');
    values.rooms = [...rooms]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${count} x ${name}`)
      .join(', ');
    values.guests =
      plural(reservation.adults, 'adult') +
      (reservation.children > 0 ? `, ${plural(reservation.children, 'child', 'children')}` : '');
  }
  if (money) {
    values.total = displayMoney(money.total, money.currency);
    values.paid = displayMoney(money.paid, money.currency);
    values.balance = displayMoney(Math.max(0, money.balance), money.currency);
  }
  if (links) {
    values.booking_link = links.url;
    values.checkin_link = links.checkInUrl;
  }
  return values;
}

/** The wording the server picks for a key: the property's own in the guest's language, else the property's, else the organisation's. */
export function serverChoice(
  templates: MessageTemplate[],
  key: string,
  propertyId: string | null,
  language: string | null,
): MessageTemplate | null {
  const wanted = language?.toLowerCase().slice(0, 2) ?? 'en';
  const score = (template: MessageTemplate): number =>
    (template.propertyId === propertyId && propertyId ? 4 : template.propertyId ? -100 : 0) +
    (template.language.slice(0, 2) === wanted ? 2 : template.language === 'en' ? 1 : 0);
  return (
    templates
      .filter((template) => template.key === key && template.active && score(template) >= 0)
      .sort((a, b) => score(b) - score(a))[0] ?? null
  );
}

/**
 * The templates that can be used at a property, by name: the organisation's, with the
 * property's own wording in place of the organisation's where it has one.
 */
export function templatesFor(
  templates: MessageTemplate[],
  propertyId: string | null,
): MessageTemplate[] {
  const chosen = new Map<string, MessageTemplate>();
  for (const template of templates) {
    if (!template.active || (template.propertyId && template.propertyId !== propertyId)) continue;
    const variant = `${template.key}:${template.language}`;
    if (template.propertyId || !chosen.has(variant)) chosen.set(variant, template);
  }
  return [...chosen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language),
  );
}

/**
 * The only templates WhatsApp lets a property open a conversation with: one per key, the
 * wording the server would send, and only where WhatsApp has approved it.
 */
export function approvedTemplates(
  templates: MessageTemplate[],
  propertyId: string | null,
  language: string | null,
): MessageTemplate[] {
  const keys = [...new Set(templates.map((template) => template.key))];
  return keys
    .map((key) => serverChoice(templates, key, propertyId, language))
    .filter((template): template is MessageTemplate => Boolean(template?.whatsappTemplate))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The token at the end of a guest's booking link, by which the guest's own view is read. */
export function guestToken(links: GuestLinks | undefined): string | null {
  const token = links?.url.split('/booking/')[1]?.split(/[/?#]/)[0];
  return token ? token : null;
}
