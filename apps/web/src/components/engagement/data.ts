'use client';

import useSWR from 'swr';
import type { GuestLinks, PaymentOrder, StayMoney } from './types';

export const paymentOrdersKey = (reservationId: string): string =>
  `/reservations/${reservationId}/payment-orders`;

export function usePaymentOrders(reservationId: string, enabled: boolean) {
  return useSWR<{ orders: PaymentOrder[] }>(enabled ? paymentOrdersKey(reservationId) : null);
}

export function useGuestLinks(reservationId: string, enabled: boolean) {
  return useSWR<GuestLinks>(enabled ? `/reservations/${reservationId}/guest-link` : null);
}

/** The token at the end of a guest's booking link, by which the guest's own page is read. */
function guestToken(links: GuestLinks | undefined): string | null {
  const token = links?.url.split('/booking/')[1]?.split(/[/?#]/)[0];
  return token ? token : null;
}

/**
 * What the stay costs and what has been paid, read from the guest's own page: the staff API
 * has no such figure for a stay whose nights are not on the bill yet, and these are the very
 * amounts the server puts in a message.
 */
export function useStayMoney(links: GuestLinks | undefined, enabled = true) {
  const token = guestToken(links);
  return useSWR<StayMoney>(enabled && token ? `/public/bookings/${token}` : null, {
    shouldRetryOnError: false,
  });
}
