'use client';

import { useEffect, useRef } from 'react';

/**
 * Gives the keyboard focus back to the control that opened a dialog once the dialog has closed,
 * so that someone working by keyboard carries on from where they were. The shared dialogs are
 * opened by state rather than by a trigger of their own, and so cannot know where to return to.
 *
 * Call the returned function with the event that opens the dialog.
 */
export function useReturnFocus(open: boolean): (event: { currentTarget: HTMLElement }) => void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (event) => {
    opener.current = event.currentTarget;
  };
}
