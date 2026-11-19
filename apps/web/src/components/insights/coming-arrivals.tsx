'use client';

import { useId, useState } from 'react';
import { diffDays } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Badge, Card, Notice, Spinner } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { CHANNEL_NAMES, SOURCE_LABELS, formatDay, formatWeekday, plural } from '@/lib/format';
import { useLive } from '@/lib/live';
import { RISK_DAYS, useArrivalRisks } from './arrival-risks';
import { RiskMarker } from './risk-marker';
import type { ArrivalRisk } from './types';

/** More rows than this would bury the board above; the reservations list has the rest. */
const MOST_SHOWN = 100;

const worse = (arrival: ArrivalRisk) => Math.max(arrival.cancellation, arrival.noShow);

/** Where the booking came from: the booking site by name when the server knows which one. */
function Source({ source }: { source: string }) {
  const site = CHANNEL_NAMES[source.toUpperCase()] ?? (source === 'ota' ? 'Booking site' : null);
  return <Badge tone={site ? 'info' : 'neutral'}>{site ?? SOURCE_LABELS[source] ?? source}</Badge>;
}

/**
 * Who is due after today on the front desk: the arrivals of the coming days, with a marker on
 * those less sure than most to go ahead. Today's arrivals carry the same marker on the board.
 */
export function ComingArrivals({
  propertyId,
  hotelDay,
  onOpen,
}: {
  propertyId: string;
  /** The day the board above is for: its arrivals are left out here. */
  hotelDay: string;
  onOpen: (arrival: Pick<ArrivalRisk, 'reservationId' | 'code' | 'guestName'>) => void;
}) {
  const headingId = useId();
  const { allowed, arrivals, error, mutate } = useArrivalRisks(propertyId);
  const [everyone, setEveryone] = useState(false);
  useLive(/^reservation\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || !e.propertyId || e.propertyId === propertyId))
      void mutate();
  });
  if (!allowed) return null;

  const coming = (arrivals ?? [])
    .filter((arrival) => arrival.checkIn > hotelDay)
    .sort(
      (a, b) =>
        a.checkIn.localeCompare(b.checkIn) ||
        worse(b) - worse(a) ||
        a.guestName.localeCompare(b.guestName),
    );
  const marked = coming.filter((arrival) => arrival.level !== 'low');
  const unmarked = coming.length - marked.length;
  const listed = everyone ? coming : marked;
  const shown = listed.slice(0, MOST_SHOWN);

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-sm font-semibold text-ink">
          Arriving in the coming days
        </h2>
        {arrivals && <Badge>{coming.length}</Badge>}
        <span className="text-xs text-ink-faint">The next {RISK_DAYS} days</span>
        {/* One button for showing and hiding, so that the keyboard stays on it either way. */}
        {unmarked > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setEveryone(!everyone)}
          >
            {!everyone
              ? `Show all ${coming.length}`
              : marked.length > 0
                ? 'Show only the less certain'
                : 'Hide the list'}
          </Button>
        )}
      </div>
      {error && !arrivals ? (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>The coming arrivals could not be loaded. {errorMessage(error)}</span>
            <Button size="sm" onClick={() => void mutate()}>
              Try again
            </Button>
          </div>
        </Notice>
      ) : !arrivals ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Loading…
        </div>
      ) : (
        <Card className="overflow-hidden text-[13px]">
          {coming.length === 0 ? (
            <p className="px-3 py-3 text-ink-soft">No one is due to arrive in the coming days.</p>
          ) : (
            <>
              {shown.length > 0 && (
                <ul className="divide-y divide-line">
                  {shown.map((arrival) => (
                    <li key={arrival.reservationId}>
                      {/* Two lines on a phone, one row from there up. */}
                      <div
                        onClick={() => onOpen(arrival)}
                        className="flex cursor-pointer flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-sunken/60 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3"
                      >
                        <div className="flex min-w-0 items-center gap-x-3 sm:contents">
                          <span className="w-24 shrink-0 text-ink-soft">
                            {formatWeekday(arrival.checkIn)}
                          </span>
                          <button
                            type="button"
                            className="min-w-0 truncate rounded-sm text-left text-sm font-semibold text-ink underline-offset-2 hover:underline"
                          >
                            {arrival.guestName}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
                          <span className="font-mono text-xs text-ink-soft">{arrival.code}</span>
                          <Source source={arrival.source} />
                          <span className="text-ink-soft">
                            {plural(diffDays(arrival.checkIn, arrival.checkOut), 'night')}, until{' '}
                            {formatDay(arrival.checkOut)}
                          </span>
                          <span className="empty:hidden sm:ml-auto">
                            <RiskMarker risk={arrival} guestName={arrival.guestName} />
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {listed.length > shown.length && (
                <p className="border-t border-line px-3 py-2.5 text-ink-soft">
                  These are the first {MOST_SHOWN}. The rest are under Reservations.
                </p>
              )}
              {!everyone && unmarked > 0 && (
                <p
                  className={
                    marked.length > 0
                      ? 'border-t border-line px-3 py-2.5 text-ink-soft'
                      : 'px-3 py-2.5 text-ink-soft'
                  }
                >
                  {marked.length > 0
                    ? `${unmarked === 1 ? 'The other arrival has' : `The other ${unmarked} arrivals have`} no marker: nothing in ${unmarked === 1 ? 'that booking' : 'those bookings'} points to a cancellation or a guest not turning up.`
                    : coming.length === 1
                      ? 'One arrival, and nothing in the booking points to a cancellation or a guest not turning up.'
                      : `${coming.length} arrivals, and nothing in the bookings points to a cancellation or a guest not turning up.`}
                </p>
              )}
            </>
          )}
        </Card>
      )}
    </section>
  );
}
