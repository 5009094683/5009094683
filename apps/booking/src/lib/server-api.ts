import 'server-only';
import { headers } from 'next/headers';
import { cache } from 'react';
import { ApiError, readResponse, unreachable } from './api-error';
import type { Booking, Checkin, PaymentRequest, PropertyDetail, PropertyList, Stay } from './types';

const API_URL = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

type Query = Record<string, string | number | null | undefined>;

/** The chain this site sells for. Unset on an installation with a single chain. */
export function organisationSlug(): string | undefined {
  return process.env.BOOKING_ORG_SLUG?.trim() || undefined;
}

/**
 * Reads from the API's public routes, from the server. Nothing is cached:
 * prices, availability and a guest's own booking must be as they are now.
 * Failures are thrown as `ApiError`s carrying the server's code and message.
 */
async function get<T>(path: string, query: Query = {}): Promise<T> {
  const url = new URL(`${API_URL}/public${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, `${value}`);
  }
  // The API limits requests per address. Passing the guest's own address on keeps one
  // busy visitor from using up the allowance of everyone served by this server.
  const forwardedFor = (await headers()).get('x-forwarded-for');
  let response: Response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : undefined,
    });
  } catch {
    throw unreachable();
  }
  return readResponse<T>(response);
}

const segment = (value: string): string => encodeURIComponent(value);

export const getProperties = cache((): Promise<PropertyList> =>
  get<PropertyList>('/properties', { org: organisationSlug() }),
);

/**
 * The chain's name for the header and footer of every page, or null when it
 * cannot be had: a page must still be able to say what went wrong.
 */
export const getOrganisationName = cache(async (): Promise<string | null> => {
  try {
    return (await getProperties()).organisation.name;
  } catch {
    return null;
  }
});

/** A property that takes website bookings, or null when there is none with this code. */
export const getProperty = cache(async (code: string): Promise<PropertyDetail | null> => {
  // Codes are short and plain; anything else cannot be a property and is not worth a request.
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) return null;
  try {
    return await get<PropertyDetail>(`/properties/${segment(code)}`, { org: organisationSlug() });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

export interface StayRequest {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  promo?: string;
}

export const searchStay = (code: string, stay: StayRequest): Promise<Stay> =>
  get<Stay>(`/properties/${segment(code)}/availability`, {
    org: organisationSlug(),
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: stay.adults,
    children: stay.children,
    promo: stay.promo,
  });

export const getBooking = cache((token: string): Promise<Booking> =>
  get<Booking>(`/bookings/${segment(token)}`),
);

export const getCheckin = (token: string): Promise<Checkin> =>
  get<Checkin>(`/bookings/${segment(token)}/check-in`);

export const getPaymentRequest = (token: string, orderId: string): Promise<PaymentRequest> =>
  get<PaymentRequest>(`/bookings/${segment(token)}/pay/${segment(orderId)}`);
