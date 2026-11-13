import { Ban, CalendarCheck, CircleSlash, Info, Tag, Users, Utensils } from 'lucide-react';
import type { ReactNode } from 'react';
import { AmenityList } from '@/components/amenities';
import { Photo } from '@/components/photo';
import { cn } from '@/lib/cn';
import { count, formatMoney, mealPlanLabel } from '@/lib/format';
import { usablePhotos } from '@/lib/photos';
import { MAX_ROOMS } from '@/lib/stay';
import type { Offer, Plan, Promo, RoomType } from '@/lib/types';
import { RateAction } from './rate-selection';

/** Who a room sleeps: "Sleeps up to 4: at most 3 adults and 2 children". */
export function occupancyText(room: RoomType): string {
  if (room.maxChildren === 0) return `Sleeps up to ${count(room.maxAdults, 'adult')}`;
  return (
    `Sleeps up to ${room.maxOccupancy}: at most ${count(room.maxAdults, 'adult')} ` +
    `and ${count(room.maxChildren, 'child', 'children')}`
  );
}

/** Whether a party fits in one room of this kind, by the rule the search itself uses. */
export function fits(room: RoomType, adults: number, children: number): boolean {
  return (
    adults <= room.maxAdults &&
    children <= room.maxChildren &&
    adults + children <= room.maxOccupancy
  );
}

function Pill({ tone, children }: { tone: 'warning' | 'muted' | 'success'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium whitespace-nowrap',
        tone === 'warning' && 'bg-warning-50 text-warning-700',
        tone === 'muted' && 'bg-sunken text-ink-soft',
        tone === 'success' && 'bg-success-50 text-success-700',
      )}
    >
      {children}
    </span>
  );
}

export interface RoomCardProps {
  room: RoomType;
  /** Shown beside the name: how many are left, or that none are. */
  badge?: ReactNode;
  /** The rates, or what stands in for them. */
  children?: ReactNode;
}

/** A room with its photo, who it sleeps and what is in it; the rates go underneath. */
export function RoomCard({ room, badge, children }: RoomCardProps) {
  const photos = usablePhotos(room.photos);
  return (
    <article className="overflow-hidden rounded-2xl border border-line/70 bg-surface shadow-card">
      <div className="flex flex-col sm:flex-row">
        <div
          className={cn(
            'relative sm:aspect-[4/3] sm:w-56 sm:shrink-0 lg:w-64',
            // Without a photo there is nothing to look at closely: a slimmer band on a phone.
            photos.length > 0 ? 'aspect-[16/9]' : 'aspect-[3/1]',
          )}
        >
          <Photo src={photos[0]} alt={`Photo of ${room.name}`} name={room.name} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <h3 className="font-display text-xl leading-tight sm:text-2xl">{room.name}</h3>
            {badge}
          </div>
          <p className="flex items-start gap-2 text-[15px] text-ink-soft">
            <Users className="mt-0.5 size-4 shrink-0" aria-hidden />
            {occupancyText(room)}
          </p>
          {room.description ? (
            <p className="text-[15px] whitespace-pre-line text-ink-soft">{room.description}</p>
          ) : null}
          <AmenityList items={room.amenities} compact className="pt-1" />
        </div>
      </div>
      {children ? <div className="border-t border-line">{children}</div> : null}
    </article>
  );
}

function PriceLine({ label, amount, strong }: { label: string; amount: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-6', strong && 'font-semibold text-ink')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{amount}</dd>
    </div>
  );
}

interface RateRowProps {
  room: RoomType;
  plan: Plan;
  available: number;
  nights: number;
  currency: string;
  promo: Promo | null;
  /** The booking form for this stay, without the room, the rate and the number of rooms. */
  bookHref: string;
}

function RateRow({ room, plan, available, nights, currency, promo, bookHref }: RateRowProps) {
  const money = (amount: number) => formatMoney(amount, currency);
  const meal = mealPlanLabel(plan.mealPlan);
  const before = Math.round(plan.subtotal / nights);
  const perNight = Math.round((plan.subtotal - plan.discount) / nights);
  const discounted = plan.discount > 0;
  const sameEveryNight = plan.nightly.every((night) => night.amount === plan.nightly[0]?.amount);
  const CancelIcon = plan.cancellation.nonRefundable ? CircleSlash : CalendarCheck;

  return (
    <li
      className={cn(
        'flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-start lg:justify-between lg:gap-8',
        !plan.bookable && 'bg-sunken/50',
      )}
    >
      <div className={cn('min-w-0 flex-1 space-y-2', !plan.bookable && 'text-ink-faint')}>
        <h4 className="text-base font-semibold">{plan.name}</h4>
        {plan.description ? <p className="text-[15px]">{plan.description}</p> : null}
        <ul className={cn('space-y-1.5 text-[15px]', plan.bookable && 'text-ink-soft')}>
          {meal ? (
            <li className="flex items-start gap-2">
              <Utensils className="mt-0.5 size-4 shrink-0" aria-hidden />
              {meal}
            </li>
          ) : null}
          <li className="flex items-start gap-2">
            <CancelIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {plan.cancellation.text}
          </li>
        </ul>
      </div>

      {plan.bookable ? (
        <div className="flex flex-col gap-3 lg:w-72 lg:shrink-0 lg:items-end lg:text-right">
          <div className="space-y-1">
            <p className="text-[15px] text-ink-soft">
              {discounted ? (
                <>
                  <span className="sr-only">Was </span>
                  <s className="mr-1.5 text-ink-faint">{money(before)}</s>
                  <span className="sr-only">, now </span>
                </>
              ) : null}
              <span className="text-2xl font-semibold text-ink tabular-nums">
                {money(perNight)}
              </span>{' '}
              per night
            </p>
            {discounted && promo ? (
              <p>
                <Pill tone="success">
                  <Tag className="size-3.5" aria-hidden />
                  {promo.code}: {promo.label}
                </Pill>
              </p>
            ) : null}
            <p className="text-[15px] text-ink">
              <span className="font-semibold tabular-nums">{money(plan.total)}</span> total, taxes
              included
            </p>
            {plan.payNow !== plan.total ? (
              <p className="text-[15px] text-ink-soft">
                {plan.payNow > 0
                  ? `Pay ${money(plan.payNow)} now, the rest at the property`
                  : 'Nothing to pay now. You pay at the property'}
              </p>
            ) : null}
            <details className="group text-sm text-ink-soft">
              <summary className="inline-flex min-h-11 items-center underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink lg:-my-1.5">
                <span className="group-open:hidden">Price details</span>
                <span className="hidden group-open:inline">Hide price details</span>
              </summary>
              <dl className="mb-1 w-full space-y-1 rounded-lg bg-sunken/70 p-3 text-left lg:w-72">
                <PriceLine
                  label={
                    sameEveryNight
                      ? `${count(nights, 'night')} x ${money(before)}`
                      : `${count(nights, 'night')}, ${money(before)} on average`
                  }
                  amount={money(plan.subtotal)}
                />
                {discounted ? (
                  <PriceLine
                    label={promo ? `Discount (${promo.code})` : 'Discount'}
                    amount={`-${money(plan.discount)}`}
                  />
                ) : null}
                <PriceLine label="Taxes" amount={money(plan.taxes)} />
                <PriceLine label="Total" amount={money(plan.total)} strong />
              </dl>
            </details>
          </div>
          <RateAction
            id={`${room.id}:${plan.ratePlanId}`}
            name={`${room.name}, ${plan.name}`}
            available={available}
            limit={MAX_ROOMS}
            total={plan.total}
            payNow={plan.payNow}
            currency={currency}
            href={`${bookHref}&roomTypeId=${room.id}&ratePlanId=${plan.ratePlanId}`}
          />
        </div>
      ) : (
        <p className="flex items-start gap-2 text-[15px] text-ink lg:w-72 lg:shrink-0">
          <Info className="mt-0.5 size-4 shrink-0 text-ink-soft" aria-hidden />
          <span>
            <span className="font-semibold">Not available for this stay.</span>{' '}
            {plan.reason ?? 'Try other dates.'}
          </span>
        </p>
      )}
    </li>
  );
}

export interface OfferCardProps {
  offer: Offer;
  nights: number;
  currency: string;
  promo: Promo | null;
  bookHref: string;
}

/** A room that fits the party, with what it costs for the stay on each of its rates. */
export function OfferCard({ offer, nights, currency, promo, bookHref }: OfferCardProps) {
  const { roomType: room, available, plans } = offer;
  const soldOut = available <= 0;
  const badge = soldOut ? (
    <Pill tone="muted">
      <Ban className="size-3.5" aria-hidden />
      Sold out for these dates
    </Pill>
  ) : available <= 3 ? (
    <Pill tone="warning">{available} left</Pill>
  ) : null;

  return (
    <RoomCard room={room} badge={badge}>
      {soldOut || plans.length === 0 ? null : (
        <ul className="divide-y divide-line">
          {plans.map((plan) => (
            <RateRow
              key={plan.ratePlanId}
              room={room}
              plan={plan}
              available={available}
              nights={nights}
              currency={currency}
              promo={promo}
              bookHref={bookHref}
            />
          ))}
        </ul>
      )}
    </RoomCard>
  );
}

/** Stands where a room's rates will be while they are looked up, taking about the same room. */
export function RatesSkeleton() {
  return (
    <ul className="divide-y divide-line" aria-hidden>
      {[0, 1].map((row) => (
        <li
          key={row}
          className="flex animate-pulse flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:justify-between"
        >
          <div className="flex-1 space-y-3">
            <div className="h-5 w-32 rounded bg-sunken" />
            <div className="h-4 w-40 rounded bg-sunken" />
            <div className="h-4 w-4/5 rounded bg-sunken" />
          </div>
          <div className="flex flex-col gap-3 lg:w-72 lg:items-end">
            <div className="h-8 w-44 rounded bg-sunken" />
            <div className="h-4 w-56 rounded bg-sunken" />
            <div className="h-4 w-24 rounded bg-sunken" />
            <div className="h-11 w-full rounded-lg bg-sunken sm:w-28" />
          </div>
        </li>
      ))}
    </ul>
  );
}
