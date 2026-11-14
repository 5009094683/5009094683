import Link from 'next/link';

export function SiteHeader({ name }: { name: string }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex min-h-14 max-w-6xl items-center px-4 sm:px-6">
        <Link
          href="/"
          className="-mx-2 flex min-h-11 items-center rounded-lg px-2 font-display text-lg leading-tight text-ink hover:bg-sunken"
        >
          {name}
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter({ name }: { name: string }) {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-ink-soft sm:px-6">
        <p className="font-display text-base text-ink">{name}</p>
        <p className="mt-1">You book directly with the property on this website.</p>
      </div>
    </footer>
  );
}

/** The width and side padding every page shares. */
export const pageClass = 'mx-auto w-full max-w-6xl px-4 sm:px-6';
