'use client';

import {
  ArrowLeft,
  Ban,
  BedDouble,
  Building2,
  CalendarClock,
  ListPlus,
  LockOpen,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { ReservationDialog } from '@/components/reservations/reservation-dialog';
import { ReservationPanel } from '@/components/reservations/reservation-panel';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/dialog';
import {
  Badge,
  Card,
  ErrorState,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  PageLoading,
  STATUS_TONES as BOOKING_TONES,
} from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  STATUS_LABELS as BOOKING_LABELS,
  formatDate,
  formatDateTime,
  formatMoney,
  formatStay,
  plural,
} from '@/lib/format';
import { useCurrentProperty } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { ExistingBookingDialog } from './existing-booking-dialog';
import { GroupDialog } from './group-dialog';
import { HoldDialog } from './hold-dialog';
import { NightGrid } from './night-grid';
import { RoomingListDialog } from './rooming-list-dialog';
import type { Group, GroupBooking, GroupHold } from './types';
import { STATUS_LABELS, STATUS_TONES, datesText } from './words';

type Open =
  | { kind: 'book' }
  | { kind: 'list' }
  | { kind: 'existing' }
  | { kind: 'edit' }
  | { kind: 'hold'; hold?: GroupHold }
  | { kind: 'release' }
  | { kind: 'cancel' }
  | { kind: 'booking'; booking: GroupBooking };

function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className="tabular mt-1 text-lg font-semibold text-ink">{value}</p>
      {note && <p className="mt-0.5 text-[13px] text-ink-faint">{note}</p>}
    </Card>
  );
}

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
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Detail({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink">
      <span className="mt-0.5 text-ink-faint [&>svg]:size-4">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

function BookingRow({
  booking,
  currency,
  onOpen,
}: {
  booking: GroupBooking;
  currency: string;
  onOpen: () => void;
}) {
  const rooms = booking.rooms
    .map((room) => (room.unitName ? `${room.roomTypeName} ${room.unitName}` : room.roomTypeName))
    .join(', ');
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-2 py-2.5 text-left hover:bg-sunken"
      >
        <span className="min-w-0 flex-1 basis-40">
          <span className="block truncate text-sm font-medium text-ink">{booking.guestName}</span>
          <span className="block font-mono text-xs text-ink-faint">{booking.code}</span>
        </span>
        <span className="basis-40 text-[13px] text-ink-soft">
          <span className="block">{formatStay(booking.checkIn, booking.checkOut)}</span>
          <span className="block truncate text-ink-faint">{rooms}</span>
        </span>
        <span className="flex items-center gap-3">
          <Badge tone={BOOKING_TONES[booking.status]}>{BOOKING_LABELS[booking.status]}</Badge>
          <span className="tabular w-24 text-right text-sm text-ink">
            {formatMoney(booking.totalAmount, currency)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** One group: the rooms held for it, how its guests are booking them, and its bookings. */
export function GroupDetailView({ groupId }: { groupId: string }) {
  const auth = useAuth();
  const toast = useToast();
  const { properties, select } = useCurrentProperty();
  const { data: group, error, mutate } = useSWR<Group>(`/groups/${groupId}`);
  const [open, setOpen] = useState<Open | null>(null);
  useLive(/^(group|reservation|block)\./, () => void mutate());
  // The way back to the list should show this group's property, however the page was reached.
  const propertyId = group?.propertyId;
  useEffect(() => {
    if (propertyId) select(propertyId);
  }, [propertyId, select]);

  const back = (
    <Link
      href="/groups"
      className="inline-flex items-center gap-1.5 self-start text-sm text-ink-soft hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden /> Groups
    </Link>
  );

  if (error && !group) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4 sm:p-6">
        {back}
        {gone ? (
          <Notice tone="warning" title="This group was not found">
            It may belong to a property you cannot see.
          </Notice>
        ) : (
          <ErrorState error={error} onRetry={() => void mutate()} />
        )}
      </div>
    );
  }
  if (!group) return <PageLoading label="Loading the group" />;

  const property = properties.find((p) => p.id === group.propertyId);
  const canBook = auth.can('reservations.write', group.propertyId);
  const canHold = auth.can('blocks.write', group.propertyId);
  const live = group.status !== 'cancelled';
  const apply = (next: Group) => void mutate(next, { revalidate: false });
  const close = () => setOpen(null);
  const bookedOfHeld = group.heldNights - group.leftNights;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:p-6">
      {back}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight break-words text-ink">
              {group.name}
            </h1>
            <Badge tone={STATUS_TONES[group.status]}>{STATUS_LABELS[group.status]}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            Group <span className="font-mono">{group.code}</span>
            {property ? ` at ${property.name}` : ''}
          </p>
        </div>
        {live && (canBook || canHold) && (
          <div className="flex flex-wrap items-center gap-2">
            {canBook && (
              <>
                <Button
                  variant="primary"
                  icon={<Plus className="size-4" aria-hidden />}
                  onClick={() => setOpen({ kind: 'book' })}
                >
                  Book a room
                </Button>
                <Button
                  icon={<ListPlus className="size-4" aria-hidden />}
                  onClick={() => setOpen({ kind: 'list' })}
                >
                  Add a rooming list
                </Button>
              </>
            )}
            <Menu
              trigger={
                <Button size="icon" aria-label="More actions" className="size-9">
                  <MoreHorizontal className="size-4" />
                </Button>
              }
            >
              {canBook && (
                <MenuItem icon={<Pencil />} onSelect={() => setOpen({ kind: 'edit' })}>
                  Change details
                </MenuItem>
              )}
              {canHold && (
                <MenuItem icon={<BedDouble />} onSelect={() => setOpen({ kind: 'hold' })}>
                  Hold more rooms
                </MenuItem>
              )}
              {canHold && group.status === 'open' && group.holds.length > 0 && (
                <MenuItem icon={<LockOpen />} onSelect={() => setOpen({ kind: 'release' })}>
                  Release unbooked rooms
                </MenuItem>
              )}
              {canBook && canHold && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Ban />}
                    tone="danger"
                    onSelect={() => setOpen({ kind: 'cancel' })}
                  >
                    Cancel group
                  </MenuItem>
                </>
              )}
            </Menu>
          </div>
        )}
      </div>

      {group.status === 'cancelled' && (
        <Notice tone="danger" title="This group was cancelled">
          No rooms are held for it and it takes no more bookings.
        </Notice>
      )}
      {group.status === 'closed' && (
        <Notice title="The unbooked rooms went back on sale">
          {group.releasedAt ? `Released ${formatDateTime(group.releasedAt)}. ` : ''}
          The bookings below stay. More can still be made for the group from whatever is free.
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label="Dates" value={<span className="text-base">{datesText(group)}</span>} />
        <Figure
          label="Rooms held"
          value={group.heldNights === 0 ? 'None' : plural(group.heldNights, 'room night')}
          note={
            group.heldNights > 0
              ? `${bookedOfHeld} booked, ${group.leftNights} still to book`
              : undefined
          }
        />
        <Figure
          label="Bookings"
          value={group.bookings}
          note={plural(group.bookedNights, 'room night')}
        />
        <Figure
          label="Room charges"
          value={formatMoney(group.value, group.currency)}
          note="Before tax"
        />
      </div>

      {group.nights.length > 0 && (
        <Section title="Night by night">
          <NightGrid group={group} />
          {group.nights.some((night) => night.held === 0 && night.booked > 0) && (
            <p className="mt-2 text-[13px] text-ink-faint">
              A dashed number is a booking on a night with no rooms held: it was taken from what was
              free for everyone.
            </p>
          )}
        </Section>
      )}

      <Section
        title="Rooms held"
        action={
          live &&
          canHold && (
            <Button size="sm" onClick={() => setOpen({ kind: 'hold' })}>
              Hold more rooms
            </Button>
          )
        }
      >
        {group.holds.length === 0 ? (
          <p className="text-sm text-ink-soft">
            {group.status === 'open'
              ? 'No rooms are held. Bookings for the group are made from what is free for everyone.'
              : 'No rooms are held any more.'}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {group.holds.map((hold) => (
              <li key={hold.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className="min-w-0 flex-1 basis-40 text-sm font-medium text-ink">
                  {plural(hold.quantity, 'room')} · {hold.roomTypeName}
                </span>
                <span className="text-[13px] text-ink-soft">{formatStay(hold.from, hold.to)}</span>
                {canHold && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Change the ${hold.roomTypeName} rooms held ${formatStay(hold.from, hold.to)}`}
                    onClick={() => setOpen({ kind: 'hold', hold })}
                  >
                    Change
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {group.cutoffDate && group.status === 'open' && (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-ink-soft">
            <CalendarClock className="size-4 text-ink-faint" aria-hidden />
            Rooms nobody has booked by the end of {formatDate(group.cutoffDate)} go back on sale.
          </p>
        )}
      </Section>

      <Section
        title={`Bookings (${group.reservations.length})`}
        action={
          live &&
          canBook && (
            <Button size="sm" onClick={() => setOpen({ kind: 'existing' })}>
              Add an existing booking
            </Button>
          )
        }
      >
        {group.reservations.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Nobody has booked yet.
            {live && canBook ? ' Book a room, or add the whole rooming list at once.' : ''}
          </p>
        ) : (
          <ul className="-mx-2 divide-y divide-line">
            {group.reservations.map((booking) => (
              <BookingRow
                key={booking.id}
                booking={booking}
                currency={group.currency}
                onOpen={() => setOpen({ kind: 'booking', booking })}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Details"
        action={
          live &&
          canBook && (
            <Button size="sm" variant="ghost" onClick={() => setOpen({ kind: 'edit' })}>
              Change
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-2">
          <Detail icon={<UserRound />}>{group.contactName ?? 'No contact given'}</Detail>
          {group.contactEmail && (
            <Detail icon={<Mail />}>
              <a href={`mailto:${group.contactEmail}`} className="hover:text-brand-700">
                {group.contactEmail}
              </a>
            </Detail>
          )}
          {group.contactPhone && (
            <Detail icon={<Phone />}>
              <a href={`tel:${group.contactPhone}`} className="hover:text-brand-700">
                {group.contactPhone}
              </a>
            </Detail>
          )}
          {group.company && <Detail icon={<Building2 />}>Booked for {group.company.name}</Detail>}
          {group.notes && (
            <p className="text-sm whitespace-pre-wrap text-ink-soft">{group.notes}</p>
          )}
        </div>
      </Section>

      {property && open?.kind === 'edit' && (
        <GroupDialog property={property} group={group} onClose={close} onSaved={apply} />
      )}
      {property && open?.kind === 'hold' && (
        <HoldDialog
          group={group}
          property={property}
          hold={open.hold}
          onClose={close}
          onSaved={apply}
        />
      )}
      {open?.kind === 'existing' && (
        <ExistingBookingDialog group={group} onClose={close} onAdded={() => void mutate()} />
      )}
      {property && open?.kind === 'list' && (
        <RoomingListDialog group={group} property={property} onClose={close} onSaved={apply} />
      )}
      <ReservationDialog
        open={open?.kind === 'book'}
        onClose={close}
        onCreated={() => void mutate()}
        group={{ id: group.id, name: group.name, propertyId: group.propertyId }}
        prefill={{
          roomTypeId: group.holds[0]?.roomTypeId,
          checkIn: group.from ?? undefined,
          checkOut: group.to ?? undefined,
        }}
      />
      {open?.kind === 'release' && (
        <ConfirmDialog
          title="Release the unbooked rooms?"
          confirmLabel="Release rooms"
          onClose={close}
          onConfirm={async () => {
            apply(await api<Group>(`/groups/${group.id}/release`, { method: 'POST' }));
            toast.success('Rooms released', 'They are back on sale. Booking sites are being told.');
            close();
          }}
        >
          {group.leftNights > 0
            ? `${plural(group.leftNights, 'room night')} held for ${group.name} and not booked go back on sale on your website and the booking sites.`
            : `Every room held for ${group.name} is booked, so nothing goes back on sale now. The group stops holding rooms: one that comes free when a booking is cancelled is then for everyone.`}{' '}
          {group.bookings > 0
            ? `The ${plural(group.bookings, 'booking')} already made stay as they are.`
            : ''}
        </ConfirmDialog>
      )}
      {open?.kind === 'cancel' && (
        <ConfirmDialog
          title={`Cancel ${group.name}?`}
          confirmLabel="Cancel group"
          onClose={close}
          onConfirm={async () => {
            apply(await api<Group>(`/groups/${group.id}/cancel`, { method: 'POST' }));
            toast.success('Group cancelled', 'Its rooms are back on sale.');
            close();
          }}
        >
          The rooms held for it go back on sale and it takes no more bookings. Bookings that still
          stand have to be cancelled first, each with its own terms.
        </ConfirmDialog>
      )}
      <Drawer
        open={open?.kind === 'booking'}
        onClose={close}
        title={open?.kind === 'booking' ? `Reservation ${open.booking.code}` : 'Reservation'}
        description={open?.kind === 'booking' ? open.booking.guestName : undefined}
      >
        {open?.kind === 'booking' && (
          <ReservationPanel reservationId={open.booking.id} onChanged={() => void mutate()} />
        )}
      </Drawer>
    </div>
  );
}
