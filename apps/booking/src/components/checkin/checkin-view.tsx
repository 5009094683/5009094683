'use client';

import { ArrowLeft, CircleCheck, Info, Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ContactLinks } from '@/components/contact-links';
import { Button } from '@/components/ui/button';
import { CheckboxField, SelectField, TextField } from '@/components/ui/field';
import { LinkPending } from '@/components/ui/link-pending';
import { Notice } from '@/components/ui/notice';
import { errorMessage } from '@/lib/api-error';
import { api, bookingPath } from '@/lib/browser-api';
import { cn } from '@/lib/cn';
import type { Country } from '@/lib/countries';
import { diffDays, formatDate, formatDay, formatInstantDate } from '@/lib/dates';
import { count, formatFileSize, sentence } from '@/lib/format';
import { useEarlyInput } from '@/lib/hooks';
import type {
  Checkin,
  CheckinBody,
  CheckinFile,
  CheckinGuestBody,
  CheckinGuestSaved,
  IdType,
} from '@/lib/types';
import { DocumentUpload } from './document-upload';

export interface CheckinViewProps {
  token: string;
  checkin: Checkin;
  /** The name the booking is in: the first guest, unless they say otherwise. */
  bookedFor: string;
  countries: Country[];
  /** The country the property is in, by name. */
  countryLabel: string;
  /** Today's date where the property is. */
  today: string;
  timezone: string;
  phone: string | null;
  email: string | null;
}

const ID_LABELS: Record<IdType, string> = {
  passport: 'Passport',
  aadhaar: 'Aadhaar card',
  driving_licence: 'Driving licence',
  voter_id: 'Voter ID card',
  national_id: 'National identity card',
  other: 'Another document',
};

/** Kinds of document that carry an expiry date. */
const EXPIRES: IdType[] = ['passport', 'driving_licence', 'national_id', 'other'];
/** Documents only India issues: not offered at a property anywhere else. */
const INDIAN: IdType[] = ['aadhaar', 'voter_id'];

const MAX_GUESTS = 30;
const CARD = 'rounded-2xl border border-line/70 bg-surface shadow-card';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface GuestDraft {
  /** Stays with the guest as others are added and removed. */
  key: number;
  /**
   * The key the server gave this guest when they were saved. Sent back with a correction, it
   * is how the server knows whose saved numbers to keep. A guest who is new has none.
   */
  savedKey?: string;
  name: string;
  nationality: string;
  dateOfBirth: string;
  idType: IdType | '';
  idNumber: string;
  idExpiry: string;
  address: string;
  visaNumber: string;
  visaExpiry: string;
  arrivedInCountryOn: string;
  arrivingFrom: string;
  nextDestination: string;
}

type GuestField = Exclude<keyof GuestDraft, 'key' | 'savedKey'>;
type Errors = Record<string, string>;

const blank = (key: number, name = ''): GuestDraft => ({
  key,
  name,
  nationality: '',
  dateOfBirth: '',
  idType: '',
  idNumber: '',
  idExpiry: '',
  address: '',
  visaNumber: '',
  visaExpiry: '',
  arrivedInCountryOn: '',
  arrivingFrom: '',
  nextDestination: '',
});

/** A saved guest as a draft to correct. The numbers stay empty: only their endings ever come back. */
const fromSaved = (key: number, saved: CheckinGuestSaved): GuestDraft => ({
  key,
  savedKey: saved.key,
  name: saved.name,
  nationality: saved.nationality ?? '',
  dateOfBirth: saved.dateOfBirth ?? '',
  idType: saved.idType ?? '',
  idNumber: '',
  idExpiry: saved.idExpiry ?? '',
  address: saved.address ?? '',
  visaNumber: '',
  visaExpiry: saved.visaExpiry ?? '',
  arrivedInCountryOn: saved.arrivedInCountryOn ?? '',
  arrivingFrom: saved.arrivingFrom ?? '',
  nextDestination: saved.nextDestination ?? '',
});

function firstDrafts(checkin: Checkin, bookedFor: string): GuestDraft[] {
  if (checkin.guests.length > 0) return checkin.guests.map((saved, i) => fromSaved(i, saved));
  const expected = Math.min(MAX_GUESTS, Math.max(1, checkin.expectedGuests));
  return Array.from({ length: expected }, (_, i) => blank(i, i === 0 ? bookedFor : ''));
}

/** `••••9012` as `9012`. */
const lastDigits = (ending: string): string => ending.replace(/^\u2022+/, '');

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-2">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

export function CheckinView({
  token,
  checkin: initial,
  bookedFor,
  countries,
  countryLabel,
  today,
  timezone,
  phone,
  email,
}: CheckinViewProps) {
  const [checkin, setCheckin] = useState(initial);
  const [documents, setDocuments] = useState<CheckinFile[]>(initial.documents);
  const [editing, setEditing] = useState(initial.open && initial.guests.length === 0);
  const [justSaved, setJustSaved] = useState(false);
  const [guests, setGuests] = useState(() => firstDrafts(initial, bookedFor));
  const [arrivalTime, setArrivalTime] = useState(
    initial.arrivalTime && TIME.test(initial.arrivalTime) ? initial.arrivalTime : '',
  );
  const [signatureName, setSignatureName] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nextKey = useRef(guests.length);
  const formRef = useRef<HTMLFormElement>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);

  const saved = checkin.guests;
  const home = checkin.propertyCountry.toUpperCase();
  const bookingHref = `/booking/${encodeURIComponent(token)}`;
  const countryNames = new Map(countries.map((country) => [country.code, country.name]));
  const isForeign = (guest: GuestDraft) => guest.nationality !== '' && guest.nationality !== home;
  /** The kind of document a guest is giving: always a passport for a visitor from abroad. */
  const kindOf = (guest: GuestDraft): IdType | '' => (isForeign(guest) ? 'passport' : guest.idType);
  // The server tells saved guests apart by the key it gave each of them. Guests saved before
  // there were keys have none, and are told apart by their place in the list, there as here.
  const keyed = saved.some((one) => one.key);
  /** The saved guest that a guest in the form is a correction of, if any. */
  const savedFor = (guest: GuestDraft, index: number): CheckinGuestSaved | undefined =>
    keyed
      ? guest.savedKey
        ? saved.find((one) => one.key === guest.savedKey)
        : undefined
      : saved[index];
  /** Whether the number saved for this guest is kept when the field is left empty. */
  const keepsNumber = (guest: GuestDraft, index: number) => {
    const before = savedFor(guest, index);
    return Boolean(before?.idNumberEnding) && kindOf(guest) === before?.idType;
  };

  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  useEarlyInput(formRef);

  // The page changes under the guest when they save or start changing: start them at its top.
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    window.scrollTo({ top: 0 });
    headingRef.current?.focus();
  }, [editing]);

  const setGuest = (index: number, patch: Partial<GuestDraft>) => {
    setGuests((current) =>
      current.map((guest, i) => (i === index ? { ...guest, ...patch } : guest)),
    );
    setErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(patch)) delete next[`${index}.${field}`];
      return next;
    });
  };

  const addGuest = () => {
    const key = nextKey.current;
    nextKey.current += 1;
    setGuests((current) => {
      // Where guests are told apart by their place, a place that had a guest saved gets that
      // guest back: the numbers saved for the place belong to them.
      const before = keyed ? undefined : saved[current.length];
      return [...current, before ? fromSaved(key, before) : blank(key)];
    });
  };

  const removeGuest = (index: number) => {
    setGuests((current) => current.filter((_, i) => i !== index));
    setErrors({});
  };

  const validate = (): Errors => {
    const found: Errors = {};
    guests.forEach((guest, index) => {
      if (!guest.name.trim()) found[`${index}.name`] = "Please give this guest's full name.";
      if (!guest.nationality) found[`${index}.nationality`] = 'Please choose a nationality.';
      if (guest.dateOfBirth && guest.dateOfBirth > today) {
        found[`${index}.dateOfBirth`] = 'This date is in the future. Please check it.';
      }
      const kind = kindOf(guest);
      const typed = guest.idNumber.trim() !== '';
      const kept = keepsNumber(guest, index);
      if (isForeign(guest)) {
        if (!typed && !kept) {
          found[`${index}.idNumber`] = 'Visitors from abroad need to give their passport number.';
        }
      } else if (index === 0 && !kind) {
        found[`${index}.idType`] = 'Please choose the document you will show when you arrive.';
      } else if (kind && !typed && !kept) {
        found[`${index}.idNumber`] = 'Please give the number of this document.';
      } else if (!kind && typed) {
        found[`${index}.idType`] = 'Please choose what kind of document this number is from.';
      }
    });
    if (!signatureName.trim()) found.signatureName = 'Please type your full name to sign.';
    if (!acceptTerms) {
      found.acceptTerms = checkin.terms
        ? 'Please accept the house rules.'
        : 'Please confirm that these details are correct.';
    }
    return found;
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate();
    setErrors(found);
    setFailure(null);
    const firstWrong = Object.keys(found)[0];
    if (firstWrong) {
      formRef.current?.querySelector<HTMLElement>(`[data-field="${firstWrong}"]`)?.focus();
      return;
    }

    const text = (value: string) => value.trim() || undefined;
    const body: CheckinBody = {
      arrivalTime: arrivalTime || undefined,
      guests: guests.map((guest): CheckinGuestBody => {
        const kind = kindOf(guest);
        return {
          key: guest.savedKey,
          name: guest.name.trim(),
          nationality: guest.nationality,
          dateOfBirth: guest.dateOfBirth || undefined,
          idType: kind || undefined,
          idNumber: text(guest.idNumber),
          idExpiry: (kind && EXPIRES.includes(kind) && guest.idExpiry) || undefined,
          address: text(guest.address),
          ...(isForeign(guest)
            ? {
                visaNumber: text(guest.visaNumber),
                visaExpiry: guest.visaExpiry || undefined,
                arrivedInCountryOn: guest.arrivedInCountryOn || undefined,
                arrivingFrom: text(guest.arrivingFrom),
                nextDestination: text(guest.nextDestination),
              }
            : {}),
        };
      }),
      signatureName: signatureName.trim(),
      acceptTerms: true,
    };

    setSubmitting(true);
    try {
      const result = await api<Checkin>(bookingPath(token, '/check-in'), { body });
      setCheckin(result);
      setDocuments(result.documents);
      setGuests(result.guests.map((guest, i) => fromSaved(i, guest)));
      nextKey.current = result.guests.length;
      setSignatureName('');
      setAcceptTerms(false);
      setJustSaved(true);
      moveFocus.current = true;
      setEditing(false);
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const stay = `${formatDay(checkin.checkIn)} to ${formatDate(checkin.checkOut)}`;
  const back = (
    <Link
      href={bookingHref}
      className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-[15px] font-medium text-ink-soft hover:bg-sunken hover:text-ink"
    >
      <LinkPending icon={<ArrowLeft className="size-4" aria-hidden />} />
      Back to your booking
    </Link>
  );

  if (!editing) {
    const nothingSaved = saved.length === 0;
    const opensOn = checkin.open ? null : checkin.opensOn;
    return (
      <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6 sm:pt-6">
        {back}
        <section className={cn(CARD, 'mt-2 p-5 sm:p-7')}>
          <div role="status" className="flex items-start gap-4">
            <span
              className={cn(
                'flex size-12 shrink-0 items-center justify-center rounded-full',
                nothingSaved ? 'bg-sunken text-ink-soft' : 'bg-success-50 text-success-700',
              )}
            >
              {nothingSaved ? (
                <Info className="size-6" aria-hidden />
              ) : (
                <CircleCheck className="size-6" aria-hidden />
              )}
            </span>
            <div className="min-w-0 space-y-1.5">
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="font-display text-[1.7rem] leading-tight outline-none sm:text-4xl"
              >
                {nothingSaved
                  ? opensOn
                    ? 'Online check-in is not open yet'
                    : 'Online check-in is not open'
                  : justSaved
                    ? 'Thank you. Your details are saved.'
                    : checkin.status === 'verified'
                      ? 'Your details have been checked'
                      : 'Your details are saved'}
              </h1>
              <p className="text-base text-ink-soft">
                {checkin.open
                  ? `${checkin.propertyName} has them ready for your arrival on ${formatDate(checkin.checkIn)}.`
                  : opensOn
                    ? `You can check in online from ${formatDate(opensOn)}, ${count(diffDays(opensOn, checkin.checkIn), 'day')} before you arrive on ${formatDate(checkin.checkIn)}.`
                    : sentence(checkin.reason ?? 'Online check-in cannot be used for this booking')}
              </p>
            </div>
          </div>
          {!nothingSaved && checkin.open ? (
            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                onClick={() => {
                  setJustSaved(false);
                  moveFocus.current = true;
                  setEditing(true);
                }}
                className="w-full sm:w-auto"
              >
                Change these details
              </Button>
              <p className="text-sm text-ink-soft">
                You can change them until the front desk has checked them.
              </p>
            </div>
          ) : null}
          {nothingSaved && (phone || email) ? (
            <div className="mt-5 border-t border-line pt-4">
              <p className="text-[15px] text-ink-soft">
                If you have a question, please contact {checkin.propertyName}.
              </p>
              <ContactLinks phone={phone} email={email} className="mt-1" />
            </div>
          ) : null}
        </section>

        {!nothingSaved ? (
          <section aria-labelledby="saved-heading" className={cn(CARD, 'mt-6 p-5 sm:p-7')}>
            <h2 id="saved-heading" className="font-display text-2xl leading-tight">
              The details you sent
            </h2>
            <p className="mt-1 text-[15px] text-ink-soft">
              Booking {checkin.bookingCode}, {stay}. Only the end of each document number is shown.
            </p>
            <ol className="mt-4 space-y-5">
              {saved.map((guest, index) => (
                <li key={index} className="rounded-xl border border-line p-4">
                  <h3 className="text-base font-semibold">{guest.name}</h3>
                  <dl className="mt-1 divide-y divide-line text-[15px]">
                    {guest.nationality ? (
                      <Fact label="Nationality">
                        {countryNames.get(guest.nationality) ?? guest.nationality}
                      </Fact>
                    ) : null}
                    {guest.dateOfBirth ? (
                      <Fact label="Date of birth">{formatDate(guest.dateOfBirth)}</Fact>
                    ) : null}
                    {guest.idType ? (
                      <Fact label={ID_LABELS[guest.idType]}>
                        <span className="tracking-wider">{guest.idNumberEnding}</span>
                      </Fact>
                    ) : null}
                    {guest.idExpiry ? (
                      <Fact
                        label={
                          guest.idType === 'passport'
                            ? 'Passport valid until'
                            : 'Document valid until'
                        }
                      >
                        {formatDate(guest.idExpiry)}
                      </Fact>
                    ) : null}
                    {guest.address ? <Fact label="Home address">{guest.address}</Fact> : null}
                    {guest.visaNumberEnding ? (
                      <Fact label="Visa">
                        <span className="tracking-wider">{guest.visaNumberEnding}</span>
                      </Fact>
                    ) : null}
                    {guest.visaExpiry ? (
                      <Fact label="Visa valid until">{formatDate(guest.visaExpiry)}</Fact>
                    ) : null}
                    {guest.arrivedInCountryOn ? (
                      <Fact label={`Arrived in ${countryLabel}`}>
                        {formatDate(guest.arrivedInCountryOn)}
                      </Fact>
                    ) : null}
                    {guest.arrivingFrom ? (
                      <Fact label="Arriving from">{guest.arrivingFrom}</Fact>
                    ) : null}
                    {guest.nextDestination ? (
                      <Fact label="Going on to">{guest.nextDestination}</Fact>
                    ) : null}
                  </dl>
                </li>
              ))}
            </ol>
            <dl className="mt-4 divide-y divide-line border-t border-line text-[15px]">
              {checkin.arrivalTime ? (
                <Fact label="Expected arrival">{checkin.arrivalTime}</Fact>
              ) : null}
              {checkin.submittedAt ? (
                <Fact label="Sent on">{formatInstantDate(checkin.submittedAt, timezone)}</Fact>
              ) : null}
              <Fact label="Documents">
                {documents.length === 0 ? (
                  'None added'
                ) : (
                  <ul className="space-y-1">
                    {documents.map((document) => (
                      <li key={document.id} className="break-all">
                        {document.fileName}{' '}
                        <span className="font-normal whitespace-nowrap text-ink-soft">
                          ({formatFileSize(document.size)})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Fact>
            </dl>
          </section>
        ) : null}
      </div>
    );
  }

  const changing = saved.length > 0;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6 sm:pt-6">
      {back}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-2 font-display text-3xl leading-tight outline-none sm:text-4xl"
      >
        {changing ? 'Change your details' : 'Check in online'}
      </h1>
      <p className="mt-2 max-w-prose text-base text-ink-soft">
        {changing
          ? 'Change what is not right, then save. A document number you leave empty stays as it is.'
          : `Send ${checkin.propertyName} your details now, and spend less time at the desk when you arrive.`}
      </p>
      <p className="mt-1 flex max-w-prose items-start gap-2 text-base text-ink-soft">
        <ShieldCheck className="mt-1 size-4 shrink-0" aria-hidden />
        They are stored encrypted and shown only to the front desk.
      </p>
      <p className="mt-3 text-[15px] font-medium">
        Booking {checkin.bookingCode}, {stay}
      </p>

      {/* Sent before the page's scripts have loaded, or without them, a form goes to the server
          as it is. As a POST, nothing a guest typed can end up in the address. */}
      <form
        ref={formRef}
        method="post"
        noValidate
        onSubmit={onSubmit}
        aria-label="Online check-in"
        className="mt-6 flex flex-col gap-6"
      >
        <noscript>
          <Notice tone="warning" title="This form cannot be sent">
            It needs scripts to send your details, and your browser has them switched off. Please
            switch them on and load the page again, or give your details at the desk when you
            arrive.
          </Notice>
        </noscript>
        {guests.map((guest, index) => {
          const id = (field: string) => `guest-${guest.key}-${field}`;
          const error = (field: GuestField) => errors[`${index}.${field}`];
          const savedAt = savedFor(guest, index);
          const foreign = isForeign(guest);
          const kind = kindOf(guest);
          const kept = keepsNumber(guest, index);
          // Where guests are told apart by their place, one can leave only from the end of
          // those already saved: the numbers saved for each place in the list would otherwise
          // pass to the next guest along.
          const removable =
            index > 0 && (keyed || index >= saved.length || index === guests.length - 1);
          const kinds = (Object.keys(ID_LABELS) as IdType[]).filter(
            (option) => home === 'IN' || !INDIAN.includes(option),
          );
          return (
            <section
              key={guest.key}
              aria-labelledby={id('heading')}
              className={cn(CARD, 'p-4 sm:p-6')}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 id={id('heading')} className="font-display text-xl">
                  Guest {index + 1}
                  {index === 0 ? (
                    <span className="ml-2 font-sans text-sm font-normal text-ink-soft">
                      the main guest
                    </span>
                  ) : null}
                </h2>
                {removable ? (
                  <button
                    type="button"
                    onClick={() => removeGuest(index)}
                    aria-label={`Remove guest ${index + 1}`}
                    className="-mr-2 flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[15px] font-medium text-ink-soft hover:bg-sunken hover:text-danger-700"
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Remove
                  </button>
                ) : null}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id={id('name')}
                  data-field={`${index}.name`}
                  label="Full name"
                  hint="As it is written on the identity document."
                  autoComplete={index === 0 ? 'name' : 'off'}
                  required
                  maxLength={160}
                  value={guest.name}
                  onChange={(event) => setGuest(index, { name: event.target.value })}
                  error={error('name')}
                />
                <SelectField
                  id={id('nationality')}
                  data-field={`${index}.nationality`}
                  label="Nationality"
                  required
                  value={guest.nationality}
                  onChange={(event) => setGuest(index, { nationality: event.target.value })}
                  error={error('nationality')}
                >
                  <option value="">Choose a country</option>
                  {countries.map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </SelectField>
                <TextField
                  id={id('dob')}
                  data-field={`${index}.dateOfBirth`}
                  type="date"
                  label="Date of birth"
                  optional
                  max={today}
                  autoComplete={index === 0 ? 'bday' : 'off'}
                  value={guest.dateOfBirth}
                  onChange={(event) => setGuest(index, { dateOfBirth: event.target.value })}
                  error={error('dateOfBirth')}
                />
                <TextField
                  id={id('address')}
                  label="Home address"
                  optional
                  maxLength={400}
                  autoComplete={index === 0 ? 'street-address' : 'off'}
                  value={guest.address}
                  onChange={(event) => setGuest(index, { address: event.target.value })}
                />

                {foreign ? (
                  <p className="flex items-start gap-2 rounded-lg bg-info-50 px-3 py-2.5 text-[15px] text-ink sm:col-span-2">
                    <Info className="mt-0.5 size-4 shrink-0 text-info-700" aria-hidden />
                    Visitors from abroad give their passport and visa details. {countryLabel} asks
                    every place to stay to record them.
                  </p>
                ) : (
                  <SelectField
                    id={id('id-type')}
                    data-field={`${index}.idType`}
                    label="Identity document"
                    optional={index > 0 && !savedAt?.idType}
                    value={guest.idType}
                    onChange={(event) =>
                      setGuest(index, { idType: event.target.value as IdType | '' })
                    }
                    error={error('idType')}
                  >
                    {/* A document already saved cannot be taken away again, only replaced. */}
                    {savedAt?.idType ? null : (
                      <option value="">{index === 0 ? 'Choose a document' : 'No document'}</option>
                    )}
                    {kinds.map((option) => (
                      <option key={option} value={option}>
                        {ID_LABELS[option]}
                      </option>
                    ))}
                  </SelectField>
                )}
                {kind ? (
                  <>
                    <TextField
                      id={id('id-number')}
                      data-field={`${index}.idNumber`}
                      label={foreign ? 'Passport number' : `${ID_LABELS[kind]} number`}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={60}
                      required={!kept}
                      hint={
                        kept && savedAt?.idNumberEnding
                          ? `Saved, ending ${lastDigits(savedAt.idNumberEnding)}. Leave empty to keep it.`
                          : undefined
                      }
                      value={guest.idNumber}
                      onChange={(event) => setGuest(index, { idNumber: event.target.value })}
                      error={error('idNumber')}
                    />
                    {EXPIRES.includes(kind) ? (
                      <TextField
                        id={id('id-expiry')}
                        type="date"
                        label={foreign ? 'Passport valid until' : 'Document valid until'}
                        optional
                        value={guest.idExpiry}
                        onChange={(event) => setGuest(index, { idExpiry: event.target.value })}
                      />
                    ) : null}
                  </>
                ) : null}

                {foreign ? (
                  <>
                    <TextField
                      id={id('visa-number')}
                      label="Visa number"
                      optional
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={60}
                      hint={
                        savedAt?.visaNumberEnding
                          ? `Saved, ending ${lastDigits(savedAt.visaNumberEnding)}. Leave empty to keep it.`
                          : 'Leave empty if you do not need a visa.'
                      }
                      value={guest.visaNumber}
                      onChange={(event) => setGuest(index, { visaNumber: event.target.value })}
                    />
                    <TextField
                      id={id('visa-expiry')}
                      type="date"
                      label="Visa valid until"
                      optional
                      value={guest.visaExpiry}
                      onChange={(event) => setGuest(index, { visaExpiry: event.target.value })}
                    />
                    <TextField
                      id={id('arrived')}
                      type="date"
                      label={`Date you arrived in ${countryLabel}`}
                      optional
                      max={checkin.checkIn}
                      value={guest.arrivedInCountryOn}
                      onChange={(event) =>
                        setGuest(index, { arrivedInCountryOn: event.target.value })
                      }
                    />
                    <TextField
                      id={id('from')}
                      label="Where you are arriving from"
                      optional
                      maxLength={120}
                      hint="The town or city you stayed in last."
                      value={guest.arrivingFrom}
                      onChange={(event) => setGuest(index, { arrivingFrom: event.target.value })}
                    />
                    <TextField
                      id={id('next')}
                      label="Where you are going next"
                      optional
                      maxLength={120}
                      value={guest.nextDestination}
                      onChange={(event) => setGuest(index, { nextDestination: event.target.value })}
                    />
                  </>
                ) : null}
              </div>
            </section>
          );
        })}

        {guests.length < MAX_GUESTS ? (
          <Button
            onClick={addGuest}
            icon={<Plus className="size-4" aria-hidden />}
            className="self-start"
          >
            Add a guest
          </Button>
        ) : null}

        <section aria-labelledby="checkin-arrival" className={cn(CARD, 'p-4 sm:p-6')}>
          <h2 id="checkin-arrival" className="mb-4 font-display text-xl">
            Your arrival
          </h2>
          <TextField
            id="checkin-arrival-time"
            type="time"
            label="When do you expect to arrive?"
            optional
            value={arrivalTime}
            onChange={(event) => setArrivalTime(event.target.value)}
            className="sm:max-w-xs"
          />
        </section>

        <section aria-labelledby="checkin-documents" className={cn(CARD, 'p-4 sm:p-6')}>
          <h2 id="checkin-documents" className="font-display text-xl">
            Identity documents
          </h2>
          <p className="mt-1 mb-4 text-[15px] text-ink-soft">
            A photo or scan of each guest&apos;s document saves copying it at the desk. Each file is
            added as soon as you choose it.
          </p>
          <DocumentUpload token={token} documents={documents} setDocuments={setDocuments} />
        </section>

        <section aria-labelledby="checkin-rules" className={cn(CARD, 'p-4 sm:p-6')}>
          <h2 id="checkin-rules" className="mb-4 font-display text-xl">
            {checkin.terms ? 'House rules' : 'Your signature'}
          </h2>
          <div className="space-y-4">
            {checkin.terms ? (
              <div
                tabIndex={0}
                role="group"
                aria-label="House rules"
                className="max-h-48 overflow-y-auto rounded-lg border border-line bg-canvas p-3 text-[15px] leading-relaxed whitespace-pre-line text-ink-soft"
              >
                {checkin.terms}
              </div>
            ) : null}
            <CheckboxField
              id="checkin-accept"
              data-field="acceptTerms"
              required
              checked={acceptTerms}
              onChange={(event) => {
                setAcceptTerms(event.target.checked);
                setErrors(({ acceptTerms: _dropped, ...rest }) => rest);
              }}
              error={errors.acceptTerms}
              label={
                checkin.terms
                  ? 'I accept the house rules, and these details are correct.'
                  : 'These details are correct.'
              }
            />
            <TextField
              id="checkin-signature"
              data-field="signatureName"
              label="Type your full name to sign"
              autoComplete="off"
              required
              maxLength={160}
              value={signatureName}
              onChange={(event) => {
                setSignatureName(event.target.value);
                setErrors(({ signatureName: _dropped, ...rest }) => rest);
              }}
              error={errors.signatureName}
              className="sm:max-w-sm"
            />
          </div>
        </section>

        {failure ? (
          <div ref={failureRef} tabIndex={-1} className="rounded-xl outline-offset-4">
            <Notice tone="danger" role="alert" title="Your details were not saved">
              {failure}
            </Notice>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={submitting}
            disabled={submitting}
            icon={<Lock className="size-4" aria-hidden />}
            className="w-full sm:w-auto"
          >
            {submitting ? 'Saving' : changing ? 'Save my changes' : 'Send my details'}
          </Button>
          {changing ? (
            <Button
              disabled={submitting}
              onClick={() => {
                setGuests(saved.map((guest, i) => fromSaved(i, guest)));
                nextKey.current = saved.length;
                setErrors({});
                setFailure(null);
                moveFocus.current = true;
                setEditing(false);
              }}
              className="w-full sm:w-auto"
            >
              Leave them as they are
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
