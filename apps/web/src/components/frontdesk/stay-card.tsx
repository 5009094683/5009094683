'use client';

import {
  AlertTriangle,
  BedDouble,
  CalendarDays,
  Clock,
  LogIn,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  Undo2,
} from 'lucide-react';
import { balanceText, BALANCE_TEXT_TONES } from '@/components/folio/labels';
import { RiskMarker } from '@/components/insights/risk-marker';
import type { ReservationRisk } from '@/components/insights/types';
import { Button } from '@/components/ui/button';
import { Badge, Menu, MenuItem } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { CHANNEL_NAMES, formatDay } from '@/lib/format';
import {
  HOUSEKEEPING_LABELS,
  HOUSEKEEPING_TONES,
  guestCount,
  roomLabel,
  stayDates,
} from './labels';
import type { BoardList, Stay } from './types';

/** One room of a reservation on the front desk board. Clicking it opens the reservation. */
export function StayCard({
  stay,
  list,
  hotelDay,
  risk,
  roomsOfBooking,
  canOperate,
  canSeeBill,
  busy,
  onOpen,
  onCheckIn,
  onCheckOut,
  onUndoCheckIn,
}: {
  stay: Stay;
  list: BoardList;
  hotelDay: string;
  /** How likely the booking is to fall through, where that has been worked out. */
  risk?: ReservationRisk;
  /** How many rooms of the same booking are on the board. */
  roomsOfBooking: number;
  /** Whether the user may check guests in and out. */
  canOperate: boolean;
  /** Whether the user may read folios; without it the balance is left out. */
  canSeeBill: boolean;
  /** True while something is being done to this room. */
  busy: boolean;
  onOpen: () => void;
  onCheckIn: () => void;
  onCheckOut: () => void;
  onUndoCheckIn: () => void;
}) {
  const balance = stay.balance === null ? null : balanceText(stay.balance, stay.currency);
  const channel = stay.channelCode ? (CHANNEL_NAMES[stay.channelCode] ?? stay.channelCode) : null;
  const overdue =
    list === 'arrivals' && stay.checkIn < hotelDay
      ? `Was due ${formatDay(stay.checkIn)}`
      : list === 'departures' && stay.checkOut < hotelDay
        ? `Was due out ${formatDay(stay.checkOut)}`
        : null;

  return (
    <div
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-1.5 px-3 py-3 text-[13px] transition-colors hover:bg-sunken/60"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            className="max-w-full truncate rounded-sm text-left text-sm font-semibold text-ink underline-offset-2 hover:underline"
          >
            {stay.guestName}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-ink-soft">{stay.code}</span>
            {roomsOfBooking > 1 && <Badge>{roomsOfBooking} rooms</Badge>}
            {channel && <Badge tone="info">{channel}</Badge>}
            {stay.overbooked && (
              <Badge tone="danger">
                <AlertTriangle className="size-3" aria-hidden /> Overbooked
              </Badge>
            )}
            {stay.needsReview && <Badge tone="warning">Needs review</Badge>}
            {list === 'arrivals' && risk && <RiskMarker risk={risk} guestName={stay.guestName} />}
          </div>
        </div>
        {canOperate && (
          <div className="shrink-0" onClick={(event) => event.stopPropagation()}>
            {list === 'arrivals' && (
              <Button
                size="sm"
                variant="primary"
                icon={<LogIn className="size-3.5" />}
                onClick={onCheckIn}
                aria-label={`Check in ${stay.guestName}`}
              >
                Check in
              </Button>
            )}
            {list === 'departures' && (
              <Button
                size="sm"
                variant="primary"
                icon={<LogOut className="size-3.5" />}
                onClick={onCheckOut}
                aria-label={`Check out ${stay.guestName}`}
              >
                Check out
              </Button>
            )}
            {list === 'inHouse' && (
              <Menu
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    loading={busy}
                    aria-label={`Actions for ${stay.guestName}`}
                  >
                    {!busy && <MoreHorizontal className="size-4" />}
                  </Button>
                }
              >
                <MenuItem icon={<LogOut />} onSelect={onCheckOut}>
                  Check out early
                </MenuItem>
                <MenuItem icon={<Undo2 />} onSelect={onUndoCheckIn}>
                  Undo check-in
                </MenuItem>
              </Menu>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
        <BedDouble className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span>
          {stay.roomTypeName} ·{' '}
          {stay.unitName ? (
            <span className="font-medium">{roomLabel(stay.unitName)}</span>
          ) : (
            <span className="text-warning-700">No room yet</span>
          )}
        </span>
        {list === 'arrivals' && stay.unitHousekeeping && (
          <Badge tone={HOUSEKEEPING_TONES[stay.unitHousekeeping]}>
            {HOUSEKEEPING_LABELS[stay.unitHousekeeping]}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-soft">
        <CalendarDays className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span>
          {stayDates(stay.checkIn, stay.checkOut)} · {guestCount(stay.adults, stay.children)}
        </span>
        {overdue && <Badge tone="warning">{overdue}</Badge>}
      </div>

      {list === 'arrivals' && stay.arrivalTime && (
        <div className="flex items-center gap-2 text-ink-soft">
          <Clock className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span>Arrival time: {stay.arrivalTime}</span>
        </div>
      )}
      {stay.specialRequests && (
        <div className="flex items-start gap-2 text-ink-soft">
          <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span className="line-clamp-2">{stay.specialRequests}</span>
        </div>
      )}

      {canSeeBill && balance && (
        <p className={cn('font-medium', BALANCE_TEXT_TONES[balance.tone])}>
          {balance.text}
          {roomsOfBooking > 1 && stay.balance !== 0 && (
            <span className="font-normal text-ink-faint"> for the whole booking</span>
          )}
        </p>
      )}
    </div>
  );
}
