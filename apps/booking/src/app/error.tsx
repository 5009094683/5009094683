'use client';

import { CloudOff } from 'lucide-react';
import { useEffect, useRef, useTransition } from 'react';
import { pageClass } from '@/components/site-chrome';
import { Button, ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const [retrying, startRetry] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error(error);
    heading.current?.focus();
  }, [error]);

  return (
    <div className={cn(pageClass, 'py-12 sm:py-20')}>
      <div
        role="alert"
        className="mx-auto max-w-xl rounded-2xl border border-line/70 bg-surface p-6 text-center shadow-card sm:p-10"
      >
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sunken text-ink-soft">
          <CloudOff className="size-7" aria-hidden />
        </span>
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-5 font-display text-3xl leading-tight outline-none sm:text-4xl"
        >
          This page could not be shown
        </h1>
        <p className="mt-3 text-base text-ink-soft">
          Something went wrong on our side. Please try again in a moment.
        </p>
        <p className="mt-3 text-base text-ink-soft">
          If you were paying or booking, look for our email before you try again, so that you do not
          book twice.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Button
            variant="primary"
            loading={retrying}
            onClick={() => {
              if (!retrying) startRetry(() => retry());
            }}
          >
            Try again
          </Button>
          <ButtonLink href="/">Go to the start page</ButtonLink>
        </div>
      </div>
    </div>
  );
}
