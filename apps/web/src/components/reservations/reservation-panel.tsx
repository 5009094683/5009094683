'use client';

import {
  AlertTriangle,
  BedDouble,
  CalendarRange,
  Check,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  RotateCcw,
  UserX,
  X,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import useSWR from 'swr';
import { addDays, isValidDate } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import {
  Badge,
  ErrorState,
  Menu,
  MenuItem,
  Notice,
  PageLoading,
  STATUS_TONES,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  STATUS_LABELS,
  formatDateTime,
  formatMoney,
  formatStay,
  formatWeekday,
  plural,
  sourceLabel,
} from '@/lib/format';
import { announceRoomChange } from '@/lib/feedback';
import { usePropertyDetail } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import type { PropertyDetail, Reservation, ReservationRoom, RoomChange } from '@/lib/types';

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function RoomEditor({
  reservation,
  room,
  detail,
  onDone,
}: {
  reservation: Reservation;
  room: ReservationRoom;
  detail: PropertyDetail;
  onDone: (updated?: Reservation) => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [checkIn, setCheckIn] = useState(room.checkIn);
  const [checkOut, setCheckOut] = useState(room.checkOut);
  const [roomTypeId, setRoomTypeId] = useState(room.roomTypeId);
  const [unitId, setUnitId] = useState(room.unitId ?? '');
  const [force, setForce] = useState(false);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const type = detail.roomTypes.find((t) => t.id === roomTypeId);
  const units = type?.units.filter((u) => u.active) ?? [];
  const inHouse = room.status === 'in_house';
  const canOverride = auth.can('reservations.override', reservation.propertyId);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = { expectedVersion: reservation.version };
      if (checkIn !== room.checkIn) patch.checkIn = checkIn;
      if (checkOut !== room.checkOut) patch.checkOut = checkOut;
      if (roomTypeId !== room.roomTypeId) patch.roomTypeId = roomTypeId;
      if (unitId !== (room.unitId ?? '')) patch.unitId = unitId || null;
      if (force) patch.force = true;
      const result = await api<RoomChange>(`/reservations/${reservation.id}/rooms/${room.id}`, {
        method: 'PATCH',
        body: patch,
      });
      announceRoomChange(toast, result, 'Stay updated');
      onDone(result.reservation);
    } catch (err) {
      setError(errorMessage(err));
      if (
        err instanceof ApiError &&
        (err.code === 'no_availability' || err.code === 'unit_occupied')
      )
        setRefused(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="mt-3 flex flex-col gap-3 rounded-lg bg-sunken p-3">
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check-in">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={checkIn}
              disabled={inHouse}
              onChange={(e) => {
                setCheckIn(e.target.value);
                if (isValidDate(e.target.value) && checkOut <= e.target.value)
                  setCheckOut(addDays(e.target.value, 1));
              }}
              required
            />
          )}
        </Field>
        <Field label="Check-out">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={checkOut}
              min={isValidDate(checkIn) ? addDays(checkIn, 1) : undefined}
              onChange={(e) => setCheckOut(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Room type">
          {(props) => (
            <Select
              {...props}
              value={roomTypeId}
              onChange={(e) => {
                setRoomTypeId(e.target.value);
                setUnitId('');
              }}
            >
              {detail.roomTypes
                .filter((t) => t.active || t.id === room.roomTypeId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label={type?.assignment === 'at_booking' ? 'Unit' : 'Room'}>
          {(props) => (
            <Select {...props} value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">
                {type?.assignment === 'at_booking' ? 'Choose automatically' : 'Not assigned'}
              </option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {roomTypeId !== room.roomTypeId && (
        <p className="text-[13px] text-ink-soft">
          The stay will be re-priced at the {type?.name} rate.
        </p>
      )}
      {refused && canOverride && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="size-4 accent-brand-600"
          />
          Save anyway. This overbooks the property and raises an alert.
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary" loading={busy}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

function CancelDialog({
  reservation,
  roomId,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  /** Cancel only this room; the whole reservation when absent. */
  roomId?: string;
  onClose: () => void;
  onDone: (updated: Reservation) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api<Reservation>(`/reservations/${reservation.id}/cancel`, {
          body: { reason: reason.trim() || null, ...(roomId ? { roomIds: [roomId] } : {}) },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={roomId ? 'Cancel this room?' : `Cancel reservation ${reservation.code}?`}
      description="The dates go back on sale on every connected channel straight away."
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button type="submit" form="cancel-form" variant="danger" loading={busy}>
            Cancel {roomId ? 'room' : 'reservation'}
          </Button>
        </>
      }
    >
      <form id="cancel-form" onSubmit={submit} className="flex flex-col gap-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {reservation.source === 'ota' && (
          <Notice tone="warning">
            This booking came from {sourceLabel(reservation.source, reservation.channelCode)}.
            Cancelling it here does not cancel it there: the guest or the channel must cancel it on
            their side too.
          </Notice>
        )}
        <Field label="Reason" optional>
          {(props) => (
            <Textarea
              {...props}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              autoFocus
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function GuestDialog({
  reservation,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  onClose: () => void;
  onDone: (updated: Reservation) => void;
}) {
  const g = reservation.guest;
  const [form, setForm] = useState({
    firstName: g?.firstName ?? reservation.guestName,
    lastName: g?.lastName ?? '',
    email: g?.email ?? '',
    phone: g?.phone ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (g) {
        await api(`/guests/${g.id}`, {
          method: 'PATCH',
          body: {
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            email: form.email.trim() || null,
            phone: form.phone.trim() || null,
          },
        });
      }
      onDone(
        await api<Reservation>(`/reservations/${reservation.id}`, {
          method: 'PATCH',
          body: {
            guest: g
              ? { id: g.id, firstName: form.firstName.trim(), lastName: form.lastName.trim() }
              : {
                  firstName: form.firstName.trim(),
                  lastName: form.lastName.trim(),
                  email: form.email.trim() || null,
                  phone: form.phone.trim() || null,
                },
          },
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Guest details"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="guest-form" variant="primary" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="guest-form" onSubmit={submit} className="grid grid-cols-2 gap-3">
        {error && (
          <Notice tone="danger" className="col-span-2">
            {error}
          </Notice>
        )}
        <Field label="First name">
          {(props) => (
            <Input {...props} value={form.firstName} onChange={set('firstName')} required />
          )}
        </Field>
        <Field label="Last name">
          {(props) => <Input {...props} value={form.lastName} onChange={set('lastName')} />}
        </Field>
        <Field label="Email" optional className="col-span-2">
          {(props) => <Input {...props} type="email" value={form.email} onChange={set('email')} />}
        </Field>
        <Field label="Phone" optional className="col-span-2">
          {(props) => <Input {...props} type="tel" value={form.phone} onChange={set('phone')} />}
        </Field>
      </form>
    </Dialog>
  );
}

/** Everything about one reservation, with the actions staff take on it. */
export function ReservationPanel({
  reservationId,
  onChanged,
}: {
  reservationId: string;
  onChanged?: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const {
    data: reservation,
    error,
    mutate,
  } = useSWR<Reservation>(`/reservations/${reservationId}`);
  const { data: detail } = usePropertyDetail(reservation?.propertyId);
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [cancel, setCancel] = useState<{ roomId?: string } | null>(null);
  const [editGuest, setEditGuest] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useLive(/^reservation\./, (events) => {
    if (events.some((e) => e.kind === 'resync' || e.payload?.reservationId === reservationId))
      void mutate();
  });

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!reservation) return <PageLoading />;

  const canWrite = auth.can('reservations.write', reservation.propertyId);
  const apply = (updated?: Reservation) => {
    if (updated) void mutate(updated, { revalidate: false });
    else void mutate();
    onChanged?.();
  };

  const act = async (name: string, path: string, body: unknown, message: string) => {
    setBusy(name);
    try {
      apply(await api<Reservation>(path, { method: 'POST', body }));
      toast.success(message);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const liveRooms = reservation.rooms.filter(
    (r) => r.status !== 'cancelled' && r.status !== 'no_show',
  );
  const canCancel = canWrite && ['tentative', 'confirmed'].includes(reservation.status);
  const canNoShow = canWrite && reservation.status === 'confirmed';
  const canReinstate = canWrite && ['cancelled', 'no_show'].includes(reservation.status);

  return (
    <div className="flex flex-col">
      <div className="pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONES[reservation.status]}>{STATUS_LABELS[reservation.status]}</Badge>
          <Badge>{sourceLabel(reservation.source, reservation.channelCode)}</Badge>
          {reservation.overbooked && (
            <Badge tone="danger">
              <AlertTriangle className="size-3" aria-hidden /> Overbooked
            </Badge>
          )}
          {reservation.needsReview && <Badge tone="warning">Needs review</Badge>}
          {canWrite && (canCancel || canNoShow || canReinstate || reservation.needsReview) && (
            <span className="ml-auto">
              <Menu
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="More actions"
                    loading={busy !== null}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              >
                {reservation.needsReview && (
                  <MenuItem
                    icon={<Check />}
                    onSelect={() =>
                      void (async () => {
                        try {
                          apply(
                            await api<Reservation>(`/reservations/${reservation.id}`, {
                              method: 'PATCH',
                              body: { needsReview: false },
                            }),
                          );
                          toast.success('Marked as reviewed');
                        } catch (err) {
                          toast.error(err);
                        }
                      })()
                    }
                  >
                    Mark as reviewed
                  </MenuItem>
                )}
                {canNoShow && (
                  <MenuItem
                    icon={<UserX />}
                    onSelect={() =>
                      void act(
                        'no-show',
                        `/reservations/${reservation.id}/no-show`,
                        {},
                        'Marked as no-show',
                      )
                    }
                  >
                    Mark as no-show
                  </MenuItem>
                )}
                {canReinstate && (
                  <MenuItem
                    icon={<RotateCcw />}
                    onSelect={() =>
                      void act(
                        'reinstate',
                        `/reservations/${reservation.id}/reinstate`,
                        {},
                        'Reservation reinstated',
                      )
                    }
                  >
                    Reinstate
                  </MenuItem>
                )}
                {canCancel && (
                  <MenuItem icon={<X />} tone="danger" onSelect={() => setCancel({})}>
                    Cancel reservation
                  </MenuItem>
                )}
              </Menu>
            </span>
          )}
        </div>
        {reservation.status === 'tentative' && (
          <Notice tone="warning" className="mt-3" title="Held, not yet confirmed">
            <div className="flex items-center justify-between gap-3">
              <span>
                {reservation.holdExpiresAt
                  ? `The hold is released at ${formatDateTime(reservation.holdExpiresAt)}.`
                  : 'Confirm it to keep the rooms.'}
              </span>
              {canWrite && (
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === 'confirm'}
                  onClick={() =>
                    void act(
                      'confirm',
                      `/reservations/${reservation.id}/confirm`,
                      {},
                      'Reservation confirmed',
                    )
                  }
                >
                  Confirm
                </Button>
              )}
            </div>
          </Notice>
        )}
        {reservation.needsReview && reservation.reviewReason && (
          <Notice tone="warning" className="mt-3">
            {reservation.reviewReason}
          </Notice>
        )}
        {reservation.status === 'cancelled' && reservation.cancellationReason && (
          <p className="mt-3 text-[13px] text-ink-soft">
            Cancelled: {reservation.cancellationReason}
          </p>
        )}
      </div>

      <Section
        title="Guest"
        action={
          canWrite && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil className="size-3.5" />}
              onClick={() => setEditGuest(true)}
            >
              Edit
            </Button>
          )
        }
      >
        <p className="text-base font-semibold text-ink">{reservation.guestName}</p>
        <div className="mt-1 flex flex-col gap-1 text-sm text-ink-soft">
          {reservation.guest?.email && (
            <a
              href={`mailto:${reservation.guest.email}`}
              className="inline-flex items-center gap-2 hover:text-brand-700"
            >
              <Mail className="size-3.5 text-ink-faint" aria-hidden /> {reservation.guest.email}
            </a>
          )}
          {reservation.guest?.phone && (
            <a
              href={`tel:${reservation.guest.phone}`}
              className="inline-flex items-center gap-2 hover:text-brand-700"
            >
              <Phone className="size-3.5 text-ink-faint" aria-hidden /> {reservation.guest.phone}
            </a>
          )}
          {!reservation.guest?.email && !reservation.guest?.phone && (
            <span className="text-ink-faint">No contact details</span>
          )}
        </div>
      </Section>

      <Section title="Stay">
        <div className="flex items-center gap-2 text-sm text-ink">
          <CalendarRange className="size-4 text-ink-faint" aria-hidden />
          <span className="font-medium">
            {formatStay(reservation.checkIn, reservation.checkOut)}
          </span>
          <span className="text-ink-soft">
            · {plural(reservation.nights, 'night')} · {plural(reservation.adults, 'adult')}
            {reservation.children > 0
              ? `, ${plural(reservation.children, 'child', 'children')}`
              : ''}
          </span>
        </div>
        {reservation.channelReservationCode && (
          <p className="mt-1 text-[13px] text-ink-soft">
            {sourceLabel(reservation.source, reservation.channelCode)} reference{' '}
            <span className="font-mono text-ink">{reservation.channelReservationCode}</span>
          </p>
        )}
      </Section>

      <Section title={reservation.rooms.length > 1 ? `Rooms (${liveRooms.length})` : 'Room'}>
        <ul className="flex flex-col gap-2">
          {reservation.rooms.map((room) => {
            const editable =
              canWrite && ['tentative', 'confirmed', 'in_house'].includes(room.status);
            return (
              <li key={room.id} className="rounded-lg border border-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink">
                      <BedDouble className="size-4 shrink-0 text-ink-faint" aria-hidden />
                      <span className="truncate">{room.roomTypeName}</span>
                      {room.unitName ? (
                        <Badge tone="brand">{room.unitName}</Badge>
                      ) : (
                        ['tentative', 'confirmed'].includes(room.status) && (
                          <Badge tone="warning">No room assigned</Badge>
                        )
                      )}
                      {room.status !== reservation.status && (
                        <Badge tone={STATUS_TONES[room.status]}>{STATUS_LABELS[room.status]}</Badge>
                      )}
                    </p>
                    <p className="mt-1 text-[13px] text-ink-soft">
                      {formatWeekday(room.checkIn)} to {formatWeekday(room.checkOut)} ·{' '}
                      {plural(room.adults, 'adult')}
                      {room.children > 0 ? `, ${plural(room.children, 'child', 'children')}` : ''}
                      {room.ratePlanName ? ` · ${room.ratePlanName}` : ''}
                    </p>
                  </div>
                  <p className="tabular shrink-0 text-sm font-medium text-ink">
                    {formatMoney(room.amount, reservation.currency)}
                  </p>
                </div>
                {editable && editingRoom !== room.id && (
                  <div className="mt-2 flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditingRoom(room.id)}>
                      Change dates or room
                    </Button>
                    {reservation.rooms.length > 1 && room.status !== 'in_house' && (
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={() => setCancel({ roomId: room.id })}
                      >
                        Cancel room
                      </Button>
                    )}
                  </div>
                )}
                {editingRoom === room.id && detail && (
                  <RoomEditor
                    reservation={reservation}
                    room={room}
                    detail={detail}
                    onDone={(updated) => {
                      setEditingRoom(null);
                      if (updated) apply(updated);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-ink-soft">Accommodation total, before tax</span>
          <span className="tabular text-base font-semibold text-ink">
            {formatMoney(reservation.totalAmount, reservation.currency)}
          </span>
        </div>
        {reservation.paymentCollect === 'channel' && (
          <p className="mt-1 text-right text-[13px] text-ink-faint">
            Paid to the channel, not at the property
          </p>
        )}
      </Section>

      <Section title="Requests and notes">
        {reservation.specialRequests && (
          <div className="mb-3">
            <p className="text-xs font-medium text-ink-faint">From the guest</p>
            <p className="mt-0.5 text-sm whitespace-pre-wrap text-ink">
              {reservation.specialRequests}
            </p>
          </div>
        )}
        {notes === null ? (
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm whitespace-pre-wrap text-ink">
              {reservation.notes || <span className="text-ink-faint">No internal notes</span>}
            </p>
            {canWrite && (
              <Button size="sm" variant="ghost" onClick={() => setNotes(reservation.notes ?? '')}>
                {reservation.notes ? 'Edit' : 'Add note'}
              </Button>
            )}
          </div>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                apply(
                  await api<Reservation>(`/reservations/${reservation.id}`, {
                    method: 'PATCH',
                    body: { notes: notes.trim() || null },
                  }),
                );
                setNotes(null);
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              aria-label="Internal notes"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setNotes(null)}>
                Cancel
              </Button>
              <Button size="sm" type="submit" variant="primary">
                Save note
              </Button>
            </div>
          </form>
        )}
      </Section>

      <p className="border-t border-line pt-3 text-xs text-ink-faint">
        Created {formatDateTime(reservation.createdAt)} · last changed{' '}
        {formatDateTime(reservation.updatedAt)}
      </p>

      {cancel && (
        <CancelDialog
          reservation={reservation}
          roomId={cancel.roomId}
          onClose={() => setCancel(null)}
          onDone={(updated) => {
            setCancel(null);
            apply(updated);
            toast.success(
              cancel.roomId ? 'Room cancelled' : `Reservation ${reservation.code} cancelled`,
            );
          }}
        />
      )}
      {editGuest && (
        <GuestDialog
          reservation={reservation}
          onClose={() => setEditGuest(false)}
          onDone={(updated) => {
            setEditGuest(false);
            apply(updated);
          }}
        />
      )}
    </div>
  );
}
