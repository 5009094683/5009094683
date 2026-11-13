'use client';

import { useEffect, useRef } from 'react';
import { Notice } from '@/components/ui/misc';

/**
 * What went wrong when a form was sent, in the server's own words. In a long dialog the message
 * may be scrolled out of sight, so it is brought into view when it appears.
 */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} className="scroll-my-4">
      <Notice tone="danger">{message}</Notice>
    </div>
  );
}
