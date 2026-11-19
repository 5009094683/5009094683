'use client';

import { CalendarClock, ChevronDown } from 'lucide-react';
import { useId } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatWeekday, plural } from '@/lib/format';
import { useStoredState } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { Property } from '@/lib/types';
import type { HousekeepingForecast } from './types';

const DAYS = 7;

/**
 * What the forecast counts for a clean when the property sets no times of its own, and the
 * working day it divides by. They mirror `housekeepingForecast` in `packages/ai/src/insights.ts`
 * and are only used to say how the figures come about.
 */
const DEPARTURE_MINUTES = 45;
const STAYOVER_MINUTES = 20;
const WORKING_HOURS = 7;

/** `45 min`, `3 h`, `4 h 40 min` */
function workTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The cleaning work of the coming week on the housekeeping screen: one line that names the
 * busiest day, opening to each day's departures, stay-overs, arrivals, time and housekeepers.
 */
export function CleaningForecast({
  property,
  hotelDay,
}: {
  property: Property;
  /**
   * The day the housekeeping board is showing. The forecast starts at the calendar day, which is
   * a day further on until the night audit has run, so "Today" is only said of the board's day.
   */
  hotelDay: string;
}) {
  const auth = useAuth();
  const panelId = useId();
  const allowed = auth.can('housekeeping.read', property.id);
  const [open, setOpen] = useStoredState('pms.housekeeping.forecast', false);
  const {
    data: forecast,
    error,
    isValidating,
    mutate,
  } = useSWR<HousekeepingForecast>(
    allowed ? `/properties/${property.id}/insights/housekeeping?days=${DAYS}` : null,
  );
  useLive(/^reservation\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || !e.propertyId || e.propertyId === property.id))
      void mutate();
  });
  if (!allowed) return null;

  const busiest = forecast?.days.find((day) => day.date === forecast.busiest);

  return (
    <Card className="mb-4 text-[13px]">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl px-3 py-2 text-left sm:px-4"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-ink">
            <CalendarClock className="size-4 shrink-0 text-ink-faint" aria-hidden />
            Cleaning ahead
          </span>
          <span className="font-normal text-ink-soft">
            {forecast
              ? busiest
                ? `Busiest of the next ${DAYS} days: ${formatWeekday(busiest.date)}, about ${workTime(busiest.minutes)} of cleaning for ${plural(busiest.staff, 'housekeeper')}`
                : `No departures or stay-overs in the next ${DAYS} days`
              : error
                ? 'The forecast could not be loaded'
                : 'Loading…'}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-brand-700">
            {open ? 'Hide the days' : 'Show each day'}
            <ChevronDown
              className={cn('size-4 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </span>
        </button>
      </h2>
      {open && (
        <div id={panelId} className="border-t border-line px-3 py-3 sm:px-4">
          {forecast ? (
            <>
              <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
                {forecast.days.map((day) => (
                  <li
                    key={day.date}
                    className={cn(
                      'grid grid-cols-[minmax(0,1fr)_auto] content-start gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 lg:grid-cols-1',
                      day.date === forecast.busiest
                        ? 'border-warning-500 bg-warning-50'
                        : 'border-line',
                    )}
                  >
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium text-ink">
                      {formatWeekday(day.date)}
                      {day.date === hotelDay && <Badge>Today</Badge>}
                      {day.date === forecast.busiest && <Badge tone="warning">Busiest</Badge>}
                    </p>
                    <p className="tabular text-right font-semibold text-ink lg:order-2 lg:text-left">
                      {day.minutes > 0 ? workTime(day.minutes) : 'Nothing to clean'}
                    </p>
                    <p className="flex flex-wrap gap-x-2.5 text-ink-soft lg:order-4 lg:flex-col">
                      <span>{plural(day.departures, 'departure')}</span>
                      <span>{plural(day.stayovers, 'stay-over')}</span>
                      <span>{plural(day.arrivals, 'arrival')}</span>
                    </p>
                    <p className="text-right text-ink-soft lg:order-3 lg:text-left">
                      {day.minutes > 0 && plural(day.staff, 'housekeeper')}
                    </p>
                  </li>
                ))}
              </ol>
              <p className="mt-2.5 text-xs text-ink-faint">
                An estimate from the bookings as they stand:{' '}
                {property.settings.departureCleanMinutes ?? DEPARTURE_MINUTES} minutes for each
                departure and {property.settings.stayoverCleanMinutes ?? STAYOVER_MINUTES} for each
                stay-over, with one housekeeper for every {WORKING_HOURS} hours of cleaning.
                Arrivals add no cleaning; they show how many rooms must be ready.
              </p>
            </>
          ) : error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-warning-700">
              <span>{errorMessage(error)}</span>
              <Button size="sm" loading={isValidating} onClick={() => void mutate()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-ink-faint">
              <Spinner /> Loading…
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
