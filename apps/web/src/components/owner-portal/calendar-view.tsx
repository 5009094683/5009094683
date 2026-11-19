'use client';

import { ChevronLeft, ChevronRight, House } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { addDays, diffDays } from '@pms/domain/shared';
import { ConfirmDialog } from '@/components/owners/confirm-dialog';
import { KeepFocus } from '@/components/owners/keep-focus';
import { money } from '@/components/owners/money';
import {
  contractState,
  isMonth,
  localToday,
  monthBounds,
  monthKey,
  monthLabel,
  shiftMonth,
  villaName,
} from '@/components/owners/words';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Card, EmptyState, ErrorState, Notice, PageLoading } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatStay, formatWeekday } from '@/lib/format';
import { latestDeparture, nightKinds, ofVilla, type NightKind } from './days';
import { KIND_STYLES, MonthGrid } from './month-grid';
import { PortalProblem } from './portal-frame';
import { StayForm } from './stay-form';
import type { Block, Calendar, Overview, Stay, TakenDates, Villa } from './types';
import { endedOn, nightsText, sourceWords, stayDates } from './words';

/** How far ahead the owner's own stays are listed. */
const AHEAD_DAYS = 366;

const LEGEND: { kind: NightKind; label: string }[] = [
  { kind: 'free', label: 'Free' },
  { kind: 'guests', label: 'Guests staying' },
  { kind: 'own', label: 'Your own stay' },
  { kind: 'closed', label: 'Not available' },
];

function Legend() {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-ink-soft">
        {LEGEND.map(({ kind, label }) => (
          <li key={kind} className="flex items-center gap-1.5">
            <span className={cn('size-4 shrink-0 rounded', KIND_STYLES[kind])} aria-hidden />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[13px] text-ink-faint">
        Each day stands for the night that starts on it: guests leave on the morning of the first
        free day. Not available means the villa is closed for another reason, such as repairs.
      </p>
    </div>
  );
}

const STAY_STATUS: Record<Stay['status'], string> = {
  confirmed: 'Booked',
  in_house: 'Staying now',
  checked_out: 'Stayed',
};

/** Everything on a villa in one month, in date order: guests, the owner's stays, other closures. */
function Agenda({
  villa,
  month,
  today,
  stays,
  blocks,
}: {
  villa: Villa;
  month: string;
  today: string;
  stays: Stay[];
  blocks: Block[];
}) {
  const { start, end } = monthBounds(month);
  const home = villa.unitName ?? villa.propertyName;
  const share = villa.model === 'revenue_share';
  const rows = [
    ...stays
      .filter((stay) => stay.checkIn < end && stay.checkOut > start)
      .map((stay, index) => ({
        key: `stay-${index}`,
        kind: 'guests' as NightKind,
        title: 'Guests',
        from: stay.checkIn,
        to: stay.checkOut,
        detail: [
          sourceWords(stay.source),
          stay.unitName && stay.unitName !== home ? stay.unitName : null,
          STAY_STATUS[stay.status],
        ],
        revenue: share ? stay.revenue : null,
      })),
    ...blocks
      .filter((block) => block.startDate < end && block.endDate > start)
      .map((block) => ({
        key: block.id,
        kind: (block.kind === 'owner_stay' ? 'own' : 'closed') as NightKind,
        title: block.kind === 'owner_stay' ? 'Your own stay' : 'Not available',
        from: block.startDate,
        to: block.endDate,
        detail: [
          block.unitName && block.unitName !== home ? block.unitName : null,
          block.kind === 'owner_stay' && !block.own ? 'Arranged by the office' : null,
        ],
        revenue: null,
      })),
  ].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">In {monthLabel(month)}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">
          {end <= today
            ? `Nothing was booked in ${monthLabel(month)}, and no dates were closed.`
            : `Nothing is booked in ${monthLabel(month)} so far, and no dates are closed.`}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {rows.map((row) => (
            <li key={row.key} className="flex items-start gap-3 py-2.5 text-sm">
              <span
                className={cn('mt-0.5 size-4 shrink-0 rounded', KIND_STYLES[row.kind])}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-ink">
                  <span className="font-medium">{row.title}</span>, {formatStay(row.from, row.to)}
                </p>
                <p className="text-[13px] text-ink-soft">
                  {[nightsText(diffDays(row.from, row.to)), ...row.detail]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {row.revenue !== null && (
                <p className="shrink-0 text-right">
                  <span className="tabular block text-ink">
                    {money(row.revenue, villa.currency)}
                  </span>
                  <span className="block text-[13px] text-ink-faint">room revenue</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {share && rows.some((row) => row.revenue !== null) && (
        <p className="mt-2 text-[13px] text-ink-faint">
          Room revenue is for the whole stay, before tax, commission and the management fee.
        </p>
      )}
    </Card>
  );
}

/** The owner's own stays still to come, with the way to give the dates back. */
function OwnStays({
  blocks,
  today,
  failed,
  onCancelled,
}: {
  /** The owner's stays that have not ended; undefined until loaded. */
  blocks: Block[] | undefined;
  today: string;
  failed: boolean;
  onCancelled: (block: Block) => void;
}) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState<Block | null>(null);

  return (
    <Card className="p-4 sm:p-5">
      <KeepFocus label="Your stays">
        <h2 className="text-sm font-semibold text-ink">Your stays</h2>
        {!blocks ? (
          <p className="mt-2 text-sm text-ink-soft">
            {failed ? 'Your stays could not be loaded.' : 'Loading…'}
          </p>
        ) : blocks.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">You have no stay of your own coming up.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {blocks.map((block) => {
              const begun = block.startDate <= today;
              return (
                <li
                  key={block.id}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {formatStay(block.startDate, block.endDate)}
                    </p>
                    <p className="text-[13px] text-ink-soft">
                      {nightsText(diffDays(block.startDate, block.endDate))}
                      {!block.own
                        ? ' · arranged by the office, which can change it for you'
                        : begun
                          ? ' · already begun: ask the office to change it'
                          : ''}
                    </p>
                  </div>
                  {block.own && !begun && (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      aria-label={`Cancel your stay of ${formatStay(block.startDate, block.endDate)}`}
                      onClick={() => setCancelling(block)}
                    >
                      Cancel stay
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </KeepFocus>

      {cancelling && (
        <ConfirmDialog
          title="Cancel your stay?"
          confirmLabel="Cancel stay"
          dismissLabel="Keep the stay"
          onClose={() => setCancelling(null)}
          onConfirm={async () => {
            await api(`/owner/stays/${cancelling.id}`, { method: 'DELETE' });
            setCancelling(null);
            toast.success(
              'Your stay is cancelled',
              'The villa is open to guests again on those nights.',
            );
            onCancelled(cancelling);
          }}
        >
          <p>
            You give back{' '}
            <span className="font-medium text-ink">
              {stayDates(cancelling.startDate, cancelling.endDate)}
            </span>
            , {nightsText(diffDays(cancelling.startDate, cancelling.endDate))}. The villa opens to
            guests again on those nights, and they no longer count towards your nights for the year.
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function VillaCalendar({
  villa,
  month,
  today,
  onMonth,
  onChanged,
}: {
  villa: Villa;
  month: string;
  today: string;
  onMonth: (month: string) => void;
  /** Called when the owner's nights for the year have changed. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [dates, setDates] = useState({ arrival: '', departure: '' });
  const takeCard = useRef<HTMLDivElement>(null);
  const state = contractState(villa, today);
  const first = monthKey(villa.startsOn);
  const last = villa.endsOn ? monthKey(villa.endsOn) : null;
  const { start, end } = monthBounds(month);
  const thisMonth = monthKey(today);
  // Only offered when the contract covers this month: otherwise it would lead nowhere.
  const todayInReach = thisMonth >= first && (last === null || thisMonth <= last);

  // The months either side are loaded too, so a stay that runs over a month end can be chosen.
  const from = monthBounds(shiftMonth(month, -1)).start;
  const to = monthBounds(shiftMonth(month, 1)).end;
  const grid = useSWR<Calendar>(`/owner/calendar?from=${from}&to=${to}`);
  const ahead = useSWR<Calendar>(`/owner/calendar?from=${today}&to=${addDays(today, AHEAD_DAYS)}`);

  const { stays, blocks } = useMemo(() => ofVilla(grid.data, villa.id), [grid.data, villa.id]);
  const kinds = useMemo(
    () => nightKinds(villa, grid.data, stays, blocks, from, to),
    [villa, grid.data, stays, blocks, from, to],
  );
  const ownStays = ahead.data
    ? ofVilla(ahead.data, villa.id).blocks.filter((block) => block.kind === 'owner_stay')
    : undefined;

  const canTake = state !== 'ended' && villa.ownerNightsPerYear !== 0;
  const choosingDeparture = dates.arrival !== '' && dates.departure === '';
  const limit = choosingDeparture ? latestDeparture(kinds, dates.arrival, to) : '';
  // Once the arrival is chosen, the days up to the next night that is not free can be the
  // departure. Any other free day starts the choice again from there.
  const canLeaveOn = (date: string) => choosingDeparture && date > dates.arrival && date <= limit;
  const pickable = (date: string): boolean => {
    if (!canTake || date < today) return false;
    return canLeaveOn(date) || kinds.get(date) === 'free';
  };
  const pick = (date: string) => {
    if (canLeaveOn(date)) {
      setDates({ arrival: dates.arrival, departure: date });
      // On a phone the form is below the calendar: bring the button that confirms into view.
      requestAnimationFrame(() => takeCard.current?.scrollIntoView({ block: 'nearest' }));
    } else {
      setDates({ arrival: date, departure: '' });
    }
  };
  const chosenNights =
    dates.arrival !== '' && dates.departure > dates.arrival
      ? diffDays(dates.arrival, dates.departure)
      : 0;

  const taken = (block: TakenDates) => {
    const mine: Block = {
      id: block.id,
      contractId: villa.id,
      unitId: block.unitId,
      unitName: block.unitId === villa.unitId ? villa.unitName : null,
      startDate: block.startDate,
      endDate: block.endDate,
      kind: 'owner_stay',
      own: true,
    };
    // Shown at once from what the server answered, then read again to be sure.
    const withMine = (current: Calendar | undefined) =>
      current && { ...current, blocks: [...current.blocks, mine] };
    void grid.mutate(withMine, { revalidate: true });
    void ahead.mutate(withMine, { revalidate: true });
    onChanged();
    setDates({ arrival: '', departure: '' });
    toast.success(
      'The dates are yours',
      `${formatStay(block.startDate, block.endDate)}, ${nightsText(diffDays(block.startDate, block.endDate))}.`,
    );
    // Show the month the stay starts in, if another one was open.
    if (monthKey(block.startDate) !== month) onMonth(monthKey(block.startDate));
  };
  const cancelled = (block: Block) => {
    const without = (current: Calendar | undefined) =>
      current && { ...current, blocks: current.blocks.filter((b) => b.id !== block.id) };
    void grid.mutate(without, { revalidate: true });
    void ahead.mutate(without, { revalidate: true });
    onChanged();
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
      <Card className="p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <h2 className="text-base font-semibold text-ink" aria-live="polite">
            {monthLabel(month)}
          </h2>
          <div className="flex items-center gap-1">
            {month !== thisMonth && todayInReach && (
              <Button size="sm" onClick={() => onMonth(thisMonth)}>
                Today
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous month"
              disabled={month <= first}
              onClick={() => onMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next month"
              disabled={last !== null && month >= last}
              onClick={() => onMonth(shiftMonth(month, 1))}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
        {grid.error && !grid.data ? (
          <ErrorState error={grid.error} onRetry={() => void grid.mutate()} />
        ) : (
          <>
            <MonthGrid
              monthStart={start}
              monthEnd={end}
              kinds={kinds}
              today={today}
              arrival={dates.arrival}
              departure={dates.departure}
              leaveBy={limit}
              pickable={pickable}
              onPick={pick}
            />
            {canTake && (
              <p className="mt-2 text-[13px] text-ink-soft">
                {chosenNights > 0
                  ? `${stayDates(dates.arrival, dates.departure)}, ${nightsText(chosenNights)}. Confirm with \u201cTake these dates\u201d.`
                  : dates.arrival !== ''
                    ? `Arriving ${formatWeekday(dates.arrival)}. Now tap the day you leave.`
                    : 'To take dates for yourself, tap the day you arrive, then the day you leave.'}
              </p>
            )}
            <Legend />
          </>
        )}
      </Card>

      <div className="flex flex-col gap-4 lg:row-span-2">
        <Card ref={takeCard} className="scroll-mb-4 p-4 sm:p-5">
          <h2 className="mb-2 text-sm font-semibold text-ink">Take dates for yourself</h2>
          {state === 'ended' ? (
            <p className="text-sm text-ink-soft">
              Your contract for this villa ended on {endedOn(villa, today)}, so dates can no longer
              be taken here.
            </p>
          ) : villa.ownerNightsPerYear === 0 ? (
            <p className="text-sm text-ink-soft">
              Your contract does not include stays of your own. Ask the office if you would like to
              stay.
            </p>
          ) : (
            <StayForm
              villa={villa}
              today={today}
              kinds={kinds}
              arrival={dates.arrival}
              departure={dates.departure}
              onDates={(arrival, departure) => setDates({ arrival, departure })}
              onTaken={taken}
            />
          )}
        </Card>
        <OwnStays
          blocks={ownStays}
          today={today}
          failed={Boolean(ahead.error) && !ahead.data}
          onCancelled={cancelled}
        />
      </div>

      {grid.data && (
        <Agenda villa={villa} month={month} today={today} stays={stays} blocks={blocks} />
      )}
    </div>
  );
}

function CalendarPage() {
  const pathname = usePathname();
  const params = useSearchParams();
  const today = localToday();
  const { data, error, isLoading, mutate } = useSWR<Overview>('/owner/overview');

  // The address is read and written directly, not through the router, so that a change of
  // month does not ask the server for the page again.
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const text = next.toString();
    window.history.replaceState(null, '', text ? `${pathname}?${text}` : pathname);
  };

  if (error && !data) return <PortalProblem error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <PageLoading label="Loading your calendar" />;
  if (data.contracts.length === 0) {
    return (
      <EmptyState
        icon={<House className="size-5" />}
        title="No villa is linked to you yet"
        description="Once the office has recorded the contract for your villa, its calendar appears here."
      />
    );
  }

  // The villas with a contract running come first, those whose contract has ended last.
  const rank = { current: 0, upcoming: 1, ended: 2 };
  const villas = [...data.contracts].sort(
    (a, b) => rank[contractState(a, today)] - rank[contractState(b, today)],
  );
  const villa = villas.find((v) => v.id === params.get('villa')) ?? villas[0]!;
  const state = contractState(villa, today);

  // The month asked for, kept inside the months the contract covers.
  const first = monthKey(villa.startsOn);
  const last = villa.endsOn ? monthKey(villa.endsOn) : null;
  const asked = params.get('month');
  const wanted = isMonth(asked) ? asked : monthKey(today);
  const month = wanted < first ? first : last && wanted > last ? last : wanted;

  return (
    <div className="flex flex-col gap-4">
      {villas.length > 1 ? (
        <Field label="Villa" className="sm:max-w-sm">
          {(props) => (
            <Select
              {...props}
              value={villa.id}
              onChange={(event) => {
                change('villa', event.target.value);
                change('month', '');
              }}
            >
              {villas.map((v) => (
                <option key={v.id} value={v.id}>
                  {villaName(v)}
                  {contractState(v, today) === 'ended' ? ' (contract ended)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <p className="text-sm font-medium text-ink">{villaName(villa)}</p>
      )}

      {state === 'ended' && (
        <Notice tone="info">
          Your contract for this villa ended on {endedOn(villa, today)}. The calendar shows it up to
          then.
        </Notice>
      )}
      {state === 'upcoming' && (
        <Notice tone="info">
          Your contract for this villa starts on {formatDate(villa.startsOn)}. The calendar shows it
          from then.
        </Notice>
      )}

      <VillaCalendar
        key={villa.id}
        villa={villa}
        month={month}
        today={today}
        onMonth={(next) => change('month', next === monthKey(today) ? '' : next)}
        onChanged={() => void mutate()}
      />
    </div>
  );
}

/** One villa's nights, a month at a time, and the way for the owner to take some for themselves. */
export function CalendarView() {
  return (
    <Suspense fallback={<PageLoading />}>
      <CalendarPage />
    </Suspense>
  );
}
