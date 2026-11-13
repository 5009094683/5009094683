'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LiveEvent } from './types';

type Listener = (event: LiveEvent) => void;

interface LiveContextValue {
  /** True while the event stream is connected. */
  connected: boolean;
  subscribe(listener: Listener): () => void;
}

const LiveContext = createContext<LiveContextValue>({
  connected: false,
  subscribe: () => () => {},
});

/**
 * One server-sent-events connection per browser tab. Screens subscribe to it
 * and refetch what an event touched, so a change made on one screen (or by a
 * channel) appears on every other screen without reloading.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/live');
    let wasConnected = false;
    const broadcast = (event: LiveEvent) => {
      for (const listener of listeners.current) listener(event);
    };
    source.onopen = () => {
      setConnected(true);
      // Anything that changed while the stream was down was missed: refetch everything.
      if (wasConnected) broadcast({ id: 0, kind: 'resync', orgId: '', propertyId: null });
      wasConnected = true;
    };
    source.onerror = () => setConnected(false);
    source.addEventListener('change', (message) => {
      try {
        broadcast(JSON.parse((message as MessageEvent<string>).data) as LiveEvent);
      } catch {
        // Ignore a malformed event rather than break the stream.
      }
    });
    return () => {
      source.close();
      setConnected(false);
    };
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({
      connected,
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [connected],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLiveStatus(): boolean {
  return useContext(LiveContext).connected;
}

/**
 * Calls `handler` for every live event whose kind matches. Bursts are
 * coalesced: one booking produces several events (the reservation, the
 * availability of each room type), and refetching once is enough.
 */
export function useLive(
  match: RegExp,
  handler: (events: LiveEvent[]) => void,
  delayMs = 120,
): void {
  const { subscribe } = useContext(LiveContext);
  const handlerRef = useRef(handler);
  const matchRef = useRef(match);
  useEffect(() => {
    handlerRef.current = handler;
    matchRef.current = match;
  });

  useEffect(() => {
    let pending: LiveEvent[] = [];
    let timer: number | undefined;
    const unsubscribe = subscribe((event) => {
      if (event.kind !== 'resync' && !matchRef.current.test(event.kind)) return;
      pending.push(event);
      if (timer === undefined) {
        timer = window.setTimeout(() => {
          const batch = pending;
          pending = [];
          timer = undefined;
          handlerRef.current(batch);
        }, delayMs);
      }
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [subscribe, delayMs]);
}
