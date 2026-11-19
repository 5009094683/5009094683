import { ArrowRight, MapPin } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Photo } from '@/components/photo';
import { pageClass } from '@/components/site-chrome';
import { buttonClass } from '@/components/ui/button';
import { LinkPending } from '@/components/ui/link-pending';
import { cn } from '@/lib/cn';
import { kindLabel, placeOf } from '@/lib/format';
import { usablePhotos } from '@/lib/photos';
import { TooManyTries } from '@/components/too-many-tries';
import { BUSY, forPublicPage, NOT_SET_UP } from '@/lib/guest-page';
import { getProperties } from '@/lib/server-api';
import { propertyPath } from '@/lib/stay';
import type { Property } from '@/lib/types';

function PropertyCard({ property }: { property: Property }) {
  const place = placeOf(property);
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-card transition-shadow focus-within:shadow-pop hover:shadow-pop">
      <div className="aspect-[4/3]">
        <Photo
          src={usablePhotos(property.photos)[0]}
          alt={`Photo of ${property.name}`}
          name={property.name}
          caption
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <p className="text-xs font-semibold tracking-wider text-ink-faint uppercase">
          {kindLabel(property.kind)}
        </p>
        <h2 className="font-display text-2xl leading-tight">{property.name}</h2>
        {place ? (
          <p className="flex items-center gap-1.5 text-[15px] text-ink-soft">
            <MapPin className="size-4 shrink-0" aria-hidden />
            {place}
          </p>
        ) : null}
        {property.description ? (
          <p className="line-clamp-2 text-[15px] text-ink-soft">{property.description}</p>
        ) : null}
        <div className="mt-auto pt-3">
          {/* The link is stretched over the whole card, so the card is one large target. */}
          <Link
            href={propertyPath(property.code)}
            aria-label={`View and book ${property.name}`}
            className={cn(buttonClass('primary'), 'w-full after:absolute after:inset-0 sm:w-auto')}
          >
            View and book
            <LinkPending icon={<ArrowRight className="size-4" aria-hidden />} />
          </Link>
        </div>
      </div>
    </article>
  );
}

export default async function HomePage() {
  const listed = await forPublicPage(getProperties());
  if (listed === BUSY) return <TooManyTries browsing />;
  if (listed === NOT_SET_UP) {
    return (
      <div className={cn(pageClass, 'py-8 sm:py-12')}>
        <h1 className="font-display text-3xl leading-tight sm:text-4xl">
          Nothing can be booked here yet
        </h1>
        <p className="mt-4 max-w-prose text-ink-soft">
          This booking website has not been set up. If a hotel gave you this address, please get in
          touch with them directly.
        </p>
      </div>
    );
  }
  const { organisation, properties } = listed;
  const only = properties.length === 1 ? properties[0] : undefined;
  if (only) redirect(propertyPath(only.code));

  return (
    <div className={cn(pageClass, 'py-8 sm:py-12')}>
      <h1 className="font-display text-3xl leading-tight sm:text-4xl">
        Where would you like to stay?
      </h1>
      {properties.length > 0 ? (
        <>
          <p className="mt-2 text-ink-soft">
            Choose a place to see its rooms and prices, and to book.
          </p>
          <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {properties.map((property) => (
              <li key={property.code}>
                <PropertyCard property={property} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 max-w-prose text-ink-soft">
          {organisation.name} is not taking bookings on this website at the moment. Please get in
          touch with us directly.
        </p>
      )}
    </div>
  );
}
