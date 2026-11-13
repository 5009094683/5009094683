'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { formatExact, sentence } from './labels';

/** A relative time ("2 min ago"); the full time shows on hover. */
export function RelativeTime({ value, now }: { value: string; now: Date }) {
  return (
    <time dateTime={value} title={formatExact(value)}>
      {formatRelative(value, now)}
    </time>
  );
}

/** A link that looks like a small secondary button, for going to another page. */
export function ButtonLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5',
        'text-[13px] font-medium whitespace-nowrap text-ink shadow-sm transition-colors select-none hover:bg-sunken active:bg-line',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Shown above data that could not be refreshed. A monitor that quietly keeps
 * showing an old "up to date" would mislead, so it says the data may be old.
 */
export function StaleNotice({
  error,
  onRetry,
  title = 'This could not be refreshed',
  consequence = 'What you see may be out of date.',
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
  /** What the failure means for what is on screen. */
  consequence?: string;
}) {
  return (
    <Notice tone="warning" title={title} className="mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {consequence} {sentence(errorMessage(error))}
        </span>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Notice>
  );
}
