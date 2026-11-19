'use client';

import { useEffect, useRef } from 'react';

/**
 * Gives the keyboard focus back to the control a dialog was opened from once the dialog has
 * closed, so that someone working by keyboard carries on from where they were. The shared
 * dialogs are opened by state rather than by a trigger of their own, and so cannot know where
 * to return to.
 *
 * Call the returned function in the handler that opens the dialog.
 */
export function useReturnFocus(open: boolean): () => void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    // A control that a change has taken off the page has nothing to give the focus back to.
    if (wasOpen.current && !open && opener.current?.isConnected) opener.current.focus();
    wasOpen.current = open;
  }, [open]);
  return () => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
  };
}
