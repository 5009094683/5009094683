'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useLive } from '@/lib/live';

/** How often the monitor asks again: counters move even when nothing announces a change. */
export const REFRESH_MS = 5_000;

/**
 * Something the sync monitor shows: fetched again every few seconds and as
 * soon as the server announces a sync change. What was loaded stays on screen
 * while the next answer is on its way.
 */
export function useMonitor<T>(path: string | null) {
  const result = useSWR<T>(path, { refreshInterval: REFRESH_MS });
  const { mutate } = result;
  useLive(/^sync\./, () => void mutate());
  return result;
}

/** The current time, renewed every few seconds so relative times ("2 min ago") keep moving. */
export function useNow(intervalMs: number = REFRESH_MS): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
