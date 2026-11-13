'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

const never = () => () => {};

/**
 * False on the server and while the page is being made interactive, true
 * afterwards. For what only the guest's own device knows, such as its clock.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
}

/**
 * Milliseconds left until a moment, counted down once a second. Null until the
 * page is interactive: the server's clock is not the guest's.
 */
export function useTimeLeft(until: string | null | undefined): number | null {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!until) return;
    const end = new Date(until).getTime();
    const tick = () => setLeft(Math.max(0, end - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      setLeft(null);
    };
  }, [until]);

  return left;
}

/** `14:05` left as `14 min 5 s`, `0:45` as `45 s`. */
export function formatTimeLeft(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}
