'use client';

import { ArrowRight, House } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import useSWR from 'swr';
import { addDays, diffDays, eachDate, maxDate, minDate, monthOf } from '@pms/domain/shared';
import { money } from '@/components/owners/money';
import {
  contractState,
  feeWords,
  localToday,
  statementMonth,
  villaName,
} from '@/components/owners/words';
import { Badge, Card, EmptyState, PageLoading } from '@/components/ui/misc';
import { formatDate, formatMoney, formatMonth, formatStay, formatWeekday } from '@/lib/format';
import { ofVilla } from './days';
import { PortalProblem } from './portal-frame';
import type { Calendar, Overview, Statement, Villa } from './types';
import { endedOn, nightsText, payment } from './words';

/** How far ahead the overview looks for arrivals. */
const AHEAD_DAYS = 120;

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-soft">{label}</dt>
      <dd className="mt-0.5">
        <span className="tabular block text-xl font-semibold tracking-tight text-ink">{value}</span>
        {note && <span className="block text-[13px] text-ink-faint">{note}</span>}
      </dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-line py-3 sm:flex-row sm:gap-4">
      <dt className="shrink-0 text-[13px] text-ink-soft sm:w-40 sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

function LatestStatement({
  statement,
  ended,
}: {
  statement: Statement | undefined;
  ended: boolean;
}) {
  if (!statement) {
    return (
      <span className="text-ink-soft">
        {ended
          ? 'None has been issued to you for this villa.'
          : 'None yet. One is prepared after each month ends and appears here once the office has issued it.'}
      </span>
    );
  }
  const state = payment(statement);
  return (
    <Link
      href={`/owner/statements/${statement.id}`}
      className="group flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="font-medium text-brand-700 group-hover:underline">
        {statementMonth(statement)}
      </span>
      <span className="tabular">{money(statement.payout, statement.currency)}</span>
      <Badge tone={state.tone}>{state.label}</Badge>
    </Link>
  );
}

/** The owner's own nights this year against what the contract allows, and their next stay. */
function OwnNights({
  villa,
  year,
  next,
}: {
  villa: Villa;
  year: string;
  /** The owner's next stay, when one is coming up in the months the overview looks at. */
  next: { from: string; to: string; own: boolean } | undefined;
}) {
  if (villa.ownerNightsPerYear === 0) {
    return (
      <span className="text-ink-soft">
        Your contract does not include stays of your own. Ask the office if you would like to stay.
      </span>
    );
  }
  return (
    <>
      {villa.ownerNightsPerYear === null
        ? `${nightsText(villa.ownerNightsUsed)} taken in ${year}. Your contract sets no limit.`
        : `${villa.ownerNightsUsed} of ${nightsText(villa.ownerNightsPerYear)} taken in ${year}.`}{' '}
      {next && (
        <>
          Your next stay is{' '}
          <span className="whitespace-nowrap">{formatStay(next.from, next.to)}</span>,{' '}
          {nightsText(diffDays(next.from, next.to))}
          {next.own ? '' : ', arranged by the office'}.{' '}
        </>
      )}
      <Link
        href={`/owner/calendar?villa=${villa.id}`}
        className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-brand-700 hover:underline"
      >
        Take dates for yourself
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>
    </>
  );
}

function VillaCard({
  villa,
  calendar,
  calendarFailed,
  statement,
  today,
}: {
  villa: Villa;
  calendar: Calendar | undefined;
  calendarFailed: boolean;
  statement: Statement | undefined;
  today: string;
}) {
  const state = contractState(villa, today);
  const month = monthOf(today);
  const share = villa.model === 'revenue_share';
  const { stays, blocks } = ofVilla(calendar, villa.id);

  // The nights of this month the contract covers, and those of them with guests in the villa.
  const from = maxDate(month.start, villa.startsOn);
  const to = villa.endsOn ? minDate(month.end, addDays(villa.endsOn, 1)) : month.end;
  const nights = to > from ? diffDays(from, to) : 0;
  const withGuests = calendar
    ? eachDate(from, to > from ? to : from).filter((date) =>
        stays.some((stay) => stay.checkIn <= date && date < stay.checkOut),
      ).length
    : null;

  // What is next in the villa, guests and the owner's own stays together, soonest first.
  const inHouse = stays.filter((stay) => stay.status === 'in_house' && stay.checkOut > today);
  const guestsLeave = inHouse.reduce((latest, stay) => maxDate(latest, stay.checkOut), '');
  const coming = [
    ...stays
      .filter((stay) => stay.checkIn >= today && stay.status === 'confirmed')
      .map((stay, index) => ({
        key: `stay-${index}`,
        from: stay.checkIn,
        nights: stay.nights,
        own: false,
      })),
    ...blocks
      .filter((block) => block.kind === 'owner_stay' && block.startDate >= today)
      .map((block) => ({
        key: block.id,
        from: block.startDate,
        nights: diffDays(block.startDate, block.endDate),
        own: true,
      })),
  ]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .slice(0, 5);
  const nextOwn = blocks
    .filter((block) => block.kind === 'owner_stay' && block.startDate >= today)
    .map((block) => ({ from: block.startDate, to: block.endDate, own: block.own }))
    .sort((a, b) => (a.from < b.from ? -1 : 1))[0];
  const ownNow = blocks.find(
    (block) => block.kind === 'owner_stay' && block.startDate < today && today < block.endDate,
  );
  const monthName = formatMonth(month.start).split(' ')[0];
  const nextMonthName = formatMonth(month.end).split(' ')[0];

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words text-ink">{villaName(villa)}</h2>
          <p className="text-sm text-ink-soft">
            {share ? `Management fee: ${feeWords(villa)}` : feeWords(villa)}
          </p>
        </div>
        {state === 'ended' && <Badge tone="neutral">Contract ended</Badge>}
        {state === 'upcoming' && <Badge tone="info">Not started yet</Badge>}
      </div>

      {state === 'ended' && (
        <p className="mt-4 text-sm text-ink-soft">
          Your contract for this villa ended on {endedOn(villa, today)}, so its bookings are no
          longer shown. The statements issued to you stay under Statements.
        </p>
      )}
      {state === 'upcoming' && (
        <p className="mt-4 text-sm text-ink-soft">
          Your contract for this villa starts on {formatDate(villa.startsOn)}. Its bookings and your
          statements appear here from then.
        </p>
      )}

      {state === 'current' && (
        <>
          <h3 className="mt-5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            {formatMonth(month.start)} so far
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
            <Figure
              label="Nights booked"
              value={villa.thisMonth.nights}
              note={
                withGuests !== null && withGuests !== villa.thisMonth.nights
                  ? 'counting each room let on its own'
                  : `of ${nights} in ${monthName}`
              }
            />
            <Figure
              label="Occupancy"
              value={
                withGuests === null || nights === 0
                  ? calendarFailed
                    ? 'Not known'
                    : '…'
                  : `${Math.round((withGuests / nights) * 100)}%`
              }
              note={
                withGuests !== null && nights > 0
                  ? `${withGuests} of ${nightsText(nights)} with guests`
                  : undefined
              }
            />
            <div className="col-span-2 sm:col-span-1">
              {share ? (
                <Figure
                  label="Room revenue booked"
                  value={formatMoney(villa.thisMonth.revenue, villa.currency)}
                  note="before commission, the management fee and costs"
                />
              ) : (
                <Figure
                  label="Your rent"
                  value={
                    villa.fixedRent === null
                      ? 'Fixed'
                      : formatMoney(villa.fixedRent, villa.currency)
                  }
                  note="a month, whatever the bookings"
                />
              )}
            </div>
          </dl>
          <p className="mt-3 text-[13px] text-ink-faint">
            These count the bookings held for {monthName} today, the nights still to come among
            them. Your statement counts the nights guests actually stayed.
          </p>
        </>
      )}

      <dl className="mt-4">
        {state === 'current' && (
          <>
            <Row label={`${nextMonthName} so far`}>
              {villa.nextMonth.nights === 0
                ? 'No nights booked yet.'
                : `${nightsText(villa.nextMonth.nights)} booked${
                    share
                      ? `, ${formatMoney(villa.nextMonth.revenue, villa.currency)} room revenue`
                      : ''
                  }.`}
            </Row>
            <Row label="Coming up">
              {!calendar ? (
                <span className="text-ink-soft">
                  {calendarFailed ? 'The bookings could not be loaded.' : 'Loading…'}
                </span>
              ) : coming.length === 0 && inHouse.length === 0 && !ownNow ? (
                <span className="text-ink-soft">No arrivals booked yet in the coming months.</span>
              ) : (
                <ul className="flex flex-col gap-1">
                  {inHouse.length > 0 && (
                    <li>Guests are in the villa until {formatWeekday(guestsLeave)}.</li>
                  )}
                  {ownNow && <li>You have the villa until {formatWeekday(ownNow.endDate)}.</li>}
                  {coming.map((item) => (
                    <li key={item.key}>
                      <span className="font-medium">{formatWeekday(item.from)}</span>
                      <span className="text-ink-soft">
                        {' '}
                        · {item.own ? 'your own stay' : 'guests arrive'}, {nightsText(item.nights)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href={`/owner/calendar?villa=${villa.id}`}
                className="mt-1 inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:underline"
              >
                Open the calendar
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </Row>
            <Row label="Your own stays">
              <OwnNights villa={villa} year={today.slice(0, 4)} next={nextOwn} />
            </Row>
          </>
        )}
        <Row label="Latest statement">
          <LatestStatement statement={statement} ended={state === 'ended'} />
        </Row>
      </dl>
    </Card>
  );
}

/** The first page an owner sees: how each villa is doing this month, and what they were last paid. */
export function OverviewView() {
  const today = localToday();
  const { data, error, isLoading, mutate } = useSWR<Overview>('/owner/overview');
  const from = monthOf(today).start;
  const calendar = useSWR<Calendar>(
    data && data.contracts.length > 0
      ? `/owner/calendar?from=${from}&to=${addDays(from, AHEAD_DAYS)}`
      : null,
  );

  if (error && !data) return <PortalProblem error={error} onRetry={() => void mutate()} />;
  if (isLoading || !data) return <PageLoading label="Loading your villa" />;

  if (data.contracts.length === 0) {
    return (
      <EmptyState
        icon={<House className="size-5" />}
        title="No villa is linked to you yet"
        description={`Your sign-in works, ${data.owner.name}, but the office has not recorded a contract for your villa yet. Once it has, the bookings and your monthly statements appear here. Ask the property\u2019s office if you expected to see them.`}
      />
    );
  }

  const rank = { current: 0, upcoming: 1, ended: 2 };
  const villas = [...data.contracts].sort(
    (a, b) => rank[contractState(a, today)] - rank[contractState(b, today)],
  );
  const allEnded = villas.every((villa) => contractState(villa, today) === 'ended');

  return (
    <div className="flex flex-col gap-4">
      {allEnded && (
        <p className="text-sm text-ink-soft">
          You have no contract running at the moment. What was issued to you before is still here.
        </p>
      )}
      {villas.map((villa) => (
        <VillaCard
          key={villa.id}
          villa={villa}
          calendar={calendar.data}
          calendarFailed={Boolean(calendar.error) && !calendar.data}
          statement={data.statements.find((statement) => statement.contractId === villa.id)}
          today={today}
        />
      ))}
    </div>
  );
}
