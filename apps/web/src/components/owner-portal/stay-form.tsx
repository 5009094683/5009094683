'use client';

import { addDays, diffDays, eachDate, isValidDate } from '@pms/domain/shared';
import { KeepFocus } from '@/components/owners/keep-focus';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { plural } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import type { NightKind } from './days';
import type { TakenDates, Villa } from './types';
import { nightsText, stayDates } from './words';

/** What the contract says about the owner's own stays, said before they ask. */
function Rules({ villa, year }: { villa: Villa; year: string }) {
  const allowed = villa.ownerNightsPerYear;
  const used = villa.ownerNightsUsed;
  const left = allowed === null ? null : Math.max(0, allowed - used);
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink-soft">
      <li>
        {villa.ownerStayNoticeDays === 0
          ? 'You can take any free dates, from today on.'
          : `Your contract asks for ${plural(villa.ownerStayNoticeDays, 'day')}\u2019 notice, so choose an arrival at least that far ahead.`}
      </li>
      <li>
        {allowed === null || left === null
          ? `Your contract sets no limit on the nights you take. You have taken ${used} in ${year}.`
          : `Your contract allows ${nightsText(allowed)} a year. You have taken ${used} in ${year}, so ${left} ${
              left === 1 ? 'is' : 'are'
            } left. Nights in another year count towards that year.`}
      </li>
      <li>
        The villa is closed to guests on the nights you take. You can give them back until the day
        before you arrive.
      </li>
    </ul>
  );
}

/**
 * The small form an owner takes dates with. The dates can be typed here or
 * tapped on the calendar; either way the server decides, and its refusal is
 * shown in its own words.
 */
export function StayForm({
  villa,
  today,
  kinds,
  arrival,
  departure,
  onDates,
  onTaken,
}: {
  villa: Villa;
  today: string;
  /** The nights on screen, to warn when a chosen one is not free. */
  kinds: Map<string, NightKind>;
  arrival: string;
  departure: string;
  onDates: (arrival: string, departure: string) => void;
  onTaken: (taken: TakenDates) => void;
}) {
  const ready = isValidDate(arrival) && isValidDate(departure) && departure > arrival;
  const nights = ready ? diffDays(arrival, departure) : 0;
  // Only what is on screen is known here; the server checks every night.
  const taken =
    ready &&
    nights <= 400 &&
    eachDate(arrival, departure).some((date) => {
      const kind = kinds.get(date);
      return kind === 'guests' || kind === 'own' || kind === 'closed';
    });

  const take = useAction(async () => {
    const block = await api<TakenDates>('/owner/stays', {
      body: { contractId: villa.id, from: arrival, to: departure },
    });
    onTaken(block);
  });
  const change = (nextArrival: string, nextDeparture: string) => {
    take.clearError();
    onDates(nextArrival, nextDeparture);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void take.run();
      }}
      className="flex flex-col gap-3"
    >
      <Rules villa={villa} year={today.slice(0, 4)} />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Arrival">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={arrival}
              onChange={(event) => change(event.target.value, departure)}
            />
          )}
        </Field>
        <Field label="Departure">
          {(props) => (
            <Input
              {...props}
              type="date"
              min={isValidDate(arrival) ? addDays(arrival, 1) : undefined}
              value={departure}
              onChange={(event) => change(arrival, event.target.value)}
            />
          )}
        </Field>
      </div>

      <p className="text-sm text-ink" aria-live="polite">
        {ready ? (
          <>
            <span className="font-medium">{nightsText(nights)}</span>,{' '}
            {stayDates(arrival, departure)}
          </>
        ) : isValidDate(arrival) && isValidDate(departure) ? (
          <span className="text-danger-600">The departure must be after the arrival.</span>
        ) : isValidDate(arrival) ? (
          <span className="text-ink-soft">Now choose the day you leave.</span>
        ) : (
          <span className="text-ink-soft">
            Choose your dates on the calendar, or type them here.
          </span>
        )}
      </p>

      {taken && !take.error && (
        <Notice tone="warning">
          Some of these nights are not free on the calendar, so the villa will probably not be yours
          for all of them.
        </Notice>
      )}
      {take.error && (
        <Notice tone="danger" title="These dates could not be taken">
          {take.error}
          {/choose which unit/i.test(take.error) &&
            ' Choosing a unit is not possible here: ask the office to arrange your stay.'}
        </Notice>
      )}

      <KeepFocus label="Take dates" className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={take.busy} disabled={!ready}>
          Take these dates
        </Button>
        {(arrival !== '' || departure !== '') && (
          <Button variant="ghost" onClick={() => change('', '')}>
            Clear
          </Button>
        )}
      </KeepFocus>
    </form>
  );
}
