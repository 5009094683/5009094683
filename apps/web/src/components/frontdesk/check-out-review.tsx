'use client';

import { addDays, diffDays } from '@pms/domain/shared';
import type { Folio, ReservationFolios } from '@/components/folio/types';
import { Checkbox } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { formatMoney, plural } from '@/lib/format';
import type { Reservation, ReservationRoom } from '@/lib/types';
import { roomLabel, stayDates } from './labels';

/** The day a stay ends when the room is checked out now: today, but never before one night is spent. */
export function departureOf(room: ReservationRoom, hotelDay: string): string {
  return hotelDay > room.checkIn ? hotelDay : addDays(room.checkIn, 1);
}

/** Booked nights that have been spent but are not on the bill yet. Check-out charges them. */
function nightsToCharge(
  rooms: ReservationRoom[],
  folios: Folio[],
  hotelDay: string,
): { count: number; amount: number } {
  const charged = new Set(
    folios
      .flatMap((folio) => folio.lines)
      .filter((line) => line.kind === 'room' && !line.voidedAt)
      .map((line) => `${line.reservationRoomId}|${line.businessDate}`),
  );
  let count = 0;
  let amount = 0;
  for (const room of rooms) {
    const departure = departureOf(room, hotelDay);
    for (const night of room.nights) {
      if (night.date < departure && !charged.has(`${room.id}|${night.date}`)) {
        count += 1;
        amount += night.amount;
      }
    }
  }
  return { count, amount };
}

/** What checking out now means for the chosen rooms, shown before anything is done. */
export function CheckOutReview({
  reservation,
  inHouse,
  selected,
  onToggle,
  hotelDay,
  bill,
}: {
  reservation: Reservation;
  inHouse: ReservationRoom[];
  selected: ReservationRoom[];
  onToggle: (roomId: string, on: boolean) => void;
  hotelDay: string;
  /** Absent for a user who may not see folios, or while it loads. */
  bill: ReservationFolios | undefined;
}) {
  const currency = reservation.currency;
  const early = selected.reduce((sum, room) => {
    const departure = departureOf(room, hotelDay);
    return sum + (departure < room.checkOut ? diffDays(departure, room.checkOut) : 0);
  }, 0);
  const late = selected.reduce((sum, room) => {
    const departure = departureOf(room, hotelDay);
    return sum + (departure > room.checkOut ? diffDays(room.checkOut, departure) : 0);
  }, 0);
  const arrivedToday = selected.some((room) => room.checkIn >= hotelDay);
  const toCharge = bill ? nightsToCharge(selected, bill.folios, hotelDay) : null;
  const moreToCome = (toCharge?.count ?? 0) > 0 || late > 0;

  // The bill has to be settled only when no room of the booking is left in house or still to arrive.
  const lastToLeave = reservation.rooms
    .filter((room) => room.status !== 'cancelled' && room.status !== 'no_show')
    .every((room) => room.status === 'checked_out' || selected.some((s) => s.id === room.id));

  const charged = bill?.folios.reduce(
    (sum, folio) => sum + folio.totals.charges + folio.totals.taxes,
    0,
  );
  const paid = bill?.folios.reduce((sum, folio) => sum + folio.totals.payments, 0);

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {inHouse.map((room) => {
          const on = selected.some((s) => s.id === room.id);
          const title = `${room.roomTypeName}${room.unitName ? ` · ${roomLabel(room.unitName)}` : ''}`;
          return (
            <li key={room.id} className="rounded-lg border border-line p-3">
              {inHouse.length > 1 ? (
                <Checkbox
                  className="font-medium"
                  label={title}
                  checked={on}
                  onChange={(e) => onToggle(room.id, e.target.checked)}
                />
              ) : (
                <p className="text-sm font-medium text-ink">{title}</p>
              )}
              <p className={cn('mt-1 text-[13px] text-ink-soft', inHouse.length > 1 && 'pl-6')}>
                {room.guestName ?? reservation.guestName} · {stayDates(room.checkIn, room.checkOut)}
              </p>
            </li>
          );
        })}
      </ul>

      {early > 0 && (
        <Notice tone="info">
          Leaving {plural(early, 'night')} early.{' '}
          {early === 1 ? 'That night goes' : 'Those nights go'} back on sale straight away.
        </Notice>
      )}
      {late > 0 && (
        <Notice tone="info">
          Stayed {plural(late, 'night')} past the booked date. Any of them not yet on the bill{' '}
          {late === 1 ? 'is' : 'are'} charged now, at the current rate.
        </Notice>
      )}
      {arrivedToday && (
        <Notice tone="warning">
          This guest checked in today. The first night is charged all the same. If the check-in was
          a mistake, close this and use Undo check-in instead.
        </Notice>
      )}

      {bill && charged !== undefined && paid !== undefined && (
        <div className="flex flex-col gap-2">
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-md bg-sunken px-3 py-2.5 text-[13px]">
            <dt className="text-ink-soft">Charged so far, with tax</dt>
            <dd className="tabular text-right text-ink">{formatMoney(charged, currency)}</dd>
            <dt className="text-ink-soft">Paid</dt>
            <dd className="tabular text-right text-ink">{formatMoney(paid, currency)}</dd>
            {toCharge && toCharge.count > 0 && (
              <>
                <dt className="text-ink-soft">
                  Still to be charged: {plural(toCharge.count, 'night')}
                </dt>
                <dd className="tabular text-right text-ink">
                  {formatMoney(toCharge.amount, currency)} + tax
                </dd>
              </>
            )}
            <dt className="font-medium text-ink">
              {bill.balance < 0 ? 'In credit now' : 'Balance owed now'}
            </dt>
            <dd
              className={cn(
                'tabular text-right font-semibold',
                bill.balance > 0 ? 'text-danger-700' : 'text-ink',
              )}
            >
              {formatMoney(Math.abs(bill.balance), currency)}
            </dd>
          </dl>
          <p className="text-[13px] text-ink-soft">
            {!lastToLeave
              ? 'Other rooms of this booking are not checked out yet. The bill is settled when the last one leaves.'
              : reservation.paymentCollect === 'channel' && moreToCome
                ? 'The room is paid to the channel: the nights charged at check-out are recorded as paid by it.'
                : moreToCome
                  ? 'Nights not yet charged are added at check-out, so the balance will be higher than shown. If money is owed then, you choose how to settle it before the guest is checked out.'
                  : bill.balance !== 0
                    ? 'The bill is not settled. You choose what to do about it in the next step, before the guest is checked out.'
                    : 'The bill is settled.'}
          </p>
        </div>
      )}
      {!bill && (
        <p className="text-[13px] text-ink-soft">
          Any night not yet charged is added to the bill at check-out.
        </p>
      )}
    </div>
  );
}
