'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * A group of controls, some of which go away once they have been used: Issue,
 * on a statement that is then issued; the bin beside a cost that is then
 * removed. A browser drops the keyboard to the top of the page when the
 * control it was on disappears. This hands it to the group instead, so that
 * the next Tab reaches whatever took the control's place.
 *
 * It has to be rendered by the component whose change takes the control away.
 */
export function KeepFocus({
  label,
  className,
  children,
}: {
  /** What the group is, for someone who cannot see it. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const group = useRef<HTMLDivElement>(null);
  /** The control of this group that last had the keyboard. */
  const last = useRef<Element | null>(null);

  // After every change to what is shown: has the control that was in use gone, leaving the
  // keyboard nowhere? A dialog it opened may still be closing, in which case this waits.
  useLayoutEffect(() => {
    if (!last.current || last.current.isConnected) return;
    if (document.activeElement !== document.body) return;
    last.current = null;
    group.current?.focus();
  });

  return (
    <div
      ref={group}
      role="group"
      aria-label={label}
      tabIndex={-1}
      onFocus={(event) => {
        // Focus inside a dialog opened from here reaches this handler too; it is not in the group.
        if (event.currentTarget.contains(event.target)) last.current = event.target;
      }}
      className={className}
    >
      {children}
    </div>
  );
}
