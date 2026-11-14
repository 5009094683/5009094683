'use client';

import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextAreaField, TextField } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { ApiError, errorMessage, fieldIssues } from '@/lib/api-error';
import { api } from '@/lib/browser-api';
import type { Country } from '@/lib/countries';
import { attemptId, clearDraft, readDraft, rememberForm, writeDraft } from '@/lib/draft';
import { formatMoney } from '@/lib/format';
import { useEarlyInput } from '@/lib/hooks';
import type { Booked, BookingBody } from '@/lib/types';

export interface BookingFormProps {
  /** The chain's slug, when this site is set up for one of several. */
  org?: string;
  organisationName: string;
  propertyCode: string;
  checkIn: string;
  checkOut: string;
  adultsPerRoom: number;
  childrenPerRoom: number;
  roomTypeId: string;
  ratePlanId: string;
  rooms: number;
  /** Set only when the code takes something off this rate: the API refuses a code that does not. */
  promoCode?: string;
  currency: string;
  /** For all the rooms, with tax. */
  total: number;
  payNow: number;
  checkInTime: string;
  /** The property's terms and the rate's own, as the guest accepts them. */
  terms: ReactNode;
  countries: Country[];
  /** The results for this stay, to choose again. */
  resultsHref: string;
  /** The same, saying that the room has gone. */
  goneHref: string;
}

interface Values {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country: string;
  arrivalTime: string;
  specialRequests: string;
  acceptTerms: boolean;
  marketingConsent: boolean;
}

type Field = 'firstName' | 'lastName' | 'email' | 'phone' | 'acceptTerms';
type Errors = Partial<Record<Field, string>>;

const EMPTY: Values = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  country: '',
  arrivalTime: '',
  specialRequests: '',
  acceptTerms: false,
  marketingConsent: false,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(values: Values): Errors {
  const errors: Errors = {};
  if (!values.firstName.trim()) errors.firstName = 'Please give your first name.';
  if (!values.lastName.trim()) errors.lastName = 'Please give your last name.';
  if (!values.email.trim()) errors.email = 'Please give your email address.';
  else if (!EMAIL.test(values.email.trim())) {
    errors.email = 'This does not look like an email address. Please check it.';
  }
  if (!values.phone.trim()) errors.phone = 'Please give a phone number.';
  else if (values.phone.replace(/\D/g, '').length < 6) {
    errors.phone = 'This phone number looks too short. Please check it.';
  }
  if (!values.acceptTerms) errors.acceptTerms = 'Please accept the terms to book.';
  return errors;
}

const FIELD_ORDER: Field[] = ['firstName', 'lastName', 'email', 'phone', 'acceptTerms'];

/** Which field a refusal from the server is about, when it says. */
function fieldOf(err: unknown): Field | null {
  const path = fieldIssues(err)[0]?.path ?? '';
  const named = FIELD_ORDER.find((field) => path === `guest.${field}` || path === field);
  if (named) return named;
  if (!(err instanceof ApiError) || err.code !== 'validation') return null;
  if (/email/i.test(err.message)) return 'email';
  if (/your name/i.test(err.message)) return 'firstName';
  if (/accept/i.test(err.message)) return 'acceptTerms';
  return null;
}

interface Failure {
  title: string;
  message: string;
  /** Where the guest can put it right, when it is not on this page. */
  way?: { href: string; label: string };
}

/**
 * What to say when no answer came back, or a fault on the way to one. The request may have
 * arrived all the same. An attempt that carries a name can simply be sent again. Without
 * one: where a booking is paid for on the next page that leaves a hold which lapses by
 * itself, and trying again is right; where it is confirmed at once, trying again could book
 * the same stay twice, and the confirmation email is how the guest can tell.
 */
function unanswered(err: unknown, confirmedAtOnce: boolean, named: boolean): Failure | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status !== 0 && err.status < 500) return null;
  // An attempt sent with a name is one booking however often it is sent: trying again is safe.
  if (named) {
    return {
      title: 'We did not get an answer',
      message:
        err.status === 0
          ? 'We could not reach the server. Check your connection and press the button again: sending this a second time does not book twice.'
          : 'Something went wrong on our side. Please press the button again in a moment: sending this a second time does not book twice.',
    };
  }
  if (!confirmedAtOnce) return null;
  return {
    title: 'We are not sure your booking was made',
    message:
      err.status === 0
        ? 'We could not reach the server. Check your connection, and look for our email before you try again, so that you do not book twice.'
        : 'Something went wrong on our side. Please look for our email before you try again, so that you do not book twice.',
  };
}

export function BookingForm(props: BookingFormProps) {
  const { currency, total, payNow, resultsHref, goneHref } = props;
  const router = useRouter();
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const bookingPage = useRef<string | null>(null);

  // The form as it first renders is never written: that would put an empty form over what
  // was saved, before it has been read. Nor is anything written once the booking is made.
  const finished = useRef(false);
  useEffect(() => {
    if (values !== EMPTY && !finished.current) writeDraft(values);
  }, [values]);

  useEffect(() => {
    const draft = readDraft();
    if (Object.keys(draft).length > 0) setValues((current) => ({ ...current, ...draft }));
  }, []);
  // After the draft, so that what the guest has just typed goes over what was saved earlier.
  useEarlyInput(formRef);

  // Coming back from the payment page with the Back button can bring this page back as it
  // was left, form and all. The booking exists by then: show it rather than a form to send twice.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted && bookingPage.current) window.location.replace(bookingPage.current);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  const set = (patch: Partial<Values>) => {
    setValues((current) => ({ ...current, ...patch }));
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key as Field];
      return next;
    });
  };

  const focusField = (field: Field) => {
    formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values);
    setErrors(found);
    setFailure(null);
    const firstWrong = FIELD_ORDER.find((field) => found[field]);
    if (firstWrong) {
      focusField(firstWrong);
      return;
    }

    const body: BookingBody = {
      ...(props.org ? { org: props.org } : {}),
      propertyCode: props.propertyCode,
      checkIn: props.checkIn,
      checkOut: props.checkOut,
      rooms: Array.from({ length: props.rooms }, () => ({
        roomTypeId: props.roomTypeId,
        ratePlanId: props.ratePlanId,
        adults: props.adultsPerRoom,
        children: props.childrenPerRoom,
      })),
      guest: {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        ...(values.country ? { country: values.country } : {}),
      },
      ...(values.arrivalTime ? { arrivalTime: values.arrivalTime } : {}),
      ...(values.specialRequests.trim() ? { specialRequests: values.specialRequests.trim() } : {}),
      ...(props.promoCode ? { promoCode: props.promoCode } : {}),
      acceptTerms: true,
      marketingConsent: values.marketingConsent,
    };
    const requestId = attemptId(body);

    setSubmitting(true);
    try {
      const booked = await api<Booked>('/bookings', {
        body: requestId ? { ...body, requestId } : body,
      });
      const page = `/booking/${booked.token}`;
      if (booked.payment) {
        // Kept until the booking is paid for: if the payment does not go through, the guest
        // can come back to this form as they left it.
        rememberForm(booked.token, window.location.pathname + window.location.search);
        // The Back button on the payment page should lead to the booking, not to this form,
        // and to its top rather than as far down as this form was scrolled.
        bookingPage.current = page;
        window.history.scrollRestoration = 'manual';
        window.history.replaceState(null, '', page);
        window.location.assign(booked.payment.checkoutUrl);
      } else {
        finished.current = true;
        clearDraft();
        router.replace(page);
      }
      // Still busy on purpose: the browser is on its way to the next page.
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError && err.code === 'no_availability') {
        router.replace(goneHref);
        return;
      }
      const field = fieldOf(err);
      if (field) {
        setErrors({ [field]: errorMessage(err) });
        focusField(field);
        return;
      }
      const elsewhere =
        err instanceof ApiError &&
        (err.code === 'restriction_violated' || (err.code === 'validation' && err.status === 400));
      setFailure(
        unanswered(err, payNow === 0, requestId !== null) ?? {
          title: 'Your booking was not made',
          message: errorMessage(err),
          way: elsewhere ? { href: resultsHref, label: 'Choose again' } : undefined,
        },
      );
    }
  };

  const money = (amount: number) => formatMoney(amount, currency);
  const action = payNow > 0 ? `Confirm and pay ${money(payNow)}` : 'Confirm booking';

  return (
    // Sent before the page's scripts have loaded, or with scripts switched off, this goes to
    // the server as a plain form and the page comes back empty. As a POST it does so quietly.
    // As the GET it would be by default, the guest's name, email and phone would be written
    // into the address, and from there into every log on the way.
    <form
      ref={formRef}
      method="post"
      noValidate
      onSubmit={onSubmit}
      aria-label="Your booking"
      className="flex flex-col gap-6"
    >
      <section
        aria-labelledby="book-details"
        className="rounded-2xl border border-line/70 bg-surface p-4 shadow-card sm:p-6"
      >
        <h2 id="book-details" className="mb-4 font-display text-xl">
          Your details
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="book-first-name"
            name="firstName"
            label="First name"
            autoComplete="given-name"
            required
            maxLength={120}
            value={values.firstName}
            onChange={(event) => set({ firstName: event.target.value })}
            error={errors.firstName}
          />
          <TextField
            id="book-last-name"
            name="lastName"
            label="Last name"
            autoComplete="family-name"
            required
            maxLength={120}
            value={values.lastName}
            onChange={(event) => set({ lastName: event.target.value })}
            error={errors.lastName}
          />
          <TextField
            id="book-email"
            name="email"
            type="email"
            inputMode="email"
            label="Email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
            hint="Your confirmation is sent here."
            value={values.email}
            onChange={(event) => set({ email: event.target.value })}
            error={errors.email}
          />
          <TextField
            id="book-phone"
            name="phone"
            type="tel"
            label="Phone"
            autoComplete="tel"
            required
            maxLength={40}
            hint="With the country code, in case the property needs to reach you."
            value={values.phone}
            onChange={(event) => set({ phone: event.target.value })}
            error={errors.phone}
          />
          <SelectField
            id="book-country"
            name="country"
            label="Country you live in"
            optional
            autoComplete="country"
            value={values.country}
            onChange={(event) => set({ country: event.target.value })}
          >
            <option value="">Choose a country</option>
            {props.countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </SelectField>
        </div>
      </section>

      <section
        aria-labelledby="book-arrival"
        className="rounded-2xl border border-line/70 bg-surface p-4 shadow-card sm:p-6"
      >
        <h2 id="book-arrival" className="mb-4 font-display text-xl">
          Your arrival
        </h2>
        <div className="grid gap-4">
          <TextField
            id="book-arrival-time"
            name="arrivalTime"
            type="time"
            label="When do you expect to arrive?"
            optional
            hint={`Check-in is from ${props.checkInTime}.`}
            value={values.arrivalTime}
            onChange={(event) => set({ arrivalTime: event.target.value })}
            className="sm:max-w-xs"
          />
          <TextAreaField
            id="book-requests"
            name="specialRequests"
            label="Anything the property should know?"
            optional
            maxLength={2000}
            rows={3}
            hint="The property will do its best, but cannot promise every request."
            value={values.specialRequests}
            onChange={(event) => set({ specialRequests: event.target.value })}
          />
        </div>
      </section>

      <section
        aria-labelledby="book-terms"
        className="rounded-2xl border border-line/70 bg-surface p-4 shadow-card sm:p-6"
      >
        <h2 id="book-terms" className="mb-4 font-display text-xl">
          Terms
        </h2>
        <div className="space-y-3">
          <div
            tabIndex={0}
            role="group"
            aria-label="Booking terms"
            className="max-h-48 space-y-3 overflow-y-auto rounded-lg border border-line bg-canvas p-3 text-[15px] leading-relaxed text-ink-soft"
          >
            {props.terms}
          </div>
          <CheckboxField
            id="book-accept"
            name="acceptTerms"
            required
            checked={values.acceptTerms}
            onChange={(event) => set({ acceptTerms: event.target.checked })}
            error={errors.acceptTerms}
            label="I accept these terms."
          />
          <CheckboxField
            id="book-offers"
            name="marketingConsent"
            checked={values.marketingConsent}
            onChange={(event) => set({ marketingConsent: event.target.checked })}
            label={`Send me offers from ${props.organisationName} by email.`}
          />
        </div>
      </section>

      {failure ? (
        <div ref={failureRef} tabIndex={-1} className="rounded-xl outline-offset-4">
          <Notice tone="danger" role="alert" title={failure.title}>
            <p>{failure.message}</p>
            {failure.way ? (
              <p className="mt-2">
                <Link
                  href={failure.way.href}
                  className="font-semibold underline underline-offset-4"
                >
                  {failure.way.label}
                </Link>
              </p>
            ) : null}
          </Notice>
        </div>
      ) : null}

      <noscript>
        <Notice tone="warning" title="This form cannot be sent">
          It needs scripts to make your booking, and your browser has them switched off. Please
          switch them on and load the page again.
        </Notice>
      </noscript>

      {/* On a phone this stays at the bottom of the screen: the total and the button in reach of a thumb. */}
      <div className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-6px_16px_-8px_rgb(40_30_16/0.18)] sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
        <div className="flex items-center gap-4 lg:flex-col lg:items-stretch lg:gap-3">
          <div className="min-w-0 lg:hidden">
            <p className="text-sm text-ink-soft">Total</p>
            <p className="text-lg leading-tight font-semibold tabular-nums">{money(total)}</p>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={submitting}
            icon={payNow > 0 ? <Lock className="size-4" aria-hidden /> : undefined}
            className="flex-1 lg:w-full lg:flex-none"
          >
            {submitting ? 'Making your booking' : action}
          </Button>
        </div>
        <p className="mt-2 hidden text-sm text-ink-soft lg:block">
          {payNow > 0
            ? 'You pay on the next page. Your booking is held for you while you pay.'
            : 'Nothing is charged now. Your booking is confirmed at once.'}
        </p>
        <p role="status" className="sr-only">
          {submitting ? 'Making your booking. Please wait.' : ''}
        </p>
      </div>
    </form>
  );
}
