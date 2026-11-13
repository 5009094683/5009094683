'use client';

import useSWR from 'swr';
import type { Company, ReservationFolios } from './types';

export const foliosKey = (reservationId: string): string => `/reservations/${reservationId}/folios`;

/**
 * A reservation's folios, balance and invoices. Data from the reservation shown before is not
 * kept on screen meanwhile: a bill must never appear, even briefly, under another guest's name.
 */
export function useReservationFolios(reservationId: string, enabled = true) {
  return useSWR<ReservationFolios>(enabled ? foliosKey(reservationId) : null, {
    keepPreviousData: false,
  });
}

/** Companies and travel agents that can be billed, with what each owes on account. */
export function useCompanies(enabled = true) {
  const { data, error, isLoading } = useSWR<{ companies: Company[] }>(
    enabled ? '/companies' : null,
  );
  return { companies: data?.companies ?? [], error, isLoading };
}
