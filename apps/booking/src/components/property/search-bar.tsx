'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { addDays, diffDays, isDate } from '@/lib/dates';
import { useEarlyInput } from '@/lib/hooks';
import {
  latestCheckOut,
  MAX_NIGHTS,
  readStay,
  stayQuery,
  type SearchParams,
  type StayInput,
} from '@/lib/stay';

/** The arrival field's id: links elsewhere on the page point at it to bring the guest back here. */
export const ARRIVAL_FIELD = 'stay-arrival';
/** The section the results are shown in. */
export const RESULTS_SECTION = 'rooms';

export interface SearchBarProps {
  /** The property's own page, where the search is shown: `/goa`. */
  path: string;
  /** The search in the address, which the results on the page are for. */
  stay: StayInput;
  /** Today's date where the property is. */
  today: string;
  /** The last night that can be booked. */
  bookableUntil: string;
  maxAdults: number;
  maxChildren: number;
  childMaxAge: number | null;
  /** What the search in the address found out about its promotional code. */
  promoMessage?: ReactNode;
}

type Errors = Partial<Record<'checkIn' | 'checkOut', string>>;

function validate(form: StayInput, today: string, bookableUntil: string): Errors {
  const errors: Errors = {};
  if (!isDate(form.checkIn)) errors.checkIn = 'Choose the day you arrive.';
  else if (form.checkIn < today) errors.checkIn = 'The arrival date is in the past.';
  else if (form.checkIn > bookableUntil) {
    errors.checkIn = 'This date is not open for booking yet.';
  }
  if (!isDate(form.checkOut)) errors.checkOut = 'Choose the day you leave.';
  else if (isDate(form.checkIn)) {
    const nights = diffDays(form.checkIn, form.checkOut);
    if (nights < 1) errors.checkOut = 'Departure must be after arrival.';
    else if (nights > MAX_NIGHTS) {
      errors.checkOut = `For more than ${MAX_NIGHTS} nights, please contact the property.`;
    } else if (!errors.checkIn && form.checkOut > addDays(bookableUntil, 1)) {
      errors.checkOut = 'This date is not open for booking yet.';
    }
  }
  return errors;
}

/**
 * What the form's fields hold now. This, not the component's own record of them, is what
 * a search takes, so that it can never be for other dates than the ones the guest sees.
 */
function heldBy(form: HTMLFormElement): StayInput {
  const fields: SearchParams = {};
  for (const [name, value] of new FormData(form)) {
    if (typeof value === 'string') fields[name] = value;
  }
  return readStay(fields);
}

export function SearchBar({
  path,
  stay,
  today,
  bookableUntil,
  maxAdults,
  maxChildren,
  childMaxAge,
  promoMessage,
}: SearchBarProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState(stay);
  const [errors, setErrors] = useState<Errors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const awaitingResults = useRef(false);
  useEarlyInput(formRef);

  // The address is the truth: going back or forward changes it, and the form follows.
  const inAddress = stayQuery(stay);
  const [followed, setFollowed] = useState(inAddress);
  if (followed !== inAddress) {
    setFollowed(inAddress);
    setForm(stay);
    setErrors({});
  }

  useEffect(() => {
    if (isPending || !awaitingResults.current) return;
    awaitingResults.current = false;
    document.getElementById(RESULTS_SECTION)?.scrollIntoView({ block: 'start' });
  }, [isPending]);

  const set = (patch: Partial<StayInput>) => setForm((current) => ({ ...current, ...patch }));

  const onArrival = (checkIn: string) => {
    setErrors((current) => ({ ...current, checkIn: undefined }));
    if (!isDate(checkIn) || !isDate(form.checkOut) || form.checkOut > checkIn) {
      set({ checkIn });
      return;
    }
    // Arrival moved past the departure: keep the length of the stay rather than an impossible one.
    const nights = isDate(form.checkIn) ? Math.max(1, diffDays(form.checkIn, form.checkOut)) : 1;
    const moved = addDays(checkIn, nights);
    const latest = latestCheckOut(checkIn, bookableUntil);
    set({ checkIn, checkOut: moved > latest ? latest : moved });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending) return;
    const held = heldBy(event.currentTarget);
    setForm(held);
    const found = validate(held, today, bookableUntil);
    setErrors(found);
    const firstWrong = found.checkIn ? 'checkIn' : found.checkOut ? 'checkOut' : null;
    if (firstWrong) {
      formRef.current?.querySelector<HTMLInputElement>(`[name="${firstWrong}"]`)?.focus();
      return;
    }
    const query = stayQuery(held);
    awaitingResults.current = true;
    startTransition(() => {
      router.push(`${path}?${query}`, { scroll: false });
    });
  };

  const earliestCheckOut = addDays(
    isDate(form.checkIn) && form.checkIn >= today ? form.checkIn : today,
    1,
  );
  const lastCheckOut = isDate(form.checkIn)
    ? latestCheckOut(form.checkIn, bookableUntil)
    : addDays(bookableUntil, 1);
  const promoIsSearched = form.promo.trim().toUpperCase() === stay.promo;

  return (
    <form
      ref={formRef}
      id="search"
      action={path}
      method="get"
      noValidate
      onSubmit={onSubmit}
      aria-label="Search for prices"
      className="rounded-2xl border border-line/70 bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-[1.25fr_1.25fr_1fr_1fr_1.25fr_auto] lg:items-start">
        <TextField
          id={ARRIVAL_FIELD}
          name="checkIn"
          type="date"
          label="Arrival"
          required
          min={today}
          max={bookableUntil}
          value={form.checkIn}
          onChange={(event) => onArrival(event.target.value)}
          error={errors.checkIn}
        />
        <TextField
          id="stay-departure"
          name="checkOut"
          type="date"
          label="Departure"
          required
          min={earliestCheckOut}
          max={lastCheckOut}
          value={form.checkOut}
          onChange={(event) => {
            setErrors((current) => ({ ...current, checkOut: undefined }));
            set({ checkOut: event.target.value });
          }}
          error={errors.checkOut}
        />
        <SelectField
          id="stay-adults"
          name="adults"
          label="Adults per room"
          value={form.adults}
          onChange={(event) => set({ adults: Number(event.target.value) })}
        >
          {Array.from({ length: Math.max(maxAdults, form.adults) }, (_, index) => (
            <option key={index + 1} value={index + 1}>
              {index + 1}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="stay-children"
          name="children"
          label="Children per room"
          value={form.children}
          onChange={(event) => set({ children: Number(event.target.value) })}
        >
          {Array.from({ length: Math.max(maxChildren, form.children) + 1 }, (_, index) => (
            <option key={index} value={index}>
              {index}
            </option>
          ))}
        </SelectField>
        <div className="col-span-2 flex flex-col gap-1.5 lg:col-span-1">
          <TextField
            id="stay-promo"
            name="promo"
            label="Promotional code"
            optional
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={30}
            value={form.promo}
            onChange={(event) => set({ promo: event.target.value })}
            aria-describedby="stay-promo-message"
            inputClassName="uppercase placeholder:normal-case"
          />
          <div id="stay-promo-message" aria-live="polite" className="text-sm empty:hidden">
            {promoIsSearched ? promoMessage : null}
          </div>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={isPending}
          icon={<Search className="size-5" aria-hidden />}
          className="col-span-2 lg:col-span-1 lg:mt-[1.625rem]"
        >
          {isPending ? 'Searching' : 'Search'}
        </Button>
      </div>
      <p className="mt-3 text-sm text-ink-soft">
        Tell us who is staying in each room. You choose the number of rooms with the price.
        {childMaxAge !== null ? ` Children are aged ${childMaxAge} or under.` : ''}
      </p>
    </form>
  );
}
