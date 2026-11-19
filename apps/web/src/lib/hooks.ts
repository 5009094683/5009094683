'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type { Property, PropertyDetail } from './types';

/** Properties the signed-in user can see. */
export function useProperties() {
  const { data, error, isLoading, mutate } = useSWR<{ properties: Property[] }>('/properties');
  return { properties: data?.properties ?? [], error, isLoading, mutate };
}

/** A property with its room types, units and rate plans. Pass null to skip. */
export function usePropertyDetail(propertyId: string | null | undefined) {
  return useSWR<PropertyDetail>(propertyId ? `/properties/${propertyId}` : null);
}

/** State kept in localStorage, so a choice (zoom, last property) survives a reload. */
export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      // Unreadable storage: keep the default.
    }
    loaded.current = true;
  }, [key]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked: the choice simply will not persist.
      }
    },
    [key],
  );
  return [value, update];
}

/** The property a single-property screen works on: the last one chosen, else the first available. */
export function useCurrentProperty(): {
  property: Property | undefined;
  properties: Property[];
  select: (id: string) => void;
  isLoading: boolean;
} {
  const { properties, isLoading } = useProperties();
  const [storedId, setStoredId] = useStoredState<string | null>('pms.property', null);
  const property = properties.find((p) => p.id === storedId) ?? properties[0];
  return { property, properties, select: setStoredId, isLoading };
}

/** A value that follows `value` after it has been stable for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Runs an async action with busy and error state for a form or button. */
export function useAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
): {
  run: (...args: Args) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  });
  const run = useCallback(async (...args: Args) => {
    setBusy(true);
    setError(null);
    try {
      await actionRef.current(...args);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, clearError: useCallback(() => setError(null), []) };
}
