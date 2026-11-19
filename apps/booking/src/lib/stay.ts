import { addDays, isDate } from './dates';

/** Longest stay and most rooms the website takes in one booking. */
export const MAX_NIGHTS = 30;
export const MAX_ROOMS = 8;

export type SearchParams = Record<string, string | string[] | undefined>;

/** What the search form holds. Dates are empty until the guest has chosen them. */
export interface StayInput {
  checkIn: string;
  checkOut: string;
  /** In each room. */
  adults: number;
  children: number;
  promo: string;
}

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value)?.trim() ?? '';

function whole(value: string, fallback: number, min: number, max: number): number {
  const n = /^\d{1,3}$/.test(value) ? Number(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Reads the search from the address, keeping only what is well formed. */
export function readStay(params: SearchParams): StayInput {
  const checkIn = first(params.checkIn);
  const checkOut = first(params.checkOut);
  return {
    checkIn: isDate(checkIn) ? checkIn : '',
    checkOut: isDate(checkOut) ? checkOut : '',
    adults: whole(first(params.adults), 2, 1, 30),
    children: whole(first(params.children), 0, 0, 30),
    promo: first(params.promo).slice(0, 30).toUpperCase(),
  };
}

/** Whether there is enough to search with: both dates, departure after arrival. */
export function hasDates(stay: StayInput): boolean {
  return stay.checkIn !== '' && stay.checkOut !== '' && stay.checkOut > stay.checkIn;
}

export function readRooms(params: SearchParams): number {
  return whole(first(params.rooms), 1, 1, MAX_ROOMS);
}

export function readId(params: SearchParams, key: 'roomTypeId' | 'ratePlanId'): string | null {
  const value = first(params[key]);
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

/** The search as a query string, so it can be shared and the back button returns to it. */
export function stayQuery(
  stay: StayInput,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams();
  if (stay.checkIn) params.set('checkIn', stay.checkIn);
  if (stay.checkOut) params.set('checkOut', stay.checkOut);
  params.set('adults', String(stay.adults));
  params.set('children', String(stay.children));
  if (stay.promo) params.set('promo', stay.promo);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

/** Where a property lives on the site: its code in lower case. */
export const propertyPath = (code: string): string => `/${code.toLowerCase()}`;

/** The latest departure the date field offers for an arrival. */
export function latestCheckOut(checkIn: string, bookableUntil: string): string {
  const lastNight = addDays(bookableUntil, 1);
  const longest = addDays(checkIn, MAX_NIGHTS);
  return longest < lastNight ? longest : lastNight;
}
