import { Hourglass } from 'lucide-react';
import { pageClass } from '@/components/site-chrome';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Shown in place of a page when the API has been asked too often from the
 * guest's address and wants a pause before it answers again.
 */
export function TooManyTries() {
  return (
    <div className={cn(pageClass, 'py-12 sm:py-20')}>
      <div className="mx-auto max-w-xl rounded-2xl border border-line/70 bg-surface p-6 text-center shadow-card sm:p-10">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sunken text-ink-soft">
          <Hourglass className="size-7" aria-hidden />
        </span>
        <h1 className="mt-5 font-display text-3xl leading-tight sm:text-4xl">
          Please wait a minute
        </h1>
        <p className="mt-3 text-base text-ink-soft">
          There were too many attempts in a short time, so this page is taking a short break.
          Nothing about your booking has changed.
        </p>
        <div className="mt-7">
          {/* An empty address is the page's own: this loads it again, with or without scripts. */}
          <a href="" className={cn(buttonClass('primary'), 'w-full sm:w-auto')}>
            Try again
          </a>
        </div>
      </div>
    </div>
  );
}
