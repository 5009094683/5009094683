'use client';

import { useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Select } from '@/components/ui/field';
import { ErrorState, Notice, PageLoading, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { useReservationFolios } from '@/components/folio/data';
import { DocumentReader } from '@/components/insights/document-reader';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDay, formatMoney } from '@/lib/format';
import { useLive } from '@/lib/live';
import type { Reservation, ReservationRoom } from '@/lib/types';
import {
  HOUSEKEEPING_LABELS,
  guestCount,
  listInWords,
  roomInText,
  roomLabel,
  stayDates,
} from './labels';
import type { FreeUnit } from './types';

const byName = (a: FreeUnit, b: FreeUnit) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** "Checked in Asha Rao to room 204", or "to rooms 204 and 205" for several. */
function checkedInMessage(guest: string, unitNames: string[]): string {
  if (unitNames.length === 0) return `Checked in ${guest}`;
  if (unitNames.length === 1) return `Checked in ${guest} to ${roomInText(unitNames[0]!)}`;
  const numbered = unitNames.every((name) => /^\d/.test(name));
  return `Checked in ${guest} to ${numbered ? 'rooms ' : ''}${listInWords(unitNames)}`;
}

function RoomChoice({
  room,
  guestName,
  units,
  loading,
  value,
  onChange,
}: {
  room: ReservationRoom;
  guestName: string;
  /** Units free for the whole stay, the assigned one included. Undefined until loaded. */
  units: FreeUnit[] | undefined;
  loading: boolean;
  /** The chosen unit, or '' to let the system choose. */
  value: string;
  onChange: (unitId: string) => void;
}) {
  const assigned = units?.find((unit) => unit.id === room.unitId);
  const others = (units ?? []).filter((unit) => unit.id !== room.unitId).sort(byName);
  const chosen = units?.find((unit) => unit.id === value);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-ink-soft">
        {guestName} · {stayDates(room.checkIn, room.checkOut)} ·{' '}
        {guestCount(room.adults, room.children)}
      </p>
      {loading && !units ? (
        <div className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner /> Finding free rooms…
        </div>
      ) : units && units.length === 0 ? (
        <Notice tone="warning">
          No {room.roomTypeName} room is free for the whole stay. Another booking must be moved
          first, or the room type changed in the reservation.
        </Notice>
      ) : (
        <Field
          label="Room"
          hint={
            chosen?.housekeepingStatus === 'dirty'
              ? 'This room has not been cleaned yet. You will be asked to confirm.'
              : value === ''
                ? 'The system gives the free room that fits best.'
                : undefined
          }
          error={
            chosen?.housekeepingStatus === 'out_of_service'
              ? `${roomLabel(chosen.name)} is out of service. Choose another room.`
              : null
          }
        >
          {(props) => (
            <Select {...props} value={value} onChange={(e) => onChange(e.target.value)}>
              {!room.unitId && <option value="">Choose for me</option>}
              {assigned && (
                <option value={assigned.id}>
                  {assigned.name} · {HOUSEKEEPING_LABELS[assigned.housekeepingStatus]} (assigned)
                </option>
              )}
              {others.map((unit) => (
                <option
                  key={unit.id}
                  value={unit.id}
                  disabled={unit.housekeepingStatus === 'out_of_service'}
                >
                  {unit.name} · {HOUSEKEEPING_LABELS[unit.housekeepingStatus]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}

/** Checks in one or more rooms of a reservation, choosing the room each guest gets. */
export function CheckInDialog({
  reservationId,
  roomId,
  hotelDay,
  onClose,
  onDone,
}: {
  reservationId: string;
  /** The room the dialog was opened for. Without it, every room that is due is ticked. */
  roomId?: string;
  /** The property's current hotel day. */
  hotelDay: string;
  onClose: () => void;
  onDone: (reservation: Reservation) => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const {
    data: reservation,
    error: loadError,
    mutate,
  } = useSWR<Reservation>(`/reservations/${reservationId}`);
  const due = (reservation?.rooms ?? []).filter(
    (room) => room.status === 'confirmed' && room.checkIn <= hotelDay,
  );
  // A stay whose last night has passed must be extended before the guest can be checked in.
  const eligible = due.filter((room) => room.checkOut > hotelDay);
  const ended = due.filter((room) => room.checkOut <= hotelDay);

  const eligibleIds = eligible.map((room) => room.id);
  const {
    data: free,
    error: freeError,
    isLoading: freeLoading,
    mutate: mutateFree,
  } = useSWR<Record<string, FreeUnit[]>>(
    eligibleIds.length > 0 ? ['free-units', reservationId, ...eligibleIds] : null,
    async () => {
      const lists = await Promise.all(
        eligibleIds.map((id) =>
          api<{ units: FreeUnit[] }>(`/reservations/${reservationId}/rooms/${id}/free-units`),
        ),
      );
      return Object.fromEntries(eligibleIds.map((id, index) => [id, lists[index]!.units]));
    },
  );
  useLive(/^(unit|reservation)\./, () => void mutateFree());

  const canSeeBill = reservation ? auth.can('folio.read', reservation.propertyId) : false;
  const { data: bill } = useReservationFolios(reservationId, canSeeBill);

  const [ticked, setTicked] = useState<string[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<{ unitName: string | null; message: string } | null>(null);

  const opened = roomId && eligibleIds.includes(roomId) ? [roomId] : eligibleIds;
  const selected = eligible.filter((room) => (ticked ?? opened).includes(room.id));
  const unitOf = (room: ReservationRoom): string => choices[room.id] ?? room.unitId ?? '';
  const nameOf = (unitId: string): string | null =>
    Object.values(free ?? {})
      .flat()
      .find((unit) => unit.id === unitId)?.name ?? null;

  const chosenUnits = selected.map(unitOf).filter(Boolean);
  const twice = chosenUnits.find((unitId, index) => chosenUnits.indexOf(unitId) !== index);
  const blocked = selected.some((room) => {
    const units = free?.[room.id];
    if (!units) return true;
    const unit = units.find((candidate) => candidate.id === unitOf(room));
    return units.length === 0 || unit?.housekeepingStatus === 'out_of_service';
  });

  const send = async (allowDirty: boolean) => {
    if (!reservation || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const units: Record<string, string> = {};
      for (const room of selected) {
        const unitId = unitOf(room);
        if (unitId) units[room.id] = unitId;
      }
      const updated = await api<Reservation>(`/reservations/${reservationId}/check-in`, {
        body: {
          roomIds: selected.map((room) => room.id),
          units,
          ...(allowDirty ? { allowDirty: true } : {}),
        },
      });
      const rooms = updated.rooms.filter((room) => selected.some((s) => s.id === room.id));
      const guest =
        rooms.length === 1 ? (rooms[0]!.guestName ?? updated.guestName) : updated.guestName;
      toast.success(
        checkedInMessage(
          guest,
          rooms.flatMap((room) => (room.unitName ? [room.unitName] : [])),
        ),
      );
      void mutate(updated, { revalidate: false });
      onDone(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.reason === 'unit_dirty') {
        const unitId = err.details.unitId;
        setDirty({
          unitName: typeof unitId === 'string' ? nameOf(unitId) : null,
          message: err.message,
        });
      } else {
        setDirty(null);
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!twice && !blocked) void send(false);
  };

  const guestName = reservation?.guestName ?? '';
  // Before check-in there is a bill only if something was charged or paid in advance.
  const billed = bill && bill.folios.length > 0 ? bill : null;
  const noIdentity = Boolean(reservation?.guest && !reservation.guest.hasIdNumber);

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Check in"
      description={reservation ? `${guestName} · ${reservation.code}` : undefined}
      footer={
        dirty ? (
          <>
            <Button onClick={() => setDirty(null)} disabled={busy} autoFocus>
              Choose another room
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void send(true)}>
              Check in anyway
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              form="check-in-form"
              variant="primary"
              loading={busy}
              disabled={selected.length === 0 || blocked || Boolean(twice)}
            >
              {selected.length > 1 ? `Check in ${selected.length} rooms` : 'Check in'}
            </Button>
          </>
        )
      }
    >
      {loadError && !reservation ? (
        <ErrorState error={loadError} onRetry={() => void mutate()} />
      ) : !reservation ? (
        <PageLoading />
      ) : dirty ? (
        <div className="flex flex-col gap-3">
          <Notice
            tone="warning"
            title={
              dirty.unitName
                ? `${roomLabel(dirty.unitName)} has not been cleaned yet. Check in anyway?`
                : `${dirty.message}. Check in anyway?`
            }
          >
            {selected.length > 1
              ? 'Every room in this check-in is then given to its guest as it is, cleaned or not.'
              : 'The room is given to the guest as it is. It stays marked as not cleaned for housekeeping.'}
          </Notice>
        </div>
      ) : (
        <form id="check-in-form" onSubmit={submit} className="flex flex-col gap-4">
          {error && <Notice tone="danger">{error}</Notice>}
          {freeError && !free && (
            <Notice tone="danger" title="The free rooms could not be loaded">
              <p>{errorMessage(freeError)}</p>
              <Button size="sm" className="mt-2" onClick={() => void mutateFree()}>
                Try again
              </Button>
            </Notice>
          )}
          {eligible.length === 0 && ended.length === 0 && (
            <Notice tone="info">
              No room of this reservation is due to check in today ({formatDay(hotelDay)}).
            </Notice>
          )}
          {ended.map((room) => (
            <Notice key={room.id} tone="warning" title={room.roomTypeName}>
              This stay ended on {formatDay(room.checkOut)}. Change the departure date in the
              reservation before checking in.
            </Notice>
          ))}
          {eligible.map((room) => {
            const on = selected.some((s) => s.id === room.id);
            return (
              <fieldset key={room.id} className="rounded-lg border border-line p-3">
                {eligible.length > 1 ? (
                  <Checkbox
                    className="font-medium"
                    label={`${room.roomTypeName} · ${room.unitName ? roomLabel(room.unitName) : 'No room yet'}`}
                    checked={on}
                    onChange={(e) => {
                      const current = ticked ?? opened;
                      setTicked(
                        e.target.checked
                          ? [...current, room.id]
                          : current.filter((id) => id !== room.id),
                      );
                    }}
                  />
                ) : (
                  <p className="text-sm font-medium text-ink">{room.roomTypeName}</p>
                )}
                {on && (
                  <div className="mt-2">
                    <RoomChoice
                      room={room}
                      guestName={room.guestName ?? guestName}
                      units={free?.[room.id]}
                      loading={freeLoading}
                      value={unitOf(room)}
                      onChange={(unitId) => setChoices({ ...choices, [room.id]: unitId })}
                    />
                  </div>
                )}
              </fieldset>
            );
          })}
          {twice && (
            <Notice tone="danger">
              {roomLabel(nameOf(twice) ?? 'The same room')} is chosen for more than one guest. Give
              each one a room of their own.
            </Notice>
          )}
          {(billed || noIdentity) && (
            <ul className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] text-ink-soft">
              {billed && (
                <li>
                  {billed.balance > 0
                    ? `${formatMoney(billed.balance, reservation.currency)} is owed on the bill so far.`
                    : billed.balance < 0
                      ? `The guest is ${formatMoney(-billed.balance, reservation.currency)} in credit.`
                      : 'Nothing is owed on the bill so far.'}
                </li>
              )}
              {noIdentity && (
                <li>
                  No identity document is on file for this guest. Record it on the guest&apos;s
                  profile, under Guests.
                </li>
              )}
            </ul>
          )}
          <DocumentReader reservation={reservation} onSaved={() => void mutate()} />
        </form>
      )}
    </Dialog>
  );
}
