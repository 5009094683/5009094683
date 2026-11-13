import { todayIn } from '@pms/domain/shared';
import type { Property } from '@/lib/types';

export type Settings = Property['settings'];
export type BookingPayment = NonNullable<Settings['bookingPayment']>;

/**
 * What the server uses for a setting that has never been saved. They mirror the defaults in
 * `packages/domain/src/booking-engine.ts` and `nightaudit.ts` and in
 * `packages/ai/src/insights.ts`, and are only used to show an unset setting as what it comes to.
 */
export const DEFAULTS = {
  bookingHoldMinutes: 15,
  depositPercent: 30,
  nightAuditHour: 3,
  departureCleanMinutes: 45,
  stayoverCleanMinutes: 20,
} as const;

/** What the server accepts for each setting: `propertySettings` in `apps/api/src/routes/properties.ts`. */
export const LIMITS = {
  holdMinutes: { min: 5, max: 120 },
  depositPercent: { min: 1, max: 100 },
  childMaxAge: { min: 0, max: 17 },
  cleanMinutes: { min: 5, max: 480 },
  description: 4000,
  bookingTerms: 10_000,
  arrivalInstructions: 4000,
  knowledge: 8000,
  amenities: 100,
  amenityLength: 80,
  photos: 60,
  photoLength: 500,
} as const;

/** The whole number typed into a field, or null when it is not one or lies outside the range. */
export function wholeNumber(text: string, range: { min: number; max: number }): number | null {
  const typed = text.trim();
  if (!/^\d{1,4}$/.test(typed)) return null;
  const value = Number(typed);
  return value >= range.min && value <= range.max ? value : null;
}

const count = new Intl.NumberFormat('en-GB');

/** `10,000` */
export const countText = (value: number): string => count.format(value);

/** `03:00` */
export const hourText = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

export const isIndia = (property: Pick<Property, 'country'>): boolean =>
  property.country.toUpperCase() === 'IN';

/** Whether guests can open the property on the website: it is switched on there, and in use. */
export const onWebsite = (property: Pick<Property, 'active' | 'settings'>): boolean =>
  property.active && Boolean(property.settings.bookingEngineEnabled);

/** Where the property's page is on the website, after the website's own address. */
export const websitePath = (property: Pick<Property, 'code'>): string =>
  `/${property.code.toLowerCase()}`;

/**
 * What invoice numbers start with: the prefix that was saved, else the property code, cut the
 * way `invoiceNumber` in `packages/domain/src/invoices.ts` cuts it.
 */
export function invoicePrefixOf(property: Pick<Property, 'code' | 'settings'>): string {
  return (property.settings.invoicePrefix ?? property.code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

/**
 * An invoice number as the property would issue one today, to show what the prefix does. The
 * year is written as `fiscalYearOf` in `packages/domain/src/invoices.ts` writes it: April to
 * March in India (`26-27`), the calendar year elsewhere.
 */
export function sampleInvoiceNumber(
  prefix: string,
  property: Pick<Property, 'country' | 'timezone'>,
): string {
  const today = todayIn(property.timezone);
  const year = Number(today.slice(0, 4));
  const start = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
  const fiscalYear = isIndia(property)
    ? `${String(start).slice(2)}-${String(start + 1).slice(2)}`
    : String(year);
  return `${prefix}/${fiscalYear}/00042`;
}

const HEX_COLOUR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A colour typed with or without its `#`, as it is saved (`#1f6f8b`). Null when it is not one. */
export function hexColour(text: string): string | null {
  const digits = HEX_COLOUR.exec(text.trim())?.[1];
  return digits ? `#${digits.toLowerCase()}` : null;
}

/**
 * Whether the website can use a saved colour. It takes a plain hex colour with its `#` and
 * ignores anything else (`brandStyle` in `apps/booking/src/lib/brand.ts`).
 */
export const websiteUsesColour = (saved: string): boolean =>
  saved.startsWith('#') && hexColour(saved) !== null;

/** `#1f6f8b` from `#1f6f8b` or `#abc`, which is what a colour picker needs. */
export function sixDigitColour(colour: string): string {
  const digits = colour.slice(1);
  return digits.length === 3 ? `#${[...digits].map((digit) => digit + digit).join('')}` : colour;
}

/** A photo that lives somewhere on the web. */
export const isWebAddress = (address: string): boolean => /^https?:\/\/\S+$/i.test(address);

/**
 * Whether the website shows a photo. It keeps web addresses and paths to files of its own, and
 * leaves out anything else (`usablePhotos` in `apps/booking/src/lib/photos.ts`).
 */
export const websiteShowsPhoto = (address: string): boolean =>
  isWebAddress(address) || /^\/[^/\s]\S*$/.test(address);

/** The same words, however they are capitalised. */
export const sameText = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
