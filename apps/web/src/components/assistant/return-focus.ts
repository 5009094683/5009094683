'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Puts the keyboard back on the control that opened a dialog, a drawer or a part of the page
 * that opens in place, once it has closed. It does not depend on how the thing that closed was
 * built: a dialog that stays mounted while closed and a form shown inside a drawer are covered
 * alike.
 *
 * Call the returned function in the handler that opens it. When the control has gone or can no
 * longer take the keyboard (a button that is disabled by then), `fallback` gets it instead.
 */
export function useReturnFocus(
  open: boolean,
  fallback?: RefObject<HTMLElement | null>,
): () => void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const control = opener.current;
      if (control?.isConnected && !control.matches(':disabled')) control.focus();
      else fallback?.current?.focus();
    }
    wasOpen.current = open;
  }, [open, fallback]);
  return () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  };
}
