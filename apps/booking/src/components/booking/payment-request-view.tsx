'use client';

import {
  ArrowRight,
  Ban,
  CircleAlert,
  CircleCheck,
  Link2Off,
  LoaderCircle,
  type LucideIcon,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ContactLinks } from '@/components/contact-links';
import { ButtonLink } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { errorMessage } from '@/lib/api-error';
import { api, bookingPath } from '@/lib/browser-api';
import { cn } from '@/lib/cn';
import { dateIn, formatDay, formatInstantTime, formatLocalMoment } from '@/lib/dates';
import { formatMoney } from '@/lib/format';
import { useClockOffset, useTimeLeft } from '@/lib/hooks';
import { askAboutPayment, forgetPaymentReturn } from '@/lib/payment-return';
import type { Booking, PaymentRequest } from '@/lib/types';

export interface PaymentRequestViewProps {
  token: string;
  orderId: string;
  request: PaymentRequest;
  phone: string | null;
  email: string | null;
  /** The property's time zone. */
  timezone: string;
  /** The guest has just come back from the payment page. */
  justPaid: boolean;
  /** The server's clock when the page was made, in milliseconds. */
  serverTime: number;
}

/** What the page is saying about the request. */
type State = 'checking' | 'open' | 'paid' | 'failed' | 'expired' | 'cancelled';

const LOOKS: Record<State, { icon: LucideIcon; tone: string }> = {
  checking: { icon: LoaderCircle, tone: 'bg-info-50 text-info-700' },
  open: { icon: Wallet, tone: 'bg-sunken text-ink-soft' },
  paid: { icon: CircleCheck, tone: 'bg-success-50 text-success-700' },
  failed: { icon: CircleAlert, tone: 'bg-warning-50 text-warning-700' },
  expired: { icon: Link2Off, tone: 'bg-sunken text-ink-soft' },
  cancelled: { icon: Ban, tone: 'bg-sunken text-ink-soft' },
};

export function PaymentRequestView({
  token,
  orderId,
  request: initial,
  phone,
  email,
  timezone,
  justPaid,
  serverTime,
}: PaymentRequestViewProps) {
  const [request, setRequest] = useState(initial);
  const [checking, setChecking] = useState(justPaid);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const asked = useRef(false);
  const clockOffset = useClockOffset(serverTime);
  const timeLeft = useTimeLeft(
    request.status === 'created' ? request.expiresAt : null,
    clockOffset,
  );

  // Back from the payment page: have the payment gateway asked what happened, then read the
  // request again.
  useEffect(() => {
    if (!justPaid || asked.current) return;
    asked.current = true;
    const page = window.location.pathname;
    const path = bookingPath(token, `/pay/${encodeURIComponent(orderId)}`);
    askAboutPayment(
      async () => {
        await api<Booking>(bookingPath(token, '/sync'), { method: 'POST' });
        return api<PaymentRequest>(path);
      },
      (answer) => answer.status === 'created',
    )
      .then(
        (answer) => {
          setRequest(answer);
          // When the question could not be put, `paid` stays in the address: reloading is
          // how the guest asks once more.
          forgetPaymentReturn(page);
        },
        (err: unknown) => setCheckFailed(errorMessage(err)),
      )
      .finally(() => setChecking(false));
  }, [justPaid, token, orderId]);

  const amount = formatMoney(request.amount, request.currency);
  const open = request.status === 'created' && request.checkoutUrl !== null && timeLeft !== 0;
  const paid = request.status === 'paid';
  const bookingHref = `/booking/${encodeURIComponent(token)}`;
  // A request still marked as open whose time has run out while this page was showing it
  // has expired, whatever the answer the page was made from said.
  const state: State = checking
    ? 'checking'
    : request.status === 'created'
      ? open
        ? 'open'
        : 'expired'
      : request.status;
  const { icon: Icon, tone } = LOOKS[state];

  const cameBack = justPaid && !checkFailed;
  const askAgain = `please contact ${request.propertyName}, who can send you a new link.`;
  const headline: Record<State, string> = {
    checking: 'Checking your payment',
    open: `${request.propertyName} asks you for a payment`,
    paid: 'Paid. Thank you.',
    failed: 'This payment did not go through',
    expired: 'This payment link has expired',
    cancelled: 'This payment was cancelled',
  };
  const detail: Record<State, string> = {
    checking: 'This takes a moment. Please keep this page open.',
    open: cameBack
      ? 'We have not received your payment. If you have just paid, wait a minute and reload this page before you pay again.'
      : `For ${request.guestName}, booking reference ${request.bookingCode}.`,
    paid: `${request.propertyName} has received your payment of ${amount}.`,
    failed: `Nothing has been paid, and this link cannot be used again. To pay, ${askAgain}`,
    expired: `Nothing has been paid through it. To pay, ${askAgain}`,
    cancelled: `Nothing has been paid, and this link cannot be used again. If you still mean to pay, ${askAgain}`,
  };

  // The moment the link stops working, as this device's own clock will show it.
  const validUntil =
    open && clockOffset !== null
      ? formatLocalMoment(new Date(request.expiresAt).getTime() - clockOffset)
      : null;

  return (
    <div className="mx-auto w-full max-w-xl px-4 pt-8 sm:px-6 sm:pt-14">
      <section className="rounded-2xl border border-line/70 bg-surface p-5 shadow-card sm:p-8">
        <div role="status" aria-live="polite" className="flex items-start gap-4">
          <span
            className={cn('flex size-12 shrink-0 items-center justify-center rounded-full', tone)}
          >
            <Icon className={cn('size-6', checking && 'animate-spin')} aria-hidden />
          </span>
          <div className="min-w-0 space-y-1.5">
            <h1 className="font-display text-[1.7rem] leading-tight sm:text-3xl">
              {headline[state]}
            </h1>
            <p className="text-base text-ink-soft">{detail[state]}</p>
          </div>
        </div>
        {/* What a script would have done, for a browser that runs none. */}
        {justPaid ? (
          <noscript>
            <p className="mt-3 pl-16 text-[15px]">
              This page needs scripts to check your payment, and your browser has them switched off.{' '}
              <a
                href={`${bookingHref}/pay/${encodeURIComponent(orderId)}`}
                className="font-medium underline underline-offset-4"
              >
                See this payment request as it is now
              </a>
              .
            </p>
          </noscript>
        ) : null}

        {checkFailed ? (
          <Notice tone="warning" role="alert" className="mt-5" title="We could not check">
            {checkFailed} Reload this page to check again.
          </Notice>
        ) : null}

        <dl className="mt-6 divide-y divide-line border-y border-line text-[15px]">
          <div className="flex justify-between gap-6 py-3">
            <dt className="text-ink-soft">Asked for by</dt>
            <dd className="text-right font-medium">{request.propertyName}</dd>
          </div>
          <div className="flex justify-between gap-6 py-3">
            <dt className="text-ink-soft">For</dt>
            <dd className="text-right font-medium">{request.description ?? 'Your stay'}</dd>
          </div>
          <div className="flex justify-between gap-6 py-3">
            <dt className="text-ink-soft">Booking reference</dt>
            <dd className="text-right font-medium tracking-wide">{request.bookingCode}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-6 py-3">
            <dt className="text-ink-soft">{paid ? 'Paid' : 'Amount'}</dt>
            <dd className="text-right text-2xl font-semibold tabular-nums">{amount}</dd>
          </div>
        </dl>

        {open && !checking && request.checkoutUrl ? (
          <div className="mt-6">
            <ButtonLink
              href={request.checkoutUrl}
              external
              variant="primary"
              size="lg"
              className="w-full"
            >
              Pay now
              <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
            <p className="mt-3 text-sm text-ink-soft">
              You pay on the next page.
              {validUntil ? ` This link works until ${validUntil}.` : ''}
            </p>
            <noscript>
              <p className="mt-1 text-sm text-ink-soft">
                This link works until {formatDay(dateIn(timezone, new Date(request.expiresAt)))},{' '}
                {formatInstantTime(request.expiresAt, timezone)}, by the clock at{' '}
                {request.propertyName}.
              </p>
            </noscript>
          </div>
        ) : null}

        {!open && !paid && !checking ? (
          <ContactLinks phone={phone} email={email} className="mt-4" />
        ) : null}

        <p className="mt-3">
          <Link
            href={bookingHref}
            className="inline-flex min-h-11 items-center text-[15px] font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          >
            See your booking
          </Link>
        </p>
      </section>
    </div>
  );
}
