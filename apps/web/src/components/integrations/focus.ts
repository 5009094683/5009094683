'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * Keeps the keyboard somewhere sensible after a run of dialogs has closed.
 *
 * The shared dialog hands the keyboard back to the control it was opened from. That is not
 * enough in two cases here: a dialog that follows another (the key is shown after the form that
 * made it, so the form's button is gone by then), and an action that removes its own button
 * (Revoke, Delete). In both the keyboard would be left on nothing. This puts it back on the
 * control the first dialog was opened from, or failing that on `fallback`.
 *
 * `open` is true for as long as any dialog of the run is open.
 */
export function useReturnFocus(open: boolean, fallback: RefObject<HTMLElement | null>): void {
  const [seen, setSeen] = useState<{ open: boolean; opener: HTMLElement | null; closes: number }>({
    open: false,
    opener: null,
    closes: 0,
  });
  if (seen.open !== open) {
    // Read while the first dialog is on its way: once it is on screen it holds the keyboard.
    const active = typeof document === 'undefined' ? null : document.activeElement;
    setSeen({
      open,
      opener: open ? (active instanceof HTMLElement ? active : null) : seen.opener,
      closes: open ? seen.closes : seen.closes + 1,
    });
  }

  const { opener, closes } = seen;
  useEffect(() => {
    if (closes === 0) return;
    // After the closing dialog has had its own go at handing the keyboard back.
    const timer = window.setTimeout(() => {
      if (document.activeElement !== document.body) return;
      if (opener?.isConnected && !opener.matches(':disabled')) opener.focus();
      else fallback.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [closes, opener, fallback]);
}

/** The current time, renewed now and then so "3 min ago" and "expired" keep up with the clock. */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
