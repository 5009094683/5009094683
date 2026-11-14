'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Brings what it holds into view when it appears. In a dialog longer than the screen, the
 * button is always in sight but what went wrong may not be: without this, pressing the button
 * can look as if nothing happened.
 */
export function IntoView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return <div ref={ref}>{children}</div>;
}
