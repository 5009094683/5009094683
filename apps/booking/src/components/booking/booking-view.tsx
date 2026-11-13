'use client';

import {
  ArrowRight,
  Ban,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Clock,
  Copy,
  Heart,
  Hourglass,
  KeyRound,
  LoaderCircle,
  type LucideIcon,
  MapPin,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ContactLinks } from '@/components/contact-links';
import { Button, ButtonLink, buttonClass } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { errorMessage } from '@/lib/api-error';
import { api, bookingPath } from '@/lib/browser-api';
import { cn } from '@/lib/cn';
import {
  dateIn,
  formatDate,
  formatInstantDate,
  formatInstantTime,
  formatLocalTime,
} from '@/lib/dates';
import { clearDraft, rememberedForm } from '@/lib/draft';
import { count, formatMoney, mealPlanLabel, moneyColumn, party, sentence } from '@/lib/format';
import { formatTimeLeft, useClockOffset, useTimeLeft } from '@/lib/hooks';
import { askAboutPayment, forgetPaymentReturn } from '@/lib/payment-return';
import { propertyPath, stayQuery } from '@/lib/stay';
import type { Booking, Cancelled } from '@/lib/types';

export interface BookingViewProps {
  token: string;
  booking: Booking;
  /** The guest has just come back from the payment page. */
  justPaid: boolean;
  /** The server's clock when the page was made, in milliseconds. */
  serverTime: number;
  /**
   * The property has a page on this website. A booking link works for every booking,
   * also one at a property that does not sell here and has no page to link to.
   */
  propertyOnWebsite: boolean;
}

/** What the page is saying about the booking: its status, and where a payment stands. */
type State =
  | 'checking'
  | 'waiting'
  | 'unpaid'
  | 'confirmed'
  | 'in_house'
  | 'checked_out'
  | 'cancelled'
  | 'no_show';

const LOOKS: Record<State, { icon: LucideIcon; tone: string }> = {
  checking: { icon: LoaderCircle, tone: 'bg-info-50 text-info-700' },
  waiting: { icon: Hourglass, tone: 'bg-warning-50 text-warning-700' },
  unpaid: { icon: CircleAlert, tone: 'bg-warning-50 text-warning-700' },
  confirmed: { icon: CircleCheck, tone: 'bg-success-50 text-success-700' },
  in_house: { icon: KeyRound, tone: 'bg-success-50 text-success-700' },
  checked_out: { icon: Heart, tone: 'bg-success-50 text-success-700' },
  cancelled: { icon: Ban, tone: 'bg-sunken text-ink-soft' },
  no_show: { icon: Ban, tone: 'bg-sunken text-ink-soft' },
};

const CARD = 'rounded-2xl border border-line/70 bg-surface shadow-card';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Total({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="mt-1 flex justify-between gap-6 border-t border-line pt-3 text-base font-semibold">
      <dt>{label}</dt>
      <dd className="tabular-nums">{amount}</dd>
    </div>
  );
}

function Reference({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const text = useRef<HTMLSpanElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      // No clipboard here (an old browser, or a page not served securely): select the
      // reference instead, so that the guest can copy it themselves.
      if (text.current) window.getSelection()?.selectAllChildren(text.current);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div>
        <p className="text-sm text-ink-soft">Booking reference</p>
        <p className="text-3xl leading-tight font-semibold tracking-wider">
          <span ref={text} className="select-all">
            {code}
          </span>
        </p>
      </div>
      <Button
        onClick={copy}
        aria-label={copied ? 'Booking reference copied' : 'Copy booking reference'}
        icon={
          copied ? (
            <ClipboardCheck className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )
        }
      >
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}

/**
 * What the question about cancelling says under its two amounts. A charge can be more than the
 * guest has paid: at a property where nothing is paid when booking, or where the charge carries
 * a higher tax than the stay did. What is then left to pay must be said before, not after.
 * `leftToPay` is that amount as the guest reads it, or null when the charge is covered.
 */
function cancelNote(paid: number, refund: number, leftToPay: string | null): string {
  if (paid <= 0) {
    return leftToPay
      ? 'You have not paid anything for this booking yet, so the charge is still to be paid to the property.'
      : 'You have not paid anything for this booking yet.';
  }
  if (refund > 0) return 'The money goes back the way you paid. It can take a few days to arrive.';
  return leftToPay
    ? `What you have paid is kept, and ${leftToPay} more is still to be paid to the property.`
    : 'What you have paid is kept as the cancellation charge.';
}

/** Rooms booked alike are shown as one line with a count. */
function groupRooms(rooms: Booking['rooms']): { room: Booking['rooms'][number]; times: number }[] {
  const groups = new Map<string, { room: Booking['rooms'][number]; times: number }>();
  for (const room of rooms) {
    const key = JSON.stringify([
      room.roomType,
      room.ratePlan,
      room.mealPlan,
      room.adults,
      room.children,
      room.status,
      room.amount,
    ]);
    const group = groups.get(key);
    if (group) group.times += 1;
    else groups.set(key, { room, times: 1 });
  }
  return [...groups.values()];
}

export function BookingView({
  token,
  booking: initial,
  justPaid,
  serverTime,
  propertyOnWebsite,
}: BookingViewProps) {
  const [booking, setBooking] = useState(initial);
  const [checking, setChecking] = useState(justPaid);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState<Cancelled | null>(null);
  const [startingAgain, setStartingAgain] = useState(false);
  const asked = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // When the booking is cancelled while this page is open, the button that was pressed goes
  // away with its section at the foot of the page. The outcome is at the top: go there.
  const wasCancelled = useRef(booking.status === 'cancelled');
  useEffect(() => {
    if (booking.status !== 'cancelled' || wasCancelled.current) return;
    wasCancelled.current = true;
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [booking.status]);

  const { property, pendingPayment } = booking;
  const money = (amount: number) => formatMoney(amount, booking.currency);
  // The API counts as paid what is left after refunds. A guest counts what left their account.
  const paidIn = booking.paid + booking.refunded;
  const priceLine = moneyColumn(booking.currency, [
    booking.discount,
    booking.total,
    paidIn,
    booking.refunded,
    booking.balance,
    pendingPayment?.amount ?? 0,
  ]);
  const clockOffset = useClockOffset(serverTime);
  const timeLeft = useTimeLeft(pendingPayment?.expiresAt, clockOffset);
  const payable = pendingPayment !== null && timeLeft !== 0;

  const reload = useCallback(async (): Promise<Booking | null> => {
    try {
      const latest = await api<Booking>(bookingPath(token));
      setBooking(latest);
      return latest;
    } catch {
      // What is on the page stays; the guest can reload it.
      return null;
    }
  }, [token]);

  // Back from the payment page: ask the payment gateway what happened.
  useEffect(() => {
    if (!justPaid || asked.current) return;
    asked.current = true;
    const page = window.location.pathname;
    askAboutPayment(
      () => api<Booking>(bookingPath(token, '/sync'), { method: 'POST' }),
      (answer) => answer.status === 'tentative' && answer.pendingPayment !== null,
    )
      .then(
        (answer) => {
          setBooking(answer);
          // A reload should show the booking, not ask again. When the question could not be
          // put, `paid` stays in the address: reloading is how the guest asks once more.
          forgetPaymentReturn(page);
        },
        (err: unknown) => setCheckFailed(errorMessage(err)),
      )
      .finally(() => setChecking(false));
  }, [justPaid, token]);

  // The time to pay has run out: see what became of the booking.
  useEffect(() => {
    if (timeLeft !== 0) return;
    const timer = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(timer);
  }, [timeLeft, reload]);

  useEffect(() => {
    if (booking.status === 'confirmed') clearDraft();
  }, [booking.status]);

  const state: State = checking
    ? 'checking'
    : booking.status === 'tentative'
      ? payable
        ? 'waiting'
        : 'unpaid'
      : booking.status;

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await api<Cancelled>(bookingPath(token, '/cancel'), { method: 'POST' });
      setCancelled(result);
      setBooking(result.booking);
      setAsking(false);
    } catch (err) {
      setCancelError(errorMessage(err));
      const latest = await reload();
      // Cancelled somewhere else meanwhile, or the stay has started: there is nothing left to
      // ask, and the page behind the question now says what happened.
      if (latest && !latest.cancellation.allowed) setAsking(false);
    } finally {
      setCancelling(false);
    }
  };

  // A booking that was not paid for cannot be paid for later. Its hold is given up, so that
  // the same room is free to book again, and the guest goes back to where they booked.
  const startAgain = async () => {
    if (startingAgain) return;
    setStartingAgain(true);
    try {
      await api<Cancelled>(bookingPath(token, '/cancel'), { method: 'POST' });
    } catch {
      // Already released, most likely. Booking again does not depend on it.
    }
    const path = propertyPath(property.code);
    const search =
      booking.checkIn >= dateIn(property.timezone)
        ? `${path}?${stayQuery({
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            adults: booking.rooms[0]?.adults ?? 2,
            children: booking.rooms[0]?.children ?? 0,
            promo: booking.promoCode ?? '',
          })}`
        : path;
    window.location.assign(rememberedForm(token) ?? search);
  };

  // The moment the hold ends, as this device's own clock will show it.
  const heldUntil =
    pendingPayment && clockOffset !== null
      ? ` until ${formatLocalTime(new Date(pendingPayment.expiresAt).getTime() - clockOffset)}`
      : '';
  const headline: Record<State, string> = {
    checking: 'Checking your payment',
    waiting: `Waiting for payment: ${booking.rooms.length === 1 ? 'room' : 'rooms'} held${heldUntil}`,
    unpaid: 'This booking is not confirmed',
    confirmed: 'Your booking is confirmed',
    in_house: 'You are checked in',
    checked_out: 'Thank you for staying',
    cancelled: 'This booking is cancelled',
    no_show: 'This booking was closed',
  };

  const cameBack = justPaid && !checkFailed;
  const detail: Record<State, ReactNode> = {
    checking: 'This takes a moment. Please keep this page open.',
    waiting: (
      <>
        {cameBack
          ? 'We have not received your payment. If you have just paid, wait a minute and reload this page before you pay again. '
          : null}
        Your booking is confirmed once you have paid {money(pendingPayment?.amount ?? 0)}.
      </>
    ),
    unpaid: (
      <>
        {cameBack ? 'Your payment was not completed. ' : null}
        We have not received a payment for this booking, and it can no longer be paid for. To stay
        with us on these dates, please book again.
      </>
    ),
    confirmed: (
      <>
        {cameBack ? 'Thank you, we have received your payment. ' : null}
        We look forward to welcoming you on {formatDate(booking.checkIn)}.
      </>
    ),
    in_house: `We hope you are enjoying your stay. Check-out is by ${property.checkOutTime} on ${formatDate(booking.checkOut)}.`,
    checked_out: 'We hope you enjoyed your stay, and that we see you again.',
    cancelled: cancelled ? (
      <>
        {cancelled.charge > 0
          ? `The cancellation charge is ${money(cancelled.charge)}. `
          : 'There is no cancellation charge. '}
        {cancelled.charge > 0 && booking.balance > 0
          ? booking.balance < cancelled.charge
            ? `${money(booking.balance)} of it is still to be paid to the property. `
            : 'It is still to be paid to the property. '
          : null}
        {cancelled.refunded > 0
          ? `${money(cancelled.refunded)} is on its way back to you, the way you paid. It can take a few days to arrive. `
          : null}
        {cancelled.refundPending > 0
          ? `The property will return ${money(cancelled.refundPending)} to you and has been told to.`
          : null}
      </>
    ) : (
      'Nothing is held for you any more.'
    ),
    no_show: `Nobody arrived on ${formatDate(booking.checkIn)}. If that is not right, please contact the property.`,
  };

  const { icon: StateIcon, tone } = LOOKS[state];
  const guests = booking.rooms.length > 0 ? party(booking.adults, booking.children) : null;
  const terms = [...new Set(booking.rooms.map((room) => room.cancellation.text))];
  const active = state === 'waiting' || state === 'confirmed' || state === 'in_house';
  const { onlineCheckin, cancellation } = booking;
  const chargeLeftToPay = cancellation.charge - Math.max(0, booking.paid);
  const bookingHref = `/booking/${encodeURIComponent(token)}`;
  const checkInHref = `${bookingHref}/check-in`;
  const ended = booking.status === 'cancelled' || booking.status === 'no_show';
  // A stay paid for somewhere else, such as on a booking site, comes with a total of nothing.
  // That is not its price, and no amounts are shown for it.
  const priced = ended || booking.total > 0 || booking.paid > 0;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 sm:pt-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-10">
        <div className="space-y-6">
          <section className={cn(CARD, 'p-5 sm:p-7')}>
            <div role="status" aria-live="polite" className="flex items-start gap-4">
              <span
                className={cn(
                  'flex size-12 shrink-0 items-center justify-center rounded-full',
                  tone,
                )}
              >
                <StateIcon
                  className={cn('size-6', state === 'checking' && 'animate-spin')}
                  aria-hidden
                />
              </span>
              <div className="min-w-0 space-y-1.5">
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="font-display text-[1.7rem] leading-tight outline-none sm:text-4xl"
                >
                  {headline[state]}
                </h1>
                <p className="text-base text-ink-soft">{detail[state]}</p>
              </div>
            </div>
            {/* Outside the announced part above: a clock read out every minute helps nobody. */}
            {state === 'waiting' && timeLeft !== null && timeLeft > 0 ? (
              <p className="mt-3 flex items-center gap-2 pl-16 text-[15px] font-medium text-warning-700">
                <Clock className="size-4 shrink-0" aria-hidden />
                You have {formatTimeLeft(timeLeft)} left to pay.
              </p>
            ) : null}
            {/* What a script would have done or shown, for a browser that runs none. */}
            {justPaid ? (
              <noscript>
                <p className="mt-3 pl-16 text-[15px]">
                  This page needs scripts to check your payment, and your browser has them switched
                  off.{' '}
                  <a href={bookingHref} className="font-medium underline underline-offset-4">
                    See your booking as it is now
                  </a>
                  .
                </p>
              </noscript>
            ) : state === 'waiting' && pendingPayment ? (
              <noscript>
                <p className="mt-3 pl-16 text-[15px] font-medium text-warning-700">
                  Held until {formatInstantTime(pendingPayment.expiresAt, property.timezone)}, by
                  the clock at {property.name}.
                </p>
              </noscript>
            ) : null}

            {checkFailed ? (
              <Notice tone="warning" role="alert" className="mt-5" title="We could not check">
                {checkFailed} Reload this page to check again.
              </Notice>
            ) : null}

            {state === 'waiting' && pendingPayment ? (
              <div className="mt-5 hidden lg:block">
                <ButtonLink href={pendingPayment.checkoutUrl} external variant="primary" size="lg">
                  Pay now
                  <ArrowRight className="size-4" aria-hidden />
                </ButtonLink>
              </div>
            ) : null}

            {state === 'unpaid' ? (
              <div className="mt-5">
                <Button
                  variant="primary"
                  size="lg"
                  loading={startingAgain}
                  disabled={startingAgain}
                  onClick={startAgain}
                  className="w-full sm:w-auto"
                >
                  Book again
                </Button>
              </div>
            ) : null}

            {propertyOnWebsite &&
            (state === 'cancelled' || state === 'no_show' || state === 'checked_out') ? (
              <div className="mt-5">
                <ButtonLink href={propertyPath(property.code)} className="w-full sm:w-auto">
                  {state === 'checked_out' ? 'Book another stay' : 'Book a new stay'}
                </ButtonLink>
              </div>
            ) : null}

            {state === 'confirmed' && onlineCheckin.completedAt ? (
              <p className="mt-5 flex flex-wrap items-center gap-x-4 rounded-xl bg-success-50 px-4 py-1.5 text-[15px]">
                <span className="flex items-center gap-2 py-1.5 font-medium text-success-700">
                  <CircleCheck className="size-4 shrink-0" aria-hidden />
                  Checked in online on{' '}
                  {formatInstantDate(onlineCheckin.completedAt, property.timezone)}
                </span>
                <Link
                  href={checkInHref}
                  className="inline-flex min-h-11 items-center font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  Review your details
                </Link>
              </p>
            ) : state === 'confirmed' && onlineCheckin.available ? (
              <div className="mt-5 flex flex-col gap-3 rounded-xl bg-sunken/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[15px] text-ink-soft">
                  <span className="font-medium text-ink">Save time when you arrive.</span> Send us
                  your details now and collect your key sooner.
                </p>
                <ButtonLink href={checkInHref} variant="primary" className="shrink-0">
                  Check in online
                </ButtonLink>
              </div>
            ) : null}

            <div className="mt-6 border-t border-line pt-5">
              <Reference code={booking.code} />
            </div>
          </section>

          {state === 'confirmed' && pendingPayment && payable ? (
            <section className={cn(CARD, 'flex flex-col gap-3 p-5 sm:flex-row sm:items-center')}>
              <p className="flex-1 text-[15px]">
                <span className="font-semibold">
                  {property.name} has asked you for a payment of {money(pendingPayment.amount)}.
                </span>
              </p>
              <ButtonLink
                href={`/booking/${encodeURIComponent(token)}/pay/${encodeURIComponent(pendingPayment.orderId)}`}
                variant="primary"
                className="shrink-0"
              >
                See and pay
              </ButtonLink>
            </section>
          ) : null}

          <section aria-labelledby="stay-heading" className={cn(CARD, 'p-5 sm:p-7')}>
            <h2 id="stay-heading" className="font-display text-2xl leading-tight">
              Your stay
            </h2>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-[15px]">
              <div>
                <dt className="text-sm text-ink-soft">Arrival</dt>
                <dd className="font-medium">{formatDate(booking.checkIn)}</dd>
                <dd className="text-sm text-ink-soft">from {property.checkInTime}</dd>
              </div>
              <div>
                <dt className="text-sm text-ink-soft">Departure</dt>
                <dd className="font-medium">{formatDate(booking.checkOut)}</dd>
                <dd className="text-sm text-ink-soft">by {property.checkOutTime}</dd>
              </div>
            </dl>
            <dl className="mt-4 divide-y divide-line border-t border-line text-[15px]">
              <Row label="Booked for">{booking.guestName}</Row>
              <Row label="Length of stay">{count(booking.nights, 'night')}</Row>
              {guests ? <Row label="Guests">{guests}</Row> : null}
              {booking.arrivalTime ? (
                <Row label="Expected arrival">{booking.arrivalTime}</Row>
              ) : null}
            </dl>

            <h3 className="mt-6 text-base font-semibold">
              {booking.rooms.length === 1 ? 'Room' : 'Rooms'}
            </h3>
            <ul className="mt-2 divide-y divide-line border-y border-line text-[15px]">
              {groupRooms(booking.rooms).map(({ room, times }, index) => {
                const meal = mealPlanLabel(room.mealPlan);
                return (
                  <li key={index} className="flex justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {times} x {room.roomType}
                        {room.status === 'cancelled' ? (
                          <span className="ml-2 rounded-full bg-sunken px-2 py-0.5 text-sm font-medium text-ink-soft">
                            Cancelled
                          </span>
                        ) : null}
                      </p>
                      <p className="text-ink-soft">
                        {[room.ratePlan, meal].filter(Boolean).join(', ')}
                      </p>
                      <p className="text-ink-soft">
                        {party(room.adults, room.children)}
                        {times > 1 ? ' in each' : ''}
                      </p>
                    </div>
                    {priced ? (
                      <p className="shrink-0 text-right text-ink-soft tabular-nums">
                        {money(room.amount * times)}
                        <span className="block text-sm text-ink-faint">before taxes</span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {booking.specialRequests ? (
              <div className="mt-5">
                <h3 className="text-base font-semibold">Your requests</h3>
                <p className="mt-1 text-[15px] whitespace-pre-line text-ink-soft">
                  {booking.specialRequests}
                </p>
              </div>
            ) : null}
          </section>

          {booking.arrivalInstructions ? (
            <section aria-labelledby="arrival-heading" className={cn(CARD, 'p-5 sm:p-7')}>
              <h2 id="arrival-heading" className="font-display text-2xl leading-tight">
                When you arrive
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-line text-ink-soft">
                {booking.arrivalInstructions}
              </p>
            </section>
          ) : null}
        </div>

        <aside className="space-y-6 lg:sticky lg:top-6 lg:row-span-2">
          {priced ? (
            <section aria-labelledby="price-heading" className={cn(CARD, 'p-5 sm:p-6')}>
              <h2 id="price-heading" className="font-display text-2xl leading-tight">
                Price
              </h2>
              <dl className="mt-3 text-[15px]">
                {booking.discount > 0 && !ended ? (
                  <Row label={booking.promoCode ? `Discount (${booking.promoCode})` : 'Discount'}>
                    <span className="text-success-700 tabular-nums">
                      -{priceLine(booking.discount)}
                    </span>
                  </Row>
                ) : null}
                <Row
                  label={
                    booking.status === 'cancelled'
                      ? 'Cancellation charge'
                      : booking.status === 'no_show'
                        ? 'Charged'
                        : 'Total, taxes included'
                  }
                >
                  <span className="tabular-nums">{priceLine(booking.total)}</span>
                </Row>
                <Row label="Paid">
                  <span className="tabular-nums">{priceLine(paidIn)}</span>
                </Row>
                {booking.refunded > 0 ? (
                  <Row label="Returned to you">
                    <span className="tabular-nums">{priceLine(booking.refunded)}</span>
                  </Row>
                ) : null}
                {booking.status === 'tentative' ? (
                  payable && pendingPayment ? (
                    <>
                      <Total label="To pay now" amount={priceLine(pendingPayment.amount)} />
                      {booking.balance > pendingPayment.amount ? (
                        <Row label="Then, at the property">
                          <span className="tabular-nums">
                            {priceLine(booking.balance - pendingPayment.amount)}
                          </span>
                        </Row>
                      ) : null}
                    </>
                  ) : null
                ) : booking.balance < 0 ? (
                  // More was paid than the stay comes to. Only a cancelled booking is sure to
                  // get the difference back: the property is told to return it. After a stay,
                  // or when nobody arrived, what becomes of it is the property's to say.
                  <Total
                    label={
                      booking.status === 'cancelled'
                        ? 'To be returned to you'
                        : booking.status === 'no_show'
                          ? 'Paid above the charge'
                          : 'Paid above the total'
                    }
                    amount={priceLine(-booking.balance)}
                  />
                ) : booking.balance === 0 ? (
                  <Total label={ended ? 'To pay' : 'Still to pay'} amount="Nothing" />
                ) : (
                  <Total
                    label={
                      booking.status === 'confirmed' || booking.status === 'in_house'
                        ? 'To pay at the property'
                        : 'Still to pay'
                    }
                    amount={priceLine(booking.balance)}
                  />
                )}
              </dl>
            </section>
          ) : null}

          <section aria-labelledby="property-heading" className={cn(CARD, 'p-5 sm:p-6')}>
            <h2 id="property-heading" className="font-display text-2xl leading-tight">
              {property.name}
            </h2>
            {property.address ? (
              <p className="mt-3 flex items-start gap-2.5 text-[15px]">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                <span>{property.address}</span>
              </p>
            ) : property.city ? (
              <p className="mt-3 flex items-start gap-2.5 text-[15px]">
                <MapPin className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                <span>{[property.city, property.state].filter(Boolean).join(', ')}</span>
              </p>
            ) : null}
            <ContactLinks phone={property.phone} email={property.email} className="mt-2" />
            {propertyOnWebsite ? (
              <p className="mt-3 border-t border-line pt-3">
                <Link
                  href={propertyPath(property.code)}
                  className="inline-flex min-h-11 items-center text-[15px] font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  About {property.name}
                </Link>
              </p>
            ) : null}
          </section>
        </aside>

        {active ? (
          <section aria-labelledby="cancel-heading" className={cn(CARD, 'p-5 sm:p-7')}>
            <h2 id="cancel-heading" className="font-display text-2xl leading-tight">
              Changing your plans
            </h2>
            {/* Once the stay has started, what cancelling would have cost says nothing useful. */}
            {state === 'in_house' ? null : (
              <ul className="mt-3 space-y-1.5 text-[15px] text-ink-soft">
                {terms.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
            {cancellation.allowed ? (
              <>
                <Button
                  className="mt-4 w-full text-danger-700 sm:w-auto"
                  onClick={() => {
                    setCancelError(null);
                    setAsking(true);
                  }}
                >
                  Cancel booking
                </Button>
                <noscript>
                  <p className="mt-3 text-[15px]">
                    Cancelling here needs scripts, and your browser has them switched off. To
                    cancel, switch them on and load the page again, or contact {property.name}.
                  </p>
                </noscript>
              </>
            ) : cancellation.reason ? (
              <p className="mt-3 text-[15px] font-medium">{sentence(cancellation.reason)}</p>
            ) : null}
          </section>
        ) : null}
      </div>

      {state === 'waiting' && pendingPayment ? (
        // On a phone the way to pay stays at the bottom of the screen, in reach of a thumb.
        <div className="sticky bottom-0 z-20 -mx-4 mt-6 flex items-center gap-4 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-6px_16px_-8px_rgb(40_30_16/0.18)] sm:-mx-6 sm:px-6 lg:hidden">
          <div className="min-w-0">
            <p className="text-sm text-ink-soft">To pay now</p>
            <p className="text-lg leading-tight font-semibold tabular-nums">
              {money(pendingPayment.amount)}
            </p>
          </div>
          <a
            href={pendingPayment.checkoutUrl}
            rel="noreferrer"
            className={cn(buttonClass('primary', 'lg'), 'flex-1')}
          >
            Pay now
            <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      ) : null}

      <Dialog
        open={asking}
        onClose={() => {
          if (!cancelling) setAsking(false);
        }}
        title="Cancel this booking?"
        actions={
          <>
            <Button onClick={() => setAsking(false)} disabled={cancelling}>
              Keep my booking
            </Button>
            <Button variant="danger" loading={cancelling} disabled={cancelling} onClick={cancel}>
              Cancel booking
            </Button>
          </>
        }
      >
        <dl className="divide-y divide-line rounded-xl border border-line text-ink">
          <div className="flex justify-between gap-6 px-4 py-3">
            <dt>Cancelling now costs</dt>
            <dd className="font-semibold tabular-nums">
              {cancellation.charge > 0 ? money(cancellation.charge) : 'Nothing'}
            </dd>
          </div>
          <div className="flex justify-between gap-6 px-4 py-3">
            <dt>You get back</dt>
            <dd className="font-semibold tabular-nums">
              {cancellation.refund > 0 ? money(cancellation.refund) : 'Nothing'}
            </dd>
          </div>
        </dl>
        <p>
          {cancelNote(
            booking.paid,
            cancellation.refund,
            chargeLeftToPay > 0 ? money(chargeLeftToPay) : null,
          )}{' '}
          A cancelled booking cannot be brought back.
        </p>
        {cancelError ? (
          <Notice tone="danger" role="alert" title="This booking was not cancelled">
            {cancelError}
          </Notice>
        ) : null}
      </Dialog>
    </div>
  );
}
