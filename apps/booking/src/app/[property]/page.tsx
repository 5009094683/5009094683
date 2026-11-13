import { CircleAlert, CircleCheck, Clock, MapPin } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AmenityList } from '@/components/amenities';
import { ContactLinks } from '@/components/contact-links';
import { Gallery } from '@/components/gallery';
import { RateSelection } from '@/components/property/rate-selection';
import { fits, OfferCard, RatesSkeleton, RoomCard } from '@/components/property/rooms';
import { ARRIVAL_FIELD, RESULTS_SECTION, SearchBar } from '@/components/property/search-bar';
import { pageClass } from '@/components/site-chrome';
import { buttonClass } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { errorMessage } from '@/lib/api-error';
import { brandStyle } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { dateIn, formatDate, formatDay } from '@/lib/dates';
import { count, kindLabel, party, placeOf, sentence } from '@/lib/format';
import { getProperty, searchStay } from '@/lib/server-api';
import {
  hasDates,
  propertyPath,
  readStay,
  stayQuery,
  type SearchParams,
  type StayInput,
} from '@/lib/stay';
import type { PropertyDetail, RoomType, Stay } from '@/lib/types';

interface Props {
  params: Promise<{ property: string }>;
  searchParams: Promise<SearchParams>;
}

/** A search that has ended, one way or the other: it never rejects, so it can be awaited in several places. */
type Outcome = { ok: true; stay: Stay } | { ok: false; message: string };

function search(code: string, stay: StayInput): Promise<Outcome> {
  return searchStay(code, { ...stay, promo: stay.promo || undefined }).then(
    (found): Outcome => ({ ok: true, stay: found }),
    (err: unknown): Outcome => ({ ok: false, message: errorMessage(err) }),
  );
}

/** Notices carried in the address by a page that sent the guest back here. */
const NOTICES: Record<string, { title: string; text: string }> = {
  gone: {
    title: 'That room is no longer free for these dates',
    text: 'Someone else may have just booked it. Please choose again, or try other dates.',
  },
  changed: {
    title: 'That price is no longer on offer',
    text: 'Please choose again from what is on offer now.',
  },
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { property: slug } = await params;
  // A place that does not exist is said here as well as on the page, so that the tab takes the
  // title of the page that says so. A fault is left to the page, which asks the same question.
  const property = await getProperty(slug).catch(() => undefined);
  if (property === null) notFound();
  if (!property) return {};
  const place = placeOf(property);
  return {
    title: property.name,
    description:
      property.description ??
      `Rooms and prices at ${property.name}${place ? `, ${place}` : ''}. Book directly.`,
  };
}

function heading(property: PropertyDetail): string {
  return property.kind === 'hotel' ? 'Choose your room' : 'Choose your stay';
}

async function PromoMessage({ outcome }: { outcome: Promise<Outcome> }) {
  const result = await outcome;
  const promo = result.ok ? result.stay.promo : null;
  if (!promo) return null;
  return promo.applied ? (
    <p className="flex items-start gap-1.5 font-medium text-success-700">
      <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {promo.code} gives {promo.label}. It is taken off the prices below.
      </span>
    </p>
  ) : (
    <p className="flex items-start gap-1.5 font-medium text-danger-700">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{sentence(promo.reason ?? 'This code cannot be used for this stay')}</span>
    </p>
  );
}

async function SearchStatus({ outcome, stay }: { outcome: Promise<Outcome>; stay: StayInput }) {
  const result = await outcome;
  if (!result.ok) return 'These dates could not be searched.';
  const free = result.stay.offers.some(
    (offer) => offer.available > 0 && offer.plans.some((plan) => plan.bookable),
  );
  if (!free) return 'Nothing is free for these dates.';
  return `${count(result.stay.nights, 'night')}, ${party(stay.adults, stay.children)} in each room`;
}

function Unsuited({ rooms }: { rooms: RoomType[] }) {
  if (rooms.length === 0) return null;
  const names = rooms.map((room) => room.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return (
    <p className="text-[15px] text-ink-soft">
      Not shown: {list}, which {names.length === 1 ? 'does' : 'do'} not sleep this many guests in
      one room.
    </p>
  );
}

async function Results({
  outcome,
  property,
  stay,
}: {
  outcome: Promise<Outcome>;
  property: PropertyDetail;
  stay: StayInput;
}) {
  const result = await outcome;
  if (!result.ok) {
    return (
      <>
        <Notice tone="warning" role="alert" title="We could not search these dates">
          {result.message}
        </Notice>
        <RoomList rooms={property.roomTypes} />
      </>
    );
  }

  const { offers, promo, nights } = result.stay;
  const shown = new Set(offers.map((offer) => offer.roomType.id));
  const unsuited = property.roomTypes.filter((room) => !shown.has(room.id));
  if (offers.length === 0) {
    return (
      <>
        <Notice tone="info" title="No room sleeps this many guests">
          Search with fewer guests in each room. You can book more than one room at a time.
        </Notice>
        <RoomList rooms={property.roomTypes} />
      </>
    );
  }

  const free = offers.some(
    (offer) => offer.available > 0 && offer.plans.some((plan) => plan.bookable),
  );
  const bookHref = `${propertyPath(property.code)}/book?${stayQuery(stay)}`;
  return (
    <RateSelection>
      {free ? null : (
        <Notice tone="info" title="Nothing is free for these dates">
          Try other dates, or a shorter stay.
        </Notice>
      )}
      {offers.map((offer) => (
        <OfferCard
          key={offer.roomType.id}
          offer={offer}
          nights={nights}
          currency={property.currency}
          promo={promo}
          bookHref={bookHref}
        />
      ))}
      <Unsuited rooms={unsuited} />
    </RateSelection>
  );
}

function RoomList({ rooms, loading = false }: { rooms: RoomType[]; loading?: boolean }) {
  return (
    <>
      {rooms.map((room) => (
        <RoomCard key={room.id} room={room}>
          {loading ? <RatesSkeleton /> : null}
        </RoomCard>
      ))}
    </>
  );
}

function About({ property }: { property: PropertyDetail }) {
  const address = [
    property.addressLine1,
    property.addressLine2,
    [property.city, property.state].filter(Boolean).join(', '),
    property.postalCode,
  ].filter(Boolean);
  return (
    <section
      aria-labelledby="about-heading"
      className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-12"
    >
      <div className="space-y-8">
        <div>
          <h2 id="about-heading" className="font-display text-2xl leading-tight sm:text-3xl">
            About {property.name}
          </h2>
          {property.description ? (
            <p className="mt-3 max-w-prose text-base leading-relaxed whitespace-pre-line text-ink-soft">
              {property.description}
            </p>
          ) : null}
        </div>
        {property.amenities.length > 0 ? (
          <div>
            <h3 className="text-base font-semibold">What you will find here</h3>
            <AmenityList items={property.amenities} className="mt-4" />
          </div>
        ) : null}
      </div>

      <aside className="h-fit space-y-5 rounded-2xl border border-line/70 bg-surface p-5 shadow-card">
        <div>
          <h3 className="text-base font-semibold">Arriving and leaving</h3>
          <dl className="mt-3 space-y-2 text-[15px]">
            <div className="flex items-center gap-2.5">
              <Clock className="size-4 shrink-0 text-ink-faint" aria-hidden />
              <dt className="text-ink-soft">Check-in from</dt>
              <dd className="font-medium tabular-nums">{property.checkInTime}</dd>
            </div>
            <div className="flex items-center gap-2.5">
              <Clock className="size-4 shrink-0 text-ink-faint" aria-hidden />
              <dt className="text-ink-soft">Check-out by</dt>
              <dd className="font-medium tabular-nums">{property.checkOutTime}</dd>
            </div>
          </dl>
        </div>
        {address.length > 0 || property.phone || property.email ? (
          <div className="border-t border-line pt-5">
            <h3 className="text-base font-semibold">Find us</h3>
            {address.length > 0 ? (
              <p className="mt-3 flex items-start gap-2.5 py-1 text-[15px]">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                <span>
                  {address.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </span>
              </p>
            ) : null}
            <ContactLinks phone={property.phone} email={property.email} className="mt-1" />
          </div>
        ) : null}
      </aside>
    </section>
  );
}

export default async function PropertyPage({ params, searchParams }: Props) {
  const [{ property: slug }, query] = await Promise.all([params, searchParams]);
  const property = await getProperty(slug);
  if (!property) notFound();

  const path = propertyPath(property.code);
  const stay = readStay(query);
  if (slug !== property.code.toLowerCase()) {
    redirect(hasDates(stay) ? `${path}?${stayQuery(stay)}` : path);
  }

  const searched = hasDates(stay);
  const outcome = searched ? search(property.code, stay) : null;
  const searchKey = stayQuery(stay);
  const notice = typeof query.notice === 'string' ? NOTICES[query.notice] : undefined;
  const place = placeOf(property);
  const suited = searched
    ? property.roomTypes.filter((room) => fits(room, stay.adults, stay.children))
    : property.roomTypes;
  const sameYear = stay.checkIn.slice(0, 4) === stay.checkOut.slice(0, 4);

  return (
    <div style={brandStyle(property.brandColor)}>
      <div className={cn(pageClass, 'pt-4 sm:pt-6')}>
        <Gallery name={property.name} photos={property.photos} />

        <header className="mt-5 sm:mt-7">
          <p className="text-xs font-semibold tracking-wider text-ink-faint uppercase">
            {kindLabel(property.kind)}
          </p>
          <h1 className="mt-1 font-display text-4xl leading-[1.1] sm:text-5xl">{property.name}</h1>
          {place ? (
            <p className="mt-2 flex items-center gap-1.5 text-ink-soft">
              <MapPin className="size-4 shrink-0" aria-hidden />
              {place}
            </p>
          ) : null}
        </header>

        <div className="mt-6">
          {notice ? (
            <Notice tone="warning" role="status" title={notice.title} className="mb-4">
              {notice.text}
            </Notice>
          ) : null}
          <SearchBar
            path={path}
            stay={stay}
            today={dateIn(property.timezone)}
            bookableUntil={property.bookableUntil}
            maxAdults={Math.max(1, ...property.roomTypes.map((room) => room.maxAdults))}
            maxChildren={Math.max(0, ...property.roomTypes.map((room) => room.maxChildren))}
            childMaxAge={property.childMaxAge}
            promoMessage={
              outcome ? (
                <Suspense key={searchKey} fallback={null}>
                  <PromoMessage outcome={outcome} />
                </Suspense>
              ) : null
            }
          />
        </div>

        <section id={RESULTS_SECTION} aria-labelledby="rooms-heading" className="mt-10">
          <h2 id="rooms-heading" className="font-display text-2xl leading-tight sm:text-3xl">
            {heading(property)}
          </h2>

          {/* Stays in reach at the top of a small screen while the guest reads the rooms below. */}
          <div className="sticky top-0 z-20 -mx-4 mt-2 flex items-center justify-between gap-3 border-b border-line bg-canvas/95 px-4 py-2.5 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <div className="min-w-0 text-[15px]">
              {searched ? (
                <p className="font-medium text-ink">
                  {sameYear ? formatDay(stay.checkIn) : formatDate(stay.checkIn)} to{' '}
                  {formatDate(stay.checkOut)}
                </p>
              ) : null}
              <p role="status" className="text-ink-soft">
                {outcome ? (
                  <Suspense key={searchKey} fallback="Looking up prices">
                    <SearchStatus outcome={outcome} stay={stay} />
                  </Suspense>
                ) : (
                  'Choose your dates to see prices.'
                )}
              </p>
            </div>
            <a
              href={`#${ARRIVAL_FIELD}`}
              className={cn(buttonClass(searched ? 'secondary' : 'primary'), 'shrink-0 lg:hidden')}
            >
              {searched ? 'Change' : 'Choose dates'}
            </a>
          </div>

          <div className="mt-5 space-y-5">
            {outcome ? (
              <>
                {/* The prices follow the page and are put in place by a script: without one,
                    the placeholders below would stay for good, with no word of why. */}
                <noscript className="block">
                  <Notice tone="warning" title="Prices cannot be shown">
                    This page needs scripts to show prices and to book, and your browser has them
                    switched off. Please switch them on and load the page again.
                  </Notice>
                </noscript>
                <Suspense key={searchKey} fallback={<RoomList rooms={suited} loading />}>
                  <Results outcome={outcome} property={property} stay={stay} />
                </Suspense>
              </>
            ) : (
              <RoomList rooms={property.roomTypes} />
            )}
          </div>
        </section>

        <About property={property} />
      </div>
    </div>
  );
}
