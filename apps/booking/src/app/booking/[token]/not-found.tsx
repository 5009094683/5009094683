import { Link2Off } from 'lucide-react';
import type { Metadata } from 'next';
import { pageClass } from '@/components/site-chrome';
import { ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'This link does not work any more',
  robots: { index: false, follow: false },
};

/** Shown for a booking link that is wrong, has been replaced or has run out. */
export default function DeadLink() {
  return (
    <div className={cn(pageClass, 'py-12 sm:py-20')}>
      <div className="mx-auto max-w-xl rounded-2xl border border-line/70 bg-surface p-6 text-center shadow-card sm:p-10">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sunken text-ink-soft">
          <Link2Off className="size-7" aria-hidden />
        </span>
        <h1 className="mt-5 font-display text-3xl leading-tight sm:text-4xl">
          This link does not work any more
        </h1>
        <p className="mt-3 text-base text-ink-soft">
          Booking links stop working after a while, and when a newer one has been sent. If you have
          a later message from us, use the link in that one.
        </p>
        <p className="mt-3 text-base text-ink-soft">
          Otherwise, please contact the property and give your booking reference. They will send you
          a new link.
        </p>
        <div className="mt-7">
          <ButtonLink href="/" className="w-full sm:w-auto">
            Find our contact details
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
