'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { useAuth } from '@/lib/auth';
import type { ArrivalRisk } from './types';

/** How many days ahead the arrivals are weighed, today included. */
export const RISK_DAYS = 14;

/**
 * The arrivals of the coming days at a property, each with how likely it is to be cancelled or
 * not to turn up. Every caller shares one request.
 */
export function useArrivalRisks(propertyId: string | undefined) {
  const auth = useAuth();
  const allowed = propertyId !== undefined && auth.can('reservations.read', propertyId);
  const { data, error, mutate } = useSWR<{ arrivals: ArrivalRisk[] }>(
    allowed ? `/properties/${propertyId}/insights/arrivals-risk?days=${RISK_DAYS}` : null,
    // Another hotel's guests must not stay on screen while a newly chosen property loads.
    { keepPreviousData: false },
  );
  const byReservation = useMemo(
    () => new Map((data?.arrivals ?? []).map((arrival) => [arrival.reservationId, arrival])),
    [data],
  );
  return { allowed, arrivals: data?.arrivals, byReservation, error, mutate };
}
