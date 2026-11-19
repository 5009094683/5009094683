import { Compass } from 'lucide-react';
import type { Metadata } from 'next';
import { pageClass } from '@/components/site-chrome';
import { ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'This page does not exist',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className={cn(pageClass, 'py-12 sm:py-20')}>
      <div className="mx-auto max-w-xl rounded-2xl border border-line/70 bg-surface p-6 text-center shadow-card sm:p-10">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-sunken text-ink-soft">
          <Compass className="size-7" aria-hidden />
        </span>
        <h1 className="mt-5 font-display text-3xl leading-tight sm:text-4xl">
          This page does not exist
        </h1>
        <p className="mt-3 text-base text-ink-soft">
          The address may have a typing mistake in it, or the place may no longer take bookings on
          this website.
        </p>
        <div className="mt-7">
          <ButtonLink href="/" variant="primary" className="w-full sm:w-auto">
            See where you can stay
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
