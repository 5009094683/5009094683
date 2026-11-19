'use client';

import { useCallback, useState } from 'react';
import type { PendingChange } from './pending';

const keyFor = (propertyId: string): string => `pms.rates.pending.${propertyId}`;

function read(propertyId: string | undefined): PendingChange[] {
  if (!propertyId || typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(keyFor(propertyId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as PendingChange[]) : [];
  } catch {
    // Unreadable storage: start with nothing waiting.
    return [];
  }
}

/**
 * The changes waiting to be saved for one property. They are kept for as long
 * as the browser tab is open, so that looking something up on another screen,
 * or reloading, does not lose them.
 */
export function usePendingChanges(
  propertyId: string | undefined,
): [PendingChange[], (next: PendingChange[]) => void] {
  const [state, setState] = useState<{ propertyId: string | undefined; list: PendingChange[] }>({
    propertyId: undefined,
    list: [],
  });
  if (state.propertyId !== propertyId) {
    setState({ propertyId, list: read(propertyId) });
  }
  const update = useCallback(
    (next: PendingChange[]) => {
      setState({ propertyId, list: next });
      if (!propertyId) return;
      try {
        if (next.length === 0) window.sessionStorage.removeItem(keyFor(propertyId));
        else window.sessionStorage.setItem(keyFor(propertyId), JSON.stringify(next));
      } catch {
        // Storage full or blocked: the changes simply will not survive a reload.
      }
    },
    [propertyId],
  );
  return [state.propertyId === propertyId ? state.list : [], update];
}
