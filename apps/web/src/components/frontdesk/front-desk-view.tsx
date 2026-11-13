'use client';

import { ConciergeBell, DoorOpen, LogIn, LogOut, Search } from 'lucide-react';
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { todayIn } from '@pms/domain/shared';
import { scrollToBill } from '@/components/folio/folio-section';
import { ReservationPanel } from '@/components/reservations/reservation-panel';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import { Input, Segmented, Select } from '@/components/ui/field';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  PageLoading,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDate, formatDay, formatWeekdayName } from '@/lib/format';
import { useCurrentProperty } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { CheckInDialog } from './check-in-dialog';
import { CheckOutDialog } from './check-out-dialog';
import { StayCard } from './stay-card';
import type { Board, BoardList, Stay } from './types';

const LISTS: { value: BoardList; title: string; caption: string; icon: ReactNode }[] = [
  {
    value: 'arrivals',
    title: 'Arrivals',
    caption: 'Due to check in',
    icon: <LogIn className="size-5" />,
  },
  {
    value: 'departures',
    title: 'Departures',
    caption: 'Due to check out',
    icon: <LogOut className="size-5" />,
  },
  {
    value: 'inHouse',
    title: 'In house',
    caption: 'Staying on',
    icon: <DoorOpen className="size-5" />,
  },
];

function matches(stay: Stay, term: string): boolean {
  return [stay.guestName, stay.code, stay.unitName, stay.roomTypeName].some((text) =>
    text?.toLowerCase().includes(term),
  );
}

/** Rooms of one booking next to each other, in the order the booking first appears. */
function byBooking(stays: Stay[]): Stay[][] {
  const groups = new Map<string, Stay[]>();
  for (const stay of stays) {
    const group = groups.get(stay.reservationId);
    if (group) group.push(stay);
    else groups.set(stay.reservationId, [stay]);
  }
  return [...groups.values()];
}

function emptyTitle(list: BoardList, board: Board): string {
  if (list === 'arrivals') {
    return board.counts.arrived > 0 ? 'Everyone due today has arrived' : 'No arrivals today';
  }
  if (list === 'departures') {
    return board.counts.departed > 0 ? 'Everyone due out has left' : 'No departures today';
  }
  return 'No guests staying on';
}

function Count({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <Card className="px-3 py-2.5 sm:px-4">
      <p className="text-xs font-medium text-ink-soft">{label}</p>
      <p className="tabular mt-0.5 text-xl font-semibold text-ink">{value}</p>
      <p className="text-xs text-ink-faint">{caption}</p>
    </Card>
  );
}

/** Today's date at the property, recomputed every minute so that it follows midnight. */
function useToday(timezone: string | undefined): string | null {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return timezone ? todayIn(timezone) : null;
}

/** The front desk board: who is arriving, leaving and staying on the property's hotel day. */
export function FrontDeskView() {
  const auth = useAuth();
  const toast = useToast();
  const { property, properties, select, isLoading: propertiesLoading } = useCurrentProperty();
  // Another hotel's guests must not stay on screen while a newly chosen property loads.
  const {
    data: board,
    error,
    mutate,
  } = useSWR<Board>(property ? `/properties/${property.id}/front-desk` : null, {
    keepPreviousData: false,
  });
  const today = useToday(property?.timezone);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<BoardList>('arrivals');
  const [open, setOpen] = useState<Pick<Stay, 'reservationId' | 'code' | 'guestName'> | null>(null);
  const [checkIn, setCheckIn] = useState<Stay | null>(null);
  const [checkOut, setCheckOut] = useState<Stay | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  useLive(/^(reservation|folio|unit)\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || !e.propertyId || e.propertyId === property?.id))
      void mutate();
  });

  if (propertiesLoading) return <PageLoading />;
  if (!property) {
    return (
      <EmptyState
        icon={<ConciergeBell className="size-5" />}
        title="No properties yet"
        description="Add a property under Settings first."
      />
    );
  }
  const canOperate = auth.can('frontdesk.operate', property.id);
  const canSeeBill = auth.can('folio.read', property.id);
  const term = search.trim().toLowerCase();

  const undoCheckIn = async (stay: Stay) => {
    setUndoing(stay.roomId);
    try {
      await api(`/reservations/${stay.reservationId}/undo-check-in`, {
        body: { roomIds: [stay.roomId] },
      });
      toast.success(`Check-in undone for ${stay.guestName}`, 'The room is back under Arrivals.');
      void mutate();
    } catch (err) {
      toast.error(err);
    } finally {
      setUndoing(null);
    }
  };

  const roomsOnBoard = new Map<string, number>();
  if (board) {
    for (const stay of [...board.arrivals, ...board.departures, ...board.inHouse]) {
      roomsOnBoard.set(stay.reservationId, (roomsOnBoard.get(stay.reservationId) ?? 0) + 1);
    }
  }

  const shown = (list: BoardList): Stay[] =>
    board ? (term ? board[list].filter((stay) => matches(stay, term)) : board[list]) : [];

  return (
    <div className="mx-auto flex max-w-7xl flex-col p-4 sm:p-6">
      <PageHeader
        title="Front desk"
        description={
          board
            ? `Hotel day: ${formatWeekdayName(board.date)} ${formatDate(board.date)}`
            : property.name
        }
        actions={
          properties.length > 1 && (
            <Select
              aria-label="Property"
              value={property.id}
              onChange={(e) => select(e.target.value)}
              className="w-auto"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )
        }
      />

      {error && !board ? (
        <ErrorState error={error} onRetry={() => void mutate()} />
      ) : !board ? (
        <PageLoading />
      ) : (
        <>
          {today !== null && board.date < today && (
            <Notice tone="warning" className="mb-4">
              The hotel day is still {formatDay(board.date)}. It moves on when the night audit runs.
            </Notice>
          )}
          {error && (
            <Notice tone="warning" className="mb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>The board could not be refreshed. {errorMessage(error)}</span>
                <Button size="sm" onClick={() => void mutate()}>
                  Try again
                </Button>
              </div>
            </Notice>
          )}

          <div className="mb-4 grid grid-cols-3 gap-2 sm:gap-4">
            <Count
              label="Arrivals"
              value={`${board.counts.arrived} of ${board.counts.arrived + board.counts.arrivals}`}
              caption="arrived"
            />
            <Count
              label="Departures"
              value={`${board.counts.departed} of ${board.counts.departed + board.counts.departures}`}
              caption="departed"
            />
            <Count
              label="In house"
              value={String(board.counts.inHouse)}
              caption={board.counts.inHouse === 1 ? 'room occupied' : 'rooms occupied'}
            />
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative min-w-56 flex-1 sm:max-w-xs">
              <Search
                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
                aria-hidden
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Guest, booking code or room"
                aria-label="Filter arrivals, departures and guests in house"
                className="pl-8"
              />
            </div>
            <div className="lg:hidden">
              <Segmented
                label="List shown"
                value={tab}
                onChange={setTab}
                options={LISTS.map((list) => ({
                  value: list.value,
                  label: `${list.title} ${shown(list.value).length}`,
                }))}
              />
            </div>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-3">
            {LISTS.map((list) => {
              const stays = shown(list.value);
              const total = board[list.value].length;
              return (
                <section
                  key={list.value}
                  aria-label={list.title}
                  className={cn('min-w-0 flex-col', tab === list.value ? 'flex' : 'hidden lg:flex')}
                >
                  <div className="mb-2 flex items-baseline gap-2">
                    <h2 className="text-sm font-semibold text-ink">{list.title}</h2>
                    <Badge>{term ? `${stays.length} of ${total}` : total}</Badge>
                    <span className="text-xs text-ink-faint">{list.caption}</span>
                  </div>
                  <Card className="overflow-hidden">
                    {stays.length === 0 ? (
                      <EmptyState
                        icon={list.icon}
                        title={
                          term && total > 0
                            ? `Nothing here matches "${search.trim()}"`
                            : emptyTitle(list.value, board)
                        }
                      />
                    ) : (
                      <ul className="divide-y divide-line">
                        {byBooking(stays).map((rooms) => (
                          <li
                            key={rooms[0]!.reservationId}
                            className={cn(rooms.length > 1 && 'border-l-2 border-brand-500')}
                          >
                            {rooms.length > 1 && (
                              <p className="px-3 pt-2 text-xs font-medium text-brand-700">
                                {rooms.length} rooms on one booking
                              </p>
                            )}
                            <div className="divide-y divide-line">
                              {rooms.map((stay) => (
                                <StayCard
                                  key={stay.roomId}
                                  stay={stay}
                                  list={list.value}
                                  hotelDay={board.date}
                                  roomsOfBooking={roomsOnBoard.get(stay.reservationId) ?? 1}
                                  canOperate={canOperate}
                                  canSeeBill={canSeeBill}
                                  busy={undoing === stay.roomId}
                                  onOpen={() => setOpen(stay)}
                                  onCheckIn={() => setCheckIn(stay)}
                                  onCheckOut={() => setCheckOut(stay)}
                                  onUndoCheckIn={() => void undoCheckIn(stay)}
                                />
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </section>
              );
            })}
          </div>
        </>
      )}

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? `Reservation ${open.code}` : 'Reservation'}
        description={open?.guestName}
      >
        {open && (
          <ReservationPanel reservationId={open.reservationId} onChanged={() => void mutate()} />
        )}
      </Drawer>
      {checkIn && board && (
        <CheckInDialog
          reservationId={checkIn.reservationId}
          roomId={checkIn.roomId}
          hotelDay={board.date}
          onClose={() => setCheckIn(null)}
          onDone={() => {
            setCheckIn(null);
            void mutate();
          }}
        />
      )}
      {checkOut && board && (
        <CheckOutDialog
          reservationId={checkOut.reservationId}
          roomId={checkOut.roomId}
          hotelDay={board.date}
          onClose={() => setCheckOut(null)}
          onCheckedOut={() => void mutate()}
          onOpenBill={() => {
            setOpen(checkOut);
            scrollToBill();
          }}
        />
      )}
    </div>
  );
}
