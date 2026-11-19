'use client';

import { useEffect, useRef } from 'react';
import { Notice } from '@/components/ui/misc';

/**
 * What is wrong with a form, or what went wrong when it was sent. In a long
 * dialog the message may be scrolled out of sight, so it is brought into view
 * when it appears. Give it a new `key` to do so again for the same message.
 */
export function FormError({
  message,
  tone = 'danger',
}: {
  message: string | null;
  tone?: 'danger' | 'warning';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref}>
      <Notice tone={tone}>{message}</Notice>
    </div>
  );
}
