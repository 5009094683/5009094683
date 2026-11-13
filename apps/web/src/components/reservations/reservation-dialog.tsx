'use client';

import { Plus, Search, Trash2, UserCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import useSWR from 'swr';
import { addDays, diffDays, isValidDate } from '@pms/domain/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, query } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDay, formatMoney, fromMinor, plural, toMinor } from '@/lib/format';
import { useDebounced, useProperties, usePropertyDetail } from '@/lib/hooks';
import type { Availability, Guest, PropertyDetail, Quote, Reservation } from '@/lib/types';

export interface ReservationPrefill {
  propertyId?: string;
  roomTypeId?: string;
  unitId?: string | null;
  checkIn?: string;
  checkOut?: string;
}

/** The group a booking is being made for: it may use the rooms held for that group. */
export interface ReservationGroup {
  id: string;
  name: string;
  propertyId: string;
}

interface RoomDraft {
  key: number;
  roomTypeId: string;
  ratePlanId: string;
  unitId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Rate per night typed by staff, in major units. Empty means "use the rate plan". */
  customRate: string;
}

const SOURCES = [
  { value: 'direct', label: 'Direct' },
  { value: 'phone', label: 'Phone' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'travel_agent', label: 'Travel agent' },
  { value: 'owner', label: 'Owner' },
] as const;

function defaultPlanId(detail: PropertyDetail | undefined, roomTypeId: string): string {
  const plans =
    detail?.roomTypes.find((t) => t.id === roomTypeId)?.ratePlans.filter((p) => p.active) ?? [];
  return (plans.find((p) => p.isDefault) ?? plans[0])?.id ?? '';
}

/** Price and availability for one room of the form, refreshed as its fields change. */
function useRoomCheck(propertyId: string, room: RoomDraft, groupId?: string) {
  const valid =
    Boolean(propertyId && room.roomTypeId) &&
    isValidDate(room.checkIn) &&
    isValidDate(room.checkOut) &&
    room.checkOut > room.checkIn &&
    diffDays(room.checkIn, room.checkOut) <= 365;
  const asked = valid
    ? JSON.stringify([
        propertyId,
        room.roomTypeId,
        room.ratePlanId,
        room.checkIn,
        room.checkOut,
        room.adults,
        room.children,
      ])
    : null;
  const key = useDebounced(asked, 250);
  // Until the pause after typing is over, what was fetched is for the stay as it was before.
  const settled = key === asked;
  const quote = useSWR<Quote>(
    key && room.ratePlanId ? ['quote', key] : null,
    () =>
      api<Quote>(`/properties/${propertyId}/quote`, {
        body: {
          ratePlanId: room.ratePlanId,
          checkIn: room.checkIn,
          checkOut: room.checkOut,
          adults: room.adults,
          children: room.children,
        },
      }),
    { revalidateOnFocus: false },
  );
  const availability = useSWR<{ days: Availability[] }>(
    key
      ? `/properties/${propertyId}/availability${query({ from: room.checkIn, to: room.checkOut, roomTypeIds: [room.roomTypeId], groupId })}`
      : null,
  );
  const soldOut = availability.data?.days.filter((d) => d.available <= 0).map((d) => d.date) ?? [];
  return {
    valid,
    quote: settled ? quote.data : undefined,
    quoteLoading: valid && (!settled || quote.isLoading),
    soldOut,
  };
}

function RoomSection({
  index,
  room,
  detail,
  currency,
  canRemove,
  groupId,
  onChange,
  onRemove,
  onCheck,
}: {
  index: number;
  room: RoomDraft;
  detail: PropertyDetail;
  currency: string;
  canRemove: boolean;
  groupId?: string;
  onChange: (patch: Partial<RoomDraft>) => void;
  onRemove: () => void;
  onCheck: (key: number, state: { soldOut: string[]; total: number | null }) => void;
}) {
  const type = detail.roomTypes.find((t) => t.id === room.roomTypeId);
  const plans = type?.ratePlans.filter((p) => p.active) ?? [];
  const units = type?.units.filter((u) => u.active) ?? [];
  const { valid, quote, quoteLoading, soldOut } = useRoomCheck(detail.property.id, room, groupId);
  const nights = valid ? diffDays(room.checkIn, room.checkOut) : 0;
  const custom = room.customRate.trim() === '' ? null : Number(room.customRate);
  const total =
    custom !== null && Number.isFinite(custom)
      ? toMinor(custom, currency) * nights
      : (quote?.total ?? null);

  const soldOutKey = soldOut.join(',');
  useEffect(() => {
    onCheck(room.key, { soldOut: soldOutKey ? soldOutKey.split(',') : [], total });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.key, soldOutKey, total]);

  return (
    <fieldset className="rounded-lg border border-line p-3">
      <legend className="px-1 text-[13px] font-medium text-ink-soft">
        Room {index + 1}
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove room ${index + 1}`}
            className="ml-2 inline-flex items-center rounded p-0.5 text-ink-faint hover:bg-danger-50 hover:text-danger-600"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Room type" className="col-span-2">
          {(props) => (
            <Select
              {...props}
              value={room.roomTypeId}
              onChange={(e) =>
                onChange({
                  roomTypeId: e.target.value,
                  ratePlanId: defaultPlanId(detail, e.target.value),
                  unitId: '',
                })
              }
              required
            >
              {detail.roomTypes
                .filter((t) => t.active)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Rate plan" className="col-span-2">
          {(props) => (
            <Select
              {...props}
              value={room.ratePlanId}
              onChange={(e) => onChange({ ratePlanId: e.target.value })}
            >
              {plans.length === 0 && <option value="">No rate plan</option>}
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Check-in" className="col-span-1">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={room.checkIn}
              onChange={(e) => {
                const checkIn = e.target.value;
                // Keep the stay length when the arrival date moves past the departure.
                const checkOut =
                  isValidDate(checkIn) && room.checkOut <= checkIn
                    ? addDays(checkIn, Math.max(nights, 1))
                    : room.checkOut;
                onChange({ checkIn, checkOut });
              }}
              required
            />
          )}
        </Field>
        <Field label="Check-out" className="col-span-1">
          {(props) => (
            <Input
              {...props}
              type="date"
              value={room.checkOut}
              min={isValidDate(room.checkIn) ? addDays(room.checkIn, 1) : undefined}
              onChange={(e) => onChange({ checkOut: e.target.value })}
              required
            />
          )}
        </Field>
        <Field label="Adults">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={1}
              max={type?.maxAdults ?? 30}
              value={room.adults}
              onChange={(e) => onChange({ adults: Math.max(1, Number(e.target.value) || 1) })}
              required
            />
          )}
        </Field>
        <Field label="Children">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={0}
              max={type?.maxChildren ?? 30}
              value={room.children}
              onChange={(e) => onChange({ children: Math.max(0, Number(e.target.value) || 0) })}
            />
          )}
        </Field>
        <Field label={type?.assignment === 'at_booking' ? 'Unit' : 'Room'} className="col-span-2">
          {(props) => (
            <Select
              {...props}
              value={room.unitId}
              onChange={(e) => onChange({ unitId: e.target.value })}
            >
              <option value="">
                {type?.assignment === 'at_booking' ? 'Choose automatically' : 'Assign at check-in'}
              </option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Rate per night"
          optional
          className="col-span-2"
          hint="Leave empty to use the rate plan."
        >
          {(props) => (
            <Input
              {...props}
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={room.customRate}
              onChange={(e) => onChange({ customRate: e.target.value })}
              placeholder={
                quote && nights > 0
                  ? String(Math.round(fromMinor(quote.total / nights, currency)))
                  : ''
              }
            />
          )}
        </Field>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {valid && (
          <p className="flex items-center gap-2 text-[13px] text-ink-soft">
            <span>{plural(nights, 'night')}</span>
            <span aria-hidden>·</span>
            {total !== null ? (
              <span className="font-medium text-ink">{formatMoney(total, currency)}</span>
            ) : quoteLoading ? (
              <Spinner className="size-3.5" />
            ) : (
              <span>No price: enter a rate per night</span>
            )}
            <span className="text-ink-faint">before tax</span>
          </p>
        )}
        {soldOut.length > 0 && (
          <Notice tone="danger">
            No {type?.name ?? 'room'} left on {soldOut.slice(0, 4).map(formatDay).join(', ')}
            {soldOut.length > 4 ? ` and ${soldOut.length - 4} more nights` : ''}.
          </Notice>
        )}
        {quote && quote.violations.length > 0 && (
          <Notice tone="warning" title="This stay breaks a booking rule">
            <ul className="list-disc pl-4">
              {quote.violations.slice(0, 3).map((v) => (
                <li key={`${v.code}-${v.date}`}>{v.message}</li>
              ))}
            </ul>
            Staff bookings may go ahead regardless.
          </Notice>
        )}
      </div>
    </fieldset>
  );
}

function GuestSearch({ onPick }: { onPick: (guest: Guest) => void }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounced(term.trim(), 250);
  const { data, isLoading } = useSWR<{ guests: Guest[] }>(
    debounced.length >= 2 ? `/guests${query({ query: debounced, limit: 6 })}` : null,
  );
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-ink-faint"
        aria-hidden
      />
      <Input
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        placeholder="Find a returning guest by name, email or phone"
        aria-label="Find a returning guest"
        className="pl-8"
      />
      {open && debounced.length >= 2 && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-surface shadow-pop">
          {isLoading ? (
            <p className="px-3 py-2 text-[13px] text-ink-faint">Searching…</p>
          ) : data && data.guests.length > 0 ? (
            <ul>
              {data.guests.map((guest) => (
                <li key={guest.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col px-3 py-2 text-left hover:bg-sunken"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onPick(guest);
                      setTerm('');
                      setOpen(false);
                    }}
                  >
                    <span className="text-sm font-medium text-ink">{guest.name}</span>
                    <span className="text-xs text-ink-faint">
                      {[guest.email, guest.phone].filter(Boolean).join(' · ') ||
                        'No contact details'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2 text-[13px] text-ink-faint">
              No guest found. Enter the details below.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ReservationDialog({
  open,
  onClose,
  onCreated,
  prefill,
  group,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (reservation: Reservation) => void;
  prefill?: ReservationPrefill;
  group?: ReservationGroup;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { properties } = useProperties();
  const writable = useMemo(
    () => properties.filter((p) => auth.can('reservations.write', p.id)),
    [properties, auth],
  );

  const [propertyId, setPropertyId] = useState('');
  const { data: detail } = usePropertyDetail(propertyId || null);
  const [rooms, setRooms] = useState<RoomDraft[]>([]);
  const [guest, setGuest] = useState({ id: '', firstName: '', lastName: '', email: '', phone: '' });
  const [source, setSource] = useState<string>('direct');
  const [notes, setNotes] = useState('');
  const [specialRequests, setSpecialRequests] = useState('');
  const [force, setForce] = useState(false);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<number, { soldOut: string[]; total: number | null }>>(
    {},
  );
  const nextKey = useRef(1);

  // Start from a clean form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPropertyId(group?.propertyId ?? prefill?.propertyId ?? writable[0]?.id ?? '');
    setRooms([]);
    setGuest({ id: '', firstName: '', lastName: '', email: '', phone: '' });
    setSource('direct');
    setNotes('');
    setSpecialRequests('');
    setForce(false);
    setRefused(false);
    setError(null);
    setChecks({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Once the property's room types are known, add the first room.
  useEffect(() => {
    if (!open || !detail || detail.property.id !== propertyId || rooms.length > 0) return;
    const types = detail.roomTypes.filter((t) => t.active);
    const roomTypeId =
      (prefill?.roomTypeId && types.find((t) => t.id === prefill.roomTypeId)?.id) ||
      types[0]?.id ||
      '';
    if (!roomTypeId) return;
    const today = new Date().toISOString().slice(0, 10);
    const checkIn = prefill?.checkIn ?? today;
    const type = types.find((t) => t.id === roomTypeId);
    setRooms([
      {
        key: nextKey.current++,
        roomTypeId,
        ratePlanId: defaultPlanId(detail, roomTypeId),
        unitId: prefill?.unitId ?? '',
        checkIn,
        checkOut: prefill?.checkOut ?? addDays(checkIn, 1),
        adults: Math.min(2, type?.maxAdults ?? 2),
        children: 0,
        customRate: '',
      },
    ]);
  }, [open, detail, propertyId, rooms.length, prefill]);

  const currency = detail?.property.currency ?? 'INR';
  const canOverride = propertyId ? auth.can('reservations.override', propertyId) : false;
  const anySoldOut = rooms.some((r) => (checks[r.key]?.soldOut.length ?? 0) > 0);
  const grandTotal = rooms.reduce((sum, r) => sum + (checks[r.key]?.total ?? 0), 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const reservation = await api<Reservation>('/reservations', {
        body: {
          propertyId,
          source,
          guest: guest.id
            ? { id: guest.id }
            : {
                firstName: guest.firstName.trim(),
                lastName: guest.lastName.trim() || undefined,
                email: guest.email.trim() || null,
                phone: guest.phone.trim() || null,
              },
          rooms: rooms.map((r) => {
            const nights = diffDays(r.checkIn, r.checkOut);
            const custom =
              r.customRate.trim() === '' ? null : toMinor(Number(r.customRate), currency);
            return {
              roomTypeId: r.roomTypeId,
              ratePlanId: r.ratePlanId || null,
              unitId: r.unitId || null,
              checkIn: r.checkIn,
              checkOut: r.checkOut,
              adults: r.adults,
              children: r.children,
              ...(custom !== null
                ? { nightlyRates: Array.from({ length: nights }, () => custom) }
                : {}),
            };
          }),
          notes: notes.trim() || null,
          specialRequests: specialRequests.trim() || null,
          ...(group ? { groupId: group.id } : {}),
          ...(force ? { force: true } : {}),
        },
      });
      toast.success(
        `Reservation ${reservation.code} created`,
        `${reservation.guestName}, ${formatDay(reservation.checkIn)} to ${formatDay(reservation.checkOut)}`,
      );
      onCreated?.(reservation);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      // The server is the authority on availability: it may refuse a stay the
      // preview thought was free (someone else booked it a moment ago).
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
    <Dialog
      open={open}
      onClose={onClose}
      title={group ? `New reservation for ${group.name}` : 'New reservation'}
      description={
        group ? 'It uses a room held for the group where one is left on these nights.' : undefined
      }
      size="lg"
      footer={
        <>
          {grandTotal > 0 && (
            <p className="mr-auto text-sm text-ink-soft">
              Total{' '}
              <span className="font-semibold text-ink">{formatMoney(grandTotal, currency)}</span>{' '}
              <span className="text-ink-faint">before tax</span>
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form="reservation-form"
            variant="primary"
            loading={busy}
            disabled={rooms.length === 0 || (anySoldOut && !force)}
          >
            Create reservation
          </Button>
        </>
      }
    >
      <form id="reservation-form" onSubmit={submit} className="flex flex-col gap-4">
        {error && <Notice tone="danger">{error}</Notice>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Property">
            {(props) => (
              <Select
                {...props}
                value={propertyId}
                onChange={(e) => {
                  setPropertyId(e.target.value);
                  setRooms([]);
                  setChecks({});
                }}
                // A group is at one property; so are its bookings.
                disabled={Boolean(group)}
                required
              >
                {writable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Booked through">
            {(props) => (
              <Select {...props} value={source} onChange={(e) => setSource(e.target.value)}>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {!detail ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : detail.roomTypes.filter((t) => t.active).length === 0 ? (
          <Notice tone="warning">
            This property has no room types yet. Add them under Settings.
          </Notice>
        ) : (
          <>
            {rooms.map((room, index) => (
              <RoomSection
                key={room.key}
                index={index}
                room={room}
                detail={detail}
                currency={currency}
                canRemove={rooms.length > 1}
                groupId={group?.id}
                onChange={(patch) =>
                  setRooms((list) => list.map((r) => (r.key === room.key ? { ...r, ...patch } : r)))
                }
                onRemove={() => {
                  setRooms((list) => list.filter((r) => r.key !== room.key));
                  setChecks(({ [room.key]: _removed, ...rest }) => rest);
                }}
                onCheck={(key, state) => setChecks((current) => ({ ...current, [key]: state }))}
              />
            ))}
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" />}
                onClick={() =>
                  setRooms((list) => {
                    const last = list[list.length - 1];
                    return last ? [...list, { ...last, key: nextKey.current++, unitId: '' }] : list;
                  })
                }
              >
                Add another room
              </Button>
            </div>
          </>
        )}

        {(anySoldOut || refused) && canOverride && (
          <Checkbox
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            label="Book anyway. This overbooks the property and raises an alert."
          />
        )}

        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-soft">Guest</legend>
          {guest.id ? (
            <div className="flex items-center justify-between gap-3 rounded-md bg-brand-50 px-3 py-2">
              <span className="flex items-center gap-2 text-sm text-brand-800">
                <UserCheck className="size-4" aria-hidden />
                <span>
                  <span className="font-medium">
                    {guest.firstName} {guest.lastName}
                  </span>
                  <span className="ml-2 text-brand-700">
                    {[guest.email, guest.phone].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setGuest({ id: '', firstName: '', lastName: '', email: '', phone: '' })
                }
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <GuestSearch
                onPick={(g) =>
                  setGuest({
                    id: g.id,
                    firstName: g.firstName,
                    lastName: g.lastName,
                    email: g.email ?? '',
                    phone: g.phone ?? '',
                  })
                }
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First name">
                  {(props) => (
                    <Input
                      {...props}
                      value={guest.firstName}
                      onChange={(e) => setGuest((g) => ({ ...g, firstName: e.target.value }))}
                      autoComplete="off"
                      required
                    />
                  )}
                </Field>
                <Field label="Last name">
                  {(props) => (
                    <Input
                      {...props}
                      value={guest.lastName}
                      onChange={(e) => setGuest((g) => ({ ...g, lastName: e.target.value }))}
                      autoComplete="off"
                    />
                  )}
                </Field>
                <Field label="Email" optional>
                  {(props) => (
                    <Input
                      {...props}
                      type="email"
                      value={guest.email}
                      onChange={(e) => setGuest((g) => ({ ...g, email: e.target.value }))}
                      autoComplete="off"
                    />
                  )}
                </Field>
                <Field label="Phone" optional>
                  {(props) => (
                    <Input
                      {...props}
                      type="tel"
                      value={guest.phone}
                      onChange={(e) => setGuest((g) => ({ ...g, phone: e.target.value }))}
                      autoComplete="off"
                    />
                  )}
                </Field>
              </div>
            </div>
          )}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Guest requests" optional>
            {(props) => (
              <Textarea
                {...props}
                value={specialRequests}
                onChange={(e) => setSpecialRequests(e.target.value)}
                rows={2}
              />
            )}
          </Field>
          <Field label="Internal notes" optional>
            {(props) => (
              <Textarea
                {...props}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            )}
          </Field>
        </div>
      </form>
    </Dialog>
  );
}
