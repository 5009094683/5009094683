import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Short facts side by side with a dot between them. Each fact carries the dot before it, and
 * the edge cuts off the dot of whichever starts a line: however they wrap, no dot is left
 * hanging at the end of a line or the start of the next.
 */
export function Details({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('block [clip-path:inset(-6px)]', className)}>
      <span className="-ml-4 flex flex-wrap items-center">{children}</span>
    </span>
  );
}

export function Detail({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'relative min-w-0 pl-4 [overflow-wrap:anywhere]',
        'before:absolute before:top-1/2 before:left-1.5 before:size-[3px] before:-translate-y-1/2',
        'before:rounded-full before:bg-ink-faint',
        className,
      )}
    >
      {children}
    </span>
  );
}
