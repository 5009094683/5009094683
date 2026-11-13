'use client';

import { CalendarPlus, ChevronLeft, ChevronRight, Filter, Lock, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { addDays, todayIn } from '@pms/domain/shared';
import {
  ReservationDialog,
  type ReservationPrefill,
} from '@/components/reservations/reservation-dialog';
import { ReservationPanel } from '@/components/reservations/reservation-panel';
import { Button } from '@/components/ui/button';
import { Dialog, Drawer } from '@/components/ui/dialog';
import { Checkbox, Input, Segmented } from '@/components/ui/field';
import { EmptyState, ErrorState, PageLoading, Popover, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatStay, plural } from '@/lib/format';
import { announceRoomChange } from '@/lib/feedback';
import { useProperties, useStoredState } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { CalBlock, CalProperty, CalStay, Calendar, RoomChange } from '@/lib/types';
import { EditBlockDialog, NewBlockDialog, type BlockDraft } from './block-dialog';
import {
  CalendarGrid,
  type RangeSelection,
  type RowTarget,
  type StayChange,
} from './calendar-grid';

type Span = '14' | '30' | '60';
type Zoom = 'compact' | 'normal' | 'wide';
const CELL_WIDTH: Record<Zoom, number> = { compact: 30, normal: 44, wide: 64 };

const LEGEND = [
  { label: 'Direct', className: 'bg-src-direct' },
  { label: 'Booking.com', className: 'bg-src-bdc' },
  { label: 'Airbnb', className: 'bg-src-abb' },
  { label: 'Expedia', className: 'bg-src-exp' },
  { label: 'Agoda', className: 'bg-src-ago' },
  { label: 'MakeMyTrip', className: 'bg-src-mmt' },
  { label: 'Other channel', className: 'bg-src-other' },
  { label: 'Blocked', className: 'bg-ink-soft stripes' },
];

interface PendingMove {
  stay: CalStay;
  property: CalProperty;
  change: StayChange;
  target: RowTarget;
}

export function CalendarView() {
  const auth = useAuth();
  const toast = useToast();
  const { properties, isLoading: propertiesLoading } = useProperties();

  const [span, setSpan] = useStoredState<Span>('pms.calendar.span', '30');
  const [zoom, setZoom] = useStoredState<Zoom>('pms.calendar.zoom', 'normal');
  const [hidden, setHidden] = useStoredState<string[]>('pms.calendar.hidden', []);
  const [collapsedList, setCollapsedList] = useStoredState<string[]>('pms.calendar.collapsed', []);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);

  // "Today" follows the first property's time zone: a hotel in India is on tomorrow's date at 8pm in London.
  const timezone = properties[0]?.timezone ?? 'Asia/Kolkata';
  const today = useMemo(() => todayIn(timezone), [timezone]);
  const [start, setStart] = useState<string | null>(null);
  useEffect(() => {
    if (start === null) setStart(addDays(today, -1));
  }, [start, today]);

  const visibleIds = useMemo(
    () => properties.filter((p) => !hidden.includes(p.id)).map((p) => p.id),
    [properties, hidden],
  );
  const from = start ?? addDays(today, -1);
  const to = addDays(from, Number(span));
  const key =
    properties.length > 0 && visibleIds.length > 0
      ? `/calendar${query({ from, to, propertyIds: visibleIds.length === properties.length ? undefined : visibleIds })}`
      : null;
  const { data: calendar, error, mutate, isValidating } = useSWR<Calendar>(key);

  useLive(/^(reservation|block|unit|rates)\.|^ari\.availability$/, (events) => {
    if (
      events.some(
        (e) => e.kind === 'resync' || e.propertyId === null || visibleIds.includes(e.propertyId),
      )
    )
      void mutate();
  });

  const [openStay, setOpenStay] = useState<CalStay | null>(null);
  const [newReservation, setNewReservation] = useState<ReservationPrefill | null>(null);
  const [newBlock, setNewBlock] = useState<BlockDraft | null>(null);
  const [editBlock, setEditBlock] = useState<{ block: CalBlock; property: CalProperty } | null>(
    null,
  );
  const [selection, setSelection] = useState<RangeSelection | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setIsNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const toggle = useCallback(
    (id: string) =>
      setCollapsedList(
        collapsed.has(id) ? collapsedList.filter((x) => x !== id) : [...collapsedList, id],
      ),
    [collapsed, collapsedList, setCollapsedList],
  );

  /** Shows the change at once, sends it, then reloads; a refusal puts the bar back and says why. */
  const applyStayChange = useCallback(
    async (
      stay: CalStay,
      property: CalProperty,
      change: StayChange,
      target: RowTarget | undefined,
    ) => {
      const body: Record<string, unknown> = { expectedVersion: stay.version };
      if (change.checkIn !== stay.checkIn) body.checkIn = change.checkIn;
      if (change.checkOut !== stay.checkOut) body.checkOut = change.checkOut;
      if (target) {
        if (target.roomType.id !== stay.roomTypeId) body.roomTypeId = target.roomType.id;
        // Dropping on a unit assigns it; dropping on the "not assigned" row clears the assignment.
        body.unitId = target.unit ? target.unit.id : null;
      }
      if (!calendar) return;
      const optimistic = (current: Calendar | undefined): Calendar => {
        const base = current ?? calendar;
        return {
          ...base,
          properties: base.properties.map((p) =>
            p.id !== property.id
              ? p
              : {
                  ...p,
                  stays: p.stays.map((s) =>
                    s.id !== stay.id
                      ? s
                      : {
                          ...s,
                          checkIn: change.checkIn,
                          checkOut: change.checkOut,
                          roomTypeId: target?.roomType.id ?? s.roomTypeId,
                          unitId: target ? (target.unit?.id ?? null) : s.unitId,
                        },
                  ),
                },
          ),
        };
      };
      try {
        let result: RoomChange | undefined;
        await mutate(
          async (current) => {
            result = await api<RoomChange>(`/reservations/${stay.reservationId}/rooms/${stay.id}`, {
              method: 'PATCH',
              body,
            });
            return current;
          },
          { optimisticData: optimistic, rollbackOnError: true, revalidate: true },
        );
        if (result) {
          announceRoomChange(
            toast,
            result,
            `${stay.guestName} moved`,
            formatStay(change.checkIn, change.checkOut),
          );
        }
      } catch (err) {
        toast.error(err);
      }
    },
    [calendar, mutate, toast],
  );

  const onChangeStay = useCallback(
    (stay: CalStay, property: CalProperty, change: StayChange) => {
      const target = change.target;
      if (target && target.property.id !== property.id) {
        toast.error(
          'A stay cannot be moved to another property. Cancel it and book the other property instead.',
        );
        return;
      }
      if (target && target.roomType.id !== stay.roomTypeId) {
        // Changing room type re-prices the stay, so ask first.
        setPendingMove({ stay, property, change, target });
        return;
      }
      void applyStayChange(stay, property, change, target);
    },
    [applyStayChange, toast],
  );

  const onChangeBlock = useCallback(
    async (
      block: CalBlock,
      property: CalProperty,
      change: { startDate: string; endDate: string },
    ) => {
      if (!calendar) return;
      try {
        await mutate(
          async (current) => {
            await api(`/blocks/${block.id}`, { method: 'PATCH', body: change });
            return current;
          },
          {
            optimisticData: (current) => {
              const base = current ?? calendar;
              return {
                ...base,
                properties: base.properties.map((p) =>
                  p.id !== property.id
                    ? p
                    : {
                        ...p,
                        blocks: p.blocks.map((b) => (b.id === block.id ? { ...b, ...change } : b)),
                      },
                ),
              };
            },
            rollbackOnError: true,
            revalidate: true,
          },
        );
        toast.success('Block moved', formatStay(change.startDate, change.endDate));
      } catch (err) {
        toast.error(err);
      }
    },
    [calendar, mutate, toast],
  );

  const canWrite = useCallback(
    (propertyId: string) => auth.can('reservations.write', propertyId),
    [auth],
  );
  const canCreate = properties.some((p) => auth.can('reservations.write', p.id));

  if (propertiesLoading) return <PageLoading />;
  if (properties.length === 0) {
    return (
      <EmptyState
        icon={<CalendarPlus className="size-5" />}
        title="No properties yet"
        description="Add your first hotel or villa to start taking reservations."
        action={
          auth.canOrgWide('property.manage') ? (
            <a
              href="/settings/properties"
              className="inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Add a property
            </a>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <div className="flex items-center">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Earlier"
            onClick={() => setStart(addDays(from, -Math.round(Number(span) / 2)))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button size="sm" onClick={() => setStart(addDays(today, -1))}>
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Later"
            onClick={() => setStart(addDays(from, Math.round(Number(span) / 2)))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
        <Input
          type="date"
          aria-label="Go to date"
          value={from}
          onChange={(e) => e.target.value && setStart(e.target.value)}
          className="h-8 w-36"
        />
        <Segmented
          label="Days shown"
          size="sm"
          value={span}
          onChange={setSpan}
          options={[
            { value: '14', label: '2 weeks' },
            { value: '30', label: 'Month' },
            { value: '60', label: '2 months' },
          ]}
        />
        <span className="hidden lg:inline-flex">
          <Segmented
            label="Zoom"
            size="sm"
            value={zoom}
            onChange={setZoom}
            options={[
              { value: 'compact', label: 'S' },
              { value: 'normal', label: 'M' },
              { value: 'wide', label: 'L' },
            ]}
          />
        </span>
        {properties.length > 1 && (
          <Popover
            trigger={
              <Button size="sm" icon={<Filter className="size-3.5" />}>
                {visibleIds.length === properties.length
                  ? 'All properties'
                  : plural(visibleIds.length, 'property', 'properties')}
              </Button>
            }
          >
            <div className="flex max-h-72 min-w-52 flex-col gap-2 overflow-y-auto">
              {properties.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.name}
                  checked={!hidden.includes(p.id)}
                  onChange={(e) =>
                    setHidden(
                      e.target.checked ? hidden.filter((id) => id !== p.id) : [...hidden, p.id],
                    )
                  }
                />
              ))}
              {hidden.length > 0 && (
                <button
                  type="button"
                  className="self-start text-[13px] font-medium text-brand-700 hover:underline"
                  onClick={() => setHidden([])}
                >
                  Show all
                </button>
              )}
            </div>
          </Popover>
        )}
        {isValidating && <Spinner label="Refreshing" />}
        <div className="ml-auto flex items-center gap-2">
          <Popover
            align="end"
            trigger={
              <Button size="sm" variant="ghost">
                Legend
              </Button>
            }
          >
            <ul className="grid grid-cols-2 gap-x-5 gap-y-1.5 text-[13px] text-ink-soft">
              {LEGEND.map((item) => (
                <li key={item.label} className="flex items-center gap-2">
                  <span className={`h-3 w-5 rounded-sm ${item.className}`} aria-hidden />
                  {item.label}
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-64 text-xs text-ink-faint">
              Drag a stay to move it, drag its edges to change the dates, or drag across empty dates
              to book or block them.
            </p>
          </Popover>
          {canCreate && (
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => setNewReservation({})}
            >
              New reservation
            </Button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-auto bg-surface">
        {error && !calendar ? (
          <ErrorState error={error} onRetry={() => void mutate()} />
        ) : visibleIds.length === 0 ? (
          <EmptyState
            title="No properties selected"
            description="Choose at least one property to show."
          />
        ) : !calendar ? (
          <PageLoading label="Loading calendar" />
        ) : (
          <CalendarGrid
            calendar={calendar}
            cellWidth={CELL_WIDTH[zoom]}
            labelWidth={isNarrow ? 112 : 184}
            today={today}
            collapsed={collapsed}
            onToggle={toggle}
            canWrite={canWrite}
            onOpenStay={setOpenStay}
            onOpenBlock={(block, property) => setEditBlock({ block, property })}
            onSelectRange={setSelection}
            onChangeStay={onChangeStay}
            onChangeBlock={(block, property, change) => void onChangeBlock(block, property, change)}
          />
        )}
      </div>

      {selection && (
        <SelectionMenu
          selection={selection}
          canBlock={
            auth.can('blocks.write', selection.property.id) ||
            auth.can('maintenance.write', selection.property.id)
          }
          onClose={() => setSelection(null)}
          onReserve={() => {
            setNewReservation({
              propertyId: selection.property.id,
              roomTypeId: selection.roomType.id,
              unitId: selection.unit?.id ?? null,
              checkIn: selection.from,
              checkOut: selection.to,
            });
            setSelection(null);
          }}
          onBlock={() => {
            setNewBlock({
              property: selection.property,
              roomTypeId: selection.roomType.id,
              unitId: selection.unit?.id ?? null,
              from: selection.from,
              to: selection.to,
            });
            setSelection(null);
          }}
        />
      )}

      <ReservationDialog
        open={newReservation !== null}
        prefill={newReservation ?? undefined}
        onClose={() => setNewReservation(null)}
        onCreated={() => void mutate()}
      />
      {newBlock && (
        <NewBlockDialog
          draft={newBlock}
          onClose={() => setNewBlock(null)}
          onSaved={() => void mutate()}
        />
      )}
      {editBlock && (
        <EditBlockDialog
          block={editBlock.block}
          property={editBlock.property}
          onClose={() => setEditBlock(null)}
          onSaved={() => void mutate()}
        />
      )}
      <Drawer
        open={openStay !== null}
        onClose={() => setOpenStay(null)}
        title={openStay ? `Reservation ${openStay.code}` : ''}
        description={openStay?.guestName}
      >
        {openStay && (
          <ReservationPanel
            reservationId={openStay.reservationId}
            onChanged={() => void mutate()}
          />
        )}
      </Drawer>

      {pendingMove && (
        <Dialog
          open
          onClose={() => setPendingMove(null)}
          size="sm"
          title={`Move to ${pendingMove.target.roomType.name}?`}
          description={`${pendingMove.stay.guestName}, ${formatStay(pendingMove.change.checkIn, pendingMove.change.checkOut)}`}
          footer={
            <>
              <Button onClick={() => setPendingMove(null)}>Keep as it is</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const move = pendingMove;
                  setPendingMove(null);
                  void applyStayChange(move.stay, move.property, move.change, move.target);
                }}
              >
                Move and re-price
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">
            The stay changes room type, so it will be priced again at the{' '}
            {pendingMove.target.roomType.name} rate. You can adjust the price on the reservation
            afterwards.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/** The small menu shown where a date selection ended. */
function SelectionMenu({
  selection,
  canBlock,
  onClose,
  onReserve,
  onBlock,
}: {
  selection: RangeSelection;
  canBlock: boolean;
  onClose: () => void;
  onReserve: () => void;
  onBlock: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep the menu on screen near the pointer.
  const left = Math.min(
    selection.anchor.x,
    (typeof window === 'undefined' ? 800 : window.innerWidth) - 240,
  );
  const top = Math.min(
    selection.anchor.y + 8,
    (typeof window === 'undefined' ? 600 : window.innerHeight) - 150,
  );

  return (
    <>
      <button
        type="button"
        aria-label="Dismiss"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="menu"
        aria-label="Selected dates"
        className="fixed z-50 w-56 animate-pop-in rounded-lg border border-line bg-surface p-1 shadow-pop"
        style={{ left, top }}
      >
        <p className="px-2.5 py-1.5 text-xs text-ink-faint">
          {selection.unit?.name ?? selection.roomType.name} ·{' '}
          {formatStay(selection.from, selection.to)}
        </p>
        <button
          type="button"
          role="menuitem"
          autoFocus
          onClick={onReserve}
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink hover:bg-sunken"
        >
          <CalendarPlus className="size-4 text-ink-faint" aria-hidden /> New reservation
        </button>
        {canBlock && (
          <button
            type="button"
            role="menuitem"
            onClick={onBlock}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-ink hover:bg-sunken"
          >
            <Lock className="size-4 text-ink-faint" aria-hidden /> Block dates
          </button>
        )}
      </div>
    </>
  );
}
