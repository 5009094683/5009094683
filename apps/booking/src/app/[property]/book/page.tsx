import { ArrowLeft, CalendarCheck, CircleSlash, Tag } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { BookingForm } from '@/components/booking-form';
import { pageClass } from '@/components/site-chrome';
import { LinkPending } from '@/components/ui/link-pending';
import { Notice } from '@/components/ui/notice';
import { ApiError } from '@/lib/api-error';
import { brandStyle } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { countriesWithFirst } from '@/lib/countries';
import { formatDate, formatDay } from '@/lib/dates';
import { count, formatMoney, mealPlanLabel, moneyColumn, party, placeOf } from '@/lib/format';
import { getOrganisationName, getProperty, organisationSlug, searchStay } from '@/lib/server-api';
import {
  hasDates,
  MAX_ROOMS,
  propertyPath,
  readId,
  readRooms,
  readStay,
  stayQuery,
  type SearchParams,
} from '@/lib/stay';
import type { Offer, Plan, Promo, PropertyDetail, Stay } from '@/lib/types';
import { TooManyTries } from '@/components/too-many-tries';
import { BUSY, forPublicPage, NOT_SET_UP } from '@/lib/guest-page';

interface Props {
  params: Promise<{ property: string }>;
  searchParams: Promise<SearchParams>;
}

const metadata: Metadata = {
  title: 'Your booking',
  robots: { index: false },
};

// As on the property's page: a place that does not exist is said here as well, so that the
// tab takes the title of the page that says so.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { property: slug } = await params;
  if ((await getProperty(slug).catch(() => undefined)) === null) notFound();
  return metadata;
}

function Line({
  label,
  amount,
  strong = false,
  className,
}: {
  label: string;
  amount: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn('flex justify-between gap-4', strong && 'font-semibold text-ink', className)}
    >
      <dt>{label}</dt>
      <dd className="text-right tabular-nums">{amount}</dd>
    </div>
  );
}

interface SummaryProps {
  property: PropertyDetail;
  stay: Stay;
  offer: Offer;
  plan: Plan;
  rooms: number;
  promo: Promo | null;
}

function Summary({ property, stay, offer, plan, rooms, promo }: SummaryProps) {
  const place = placeOf(property);
  const meal = mealPlanLabel(plan.mealPlan);
  const total = plan.total * rooms;
  const payNow = plan.payNow * rooms;
  const money = moneyColumn(property.currency, [
    ...plan.nightly.map((night) => night.amount),
    plan.subtotal,
    plan.discount,
    plan.taxes,
    total,
    payNow,
  ]);
  const discounted = plan.discount > 0;
  const CancelIcon = plan.cancellation.nonRefundable ? CircleSlash : CalendarCheck;
  const nightly = (
    <ul className="space-y-1">
      {plan.nightly.map((night) => (
        <li key={night.date} className="flex justify-between gap-4">
          <span>{formatDay(night.date)}</span>
          <span className="tabular-nums">{money(night.amount)}</span>
        </li>
      ))}
    </ul>
  );
  const nightlyNote =
    rooms > 1 && discounted
      ? 'For one room, after the discount.'
      : rooms > 1
        ? 'For one room.'
        : discounted
          ? 'After the discount.'
          : null;

  return (
    <section
      aria-labelledby="summary-heading"
      className="rounded-2xl border border-line/70 bg-surface shadow-card"
    >
      <div className="space-y-4 p-4 sm:p-6">
        <div>
          <h2 id="summary-heading" className="font-display text-2xl leading-tight">
            {property.name}
          </h2>
          {place ? <p className="mt-0.5 text-[15px] text-ink-soft">{place}</p> : null}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-[15px]">
          <div>
            <dt className="text-sm text-ink-soft">Arrival</dt>
            <dd className="font-medium">{formatDate(stay.checkIn)}</dd>
            <dd className="text-sm text-ink-soft">from {property.checkInTime}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-soft">Departure</dt>
            <dd className="font-medium">{formatDate(stay.checkOut)}</dd>
            <dd className="text-sm text-ink-soft">by {property.checkOutTime}</dd>
          </div>
        </dl>

        <div className="border-t border-line pt-4 text-[15px]">
          <p className="font-medium">
            {rooms} x {offer.roomType.name}
          </p>
          <p className="text-ink-soft">
            {plan.name}
            {meal ? `, ${meal.toLowerCase()}` : ''}
          </p>
          <p className="text-ink-soft">
            {count(stay.nights, 'night')}, {party(stay.adults, stay.children)}
            {rooms > 1 ? ' in each room' : ''}
          </p>
        </div>

        <div className="border-t border-line pt-4 text-[15px] text-ink-soft">
          {stay.nights <= 4 ? (
            <div className="mb-3">
              {nightly}
              {nightlyNote ? <p className="mt-1 text-sm text-ink-faint">{nightlyNote}</p> : null}
            </div>
          ) : (
            <details className="group mb-2">
              <summary className="-my-1.5 inline-flex min-h-11 items-center underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink">
                <span className="group-open:hidden">Show the price of each night</span>
                <span className="hidden group-open:inline">Hide the price of each night</span>
              </summary>
              <div className="mt-2 mb-3 rounded-lg bg-sunken/70 p-3">
                {nightly}
                {nightlyNote ? <p className="mt-1 text-sm text-ink-faint">{nightlyNote}</p> : null}
              </div>
            </details>
          )}
          <dl className="space-y-1.5">
            <Line
              label={
                rooms > 1
                  ? `${count(rooms, 'room')}, ${count(stay.nights, 'night')}`
                  : count(stay.nights, 'night')
              }
              amount={money(plan.subtotal * rooms)}
            />
            {discounted ? (
              <Line
                label={promo ? `Discount (${promo.code}: ${promo.label})` : 'Discount'}
                amount={`-${money(plan.discount * rooms)}`}
                className="text-success-700"
              />
            ) : null}
            <Line label="Taxes" amount={money(plan.taxes * rooms)} />
            <Line label="Total" amount={money(total)} strong className="pt-1.5 text-lg" />
          </dl>
        </div>

        <dl className="space-y-1.5 rounded-xl bg-sunken/70 p-3 text-[15px]">
          <Line label="Due now" amount={money(payNow)} strong />
          {payNow < total ? (
            <Line
              label="Due at the property"
              amount={money(total - payNow)}
              className="text-ink-soft"
            />
          ) : null}
        </dl>

        {discounted && promo ? (
          <p className="flex items-center gap-2 text-sm font-medium text-success-700">
            <Tag className="size-4 shrink-0" aria-hidden />
            {promo.code}: {promo.label}
          </p>
        ) : null}

        <p className="flex items-start gap-2 text-[15px] text-ink-soft">
          <CancelIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {plan.cancellation.text}
        </p>
      </div>
    </section>
  );
}

export default async function BookPage({ params, searchParams }: Props) {
  const [{ property: slug }, query] = await Promise.all([params, searchParams]);
  const property = await forPublicPage(getProperty(slug));
  if (property === BUSY) return <TooManyTries browsing />;
  if (property === NOT_SET_UP) notFound();
  if (!property) notFound();

  const path = propertyPath(property.code);
  const input = readStay(query);
  const roomTypeId = readId(query, 'roomTypeId');
  const ratePlanId = readId(query, 'ratePlanId');
  const results = (notice?: string) =>
    hasDates(input) ? `${path}?${stayQuery(input, { notice })}` : path;
  if (!hasDates(input) || !roomTypeId || !ratePlanId) redirect(results());

  // The prices are worked out again now, not taken from the address.
  const stay = await searchStay(property.code, {
    ...input,
    promo: input.promo || undefined,
  }).catch((err: unknown) => {
    // Dates that cannot be searched any more: the property's page says why.
    if (err instanceof ApiError && err.status === 400) return null;
    throw err;
  });
  if (!stay) redirect(results());

  const offer = stay.offers.find((candidate) => candidate.roomType.id === roomTypeId);
  const plan = offer?.plans.find((candidate) => candidate.ratePlanId === ratePlanId);
  if (!offer || !plan) redirect(results('changed'));
  if (offer.available < 1 || !plan.bookable) redirect(results('gone'));

  const wanted = readRooms(query);
  const rooms = Math.min(wanted, offer.available, MAX_ROOMS);
  const organisationName = (await getOrganisationName()) ?? property.name;

  return (
    <div style={brandStyle(property.brandColor)}>
      <div className={cn(pageClass, 'pt-4 sm:pt-6')}>
        <Link
          href={results()}
          className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-[15px] font-medium text-ink-soft hover:bg-sunken hover:text-ink"
        >
          <LinkPending icon={<ArrowLeft className="size-4" aria-hidden />} />
          Back to rooms and prices
        </Link>
        <h1 className="mt-2 font-display text-3xl leading-tight sm:text-4xl">
          Complete your booking
        </h1>

        {rooms < wanted ? (
          <Notice tone="warning" role="status" className="mt-4">
            Only {count(offer.available, 'room')} of this kind{' '}
            {offer.available === 1 ? 'is' : 'are'} left for these dates, so this booking is now for{' '}
            {count(rooms, 'room')}.
          </Notice>
        ) : null}

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-10">
          <div className="lg:sticky lg:top-6 lg:order-2">
            <Summary
              property={property}
              stay={stay}
              offer={offer}
              plan={plan}
              rooms={rooms}
              promo={stay.promo}
            />
          </div>
          <div className="lg:order-1">
            <BookingForm
              org={organisationSlug()}
              organisationName={organisationName}
              propertyCode={property.code}
              checkIn={stay.checkIn}
              checkOut={stay.checkOut}
              adultsPerRoom={stay.adults}
              childrenPerRoom={stay.children}
              roomTypeId={roomTypeId}
              ratePlanId={ratePlanId}
              rooms={rooms}
              promoCode={plan.discount > 0 ? stay.promo?.code : undefined}
              currency={property.currency}
              total={plan.total * rooms}
              payNow={plan.payNow * rooms}
              checkInTime={property.checkInTime}
              countries={countriesWithFirst(property.country)}
              resultsHref={results()}
              goneHref={results('gone')}
              // What this booking costs to cancel and when it is paid come first. The property's
              // own terms can be long, and the box they are shown in scrolls: what is cut off
              // on a small screen must be the long text, not these two sentences.
              terms={
                <>
                  <p>{plan.cancellation.text}</p>
                  <p>
                    {plan.payNow >= plan.total
                      ? 'The full price is paid when you book.'
                      : plan.payNow > 0
                        ? `${formatMoney(plan.payNow * rooms, property.currency)} is paid when you book. The rest is paid at the property.`
                        : 'Nothing is paid when you book. The full price is paid at the property.'}
                  </p>
                  {property.terms ? <p className="whitespace-pre-line">{property.terms}</p> : null}
                </>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
