import { decimalToMinor, type DateString } from '@pms/domain';
import type {
  BookingEvent,
  BookingEventRoom,
  RemoteRestriction,
  RestrictionUpdate,
} from '../adapter';
import type {
  ChannexBooking,
  ChannexBookingRoom,
  ChannexRestrictionUpdate,
  ChannexRestrictionValues,
  ChannexRevision,
} from './client';

/** Channex's name for a channel (`ota_name`) to its short code, for names that carry no code prefix. */
const OTA_NAME_CODES: Record<string, string> = {
  bookingcom: 'BDC',
  airbnb: 'ABB',
  expedia: 'EXP',
  agoda: 'AGO',
  makemytrip: 'MMT',
  goibibo: 'MMT',
  ctrip: 'CTP',
  tripcom: 'CTP',
  vrbo: 'VRB',
  googlehotel: 'GHA',
  googlehotelads: 'GHA',
  hostelworld: 'HWL',
  hotelbeds: 'HBD',
  traveloka: 'TVL',
  yatra: 'YAT',
  cleartrip: 'CLT',
  easemytrip: 'EMT',
  despegar: 'DDC',
  opengds: 'GDS',
  openchannel: 'OPN',
};

/**
 * The channel a booking was sold on. Channex's `unique_id` is the channel
 * code and the channel's reservation number joined by a dash ("BDC-9996013801").
 */
export function channelCodeOf(
  uniqueId: string | null | undefined,
  otaName: string | null | undefined,
): string | null {
  const prefix = /^([A-Z0-9]{2,4})-/.exec(uniqueId ?? '')?.[1];
  if (prefix) return prefix;
  const key = (otaName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return OTA_NAME_CODES[key] ?? (otaName ? otaName.slice(0, 12) : null);
}

/** Channex timestamps are UTC, usually written without a zone. */
export function parseChannexTime(value: string | null | undefined): Date {
  if (!value) return new Date(NaN);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : `${value}Z`);
}

/**
 * Room prices before tax. Channels state per-night prices that may or may
 * not already include some taxes; the PMS keeps accommodation charges net of
 * tax, so the share of taxes marked as included is taken out, proportionally
 * per night, with any rounding remainder on the last night.
 */
function netRoomPrices(
  room: ChannexBookingRoom,
  currency: string,
): { nightly: Record<DateString, number> | null; amount: number | null } {
  const gross = decimalToMinor(room.amount, currency);
  const included = (room.taxes ?? [])
    .filter((t) => t.is_inclusive)
    .reduce((sum, t) => sum + (decimalToMinor(t.total_price, currency) ?? 0), 0);
  const net = gross !== null ? Math.max(0, gross - Math.min(included, gross)) : null;

  const days = Object.entries((room.days ?? {}) as Record<string, string | number>)
    .map(([date, value]) => [date, decimalToMinor(value, currency)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0 || days.some(([, v]) => v === null)) return { nightly: null, amount: net };

  const daysTotal = days.reduce((sum, [, v]) => sum + v!, 0);
  if (included === 0 || daysTotal === 0) {
    return { nightly: Object.fromEntries(days.map(([d, v]) => [d, v!])), amount: net ?? daysTotal };
  }
  const target = Math.max(0, daysTotal - Math.min(included, daysTotal));
  const nightly: Record<DateString, number> = {};
  let assigned = 0;
  days.forEach(([date, value], index) => {
    const share =
      index === days.length - 1 ? target - assigned : Math.round((value! * target) / daysTotal);
    nightly[date] = Math.max(0, share);
    assigned += nightly[date]!;
  });
  return { nightly, amount: target };
}

function roomOf(room: ChannexBookingRoom, currency: string): BookingEventRoom {
  const prices = netRoomPrices(room, currency);
  const guest = room.guests?.[0];
  const meta = (room.meta ?? {}) as { parent_rate_plan_id?: string | null };
  return {
    externalRoomTypeId: room.room_type_id,
    // A booking on a derived rate or an occupancy option belongs to the plan it derives from.
    externalRatePlanId: meta.parent_rate_plan_id ?? room.rate_plan_id,
    checkIn: room.checkin_date,
    checkOut: room.checkout_date,
    adults: room.occupancy?.adults ?? 1,
    children: room.occupancy?.children ?? 0,
    nightlyRates: prices.nightly,
    amount: prices.amount,
    guestName: guest ? `${guest.name ?? ''} ${guest.surname ?? ''}`.trim() || null : null,
    externalRoomRef: room.booking_room_id ?? room.ota_unique_id ?? null,
  };
}

/**
 * What is kept of a revision for diagnosis. Card details are dropped (the
 * PMS never stores them, masked or not) and so is the channel's verbatim
 * message, which repeats the guest's details in a form nothing here reads.
 */
function storable(revision: ChannexRevision | ChannexBooking): Record<string, unknown> {
  const { guarantee, raw_message: _rawMessage, ...rest } = revision;
  return {
    ...rest,
    guarantee: guarantee
      ? {
          card_type: guarantee.card_type,
          is_virtual: guarantee.is_virtual,
          last4: guarantee.card_number?.slice(-4),
        }
      : null,
  };
}

function notesOf(revision: ChannexRevision | ChannexBooking): string | null {
  const lines: string[] = [];
  if (revision.notes?.trim()) lines.push(revision.notes.trim());
  const services = [
    ...(revision.services ?? []),
    ...revision.rooms.flatMap((r) => r.services ?? []),
  ];
  if (services.length > 0) {
    lines.push(
      `Extras booked: ${services.map((s) => `${s.name}${s.total_price ? ` (${s.total_price} ${revision.currency})` : ''}`).join(', ')}`,
    );
  }
  const infants = revision.rooms.reduce((sum, r) => sum + (r.occupancy?.infants ?? 0), 0);
  if (infants > 0) lines.push(`Infants: ${infants}`);
  if (revision.guarantee?.is_virtual) lines.push('Paid by virtual card issued by the channel.');
  return lines.length > 0 ? lines.join('\n') : null;
}

function toEvent(
  revision: ChannexRevision | ChannexBooking,
  ids: { revisionId: string; bookingId: string },
): BookingEvent {
  const currency = revision.currency;
  const customer = revision.customer;
  const company = customer?.company as string | { title?: string } | null | undefined;
  return {
    revisionId: ids.revisionId,
    bookingId: ids.bookingId,
    revisionAt: parseChannexTime(revision.inserted_at),
    status: revision.status,
    channelCode: channelCodeOf(revision.unique_id, revision.ota_name),
    channelReservationCode: revision.ota_reservation_code || null,
    currency,
    totalAmount: decimalToMinor(revision.amount, currency),
    commissionAmount: decimalToMinor(revision.ota_commission, currency),
    // "ota" means the channel has taken the guest's money; anything else is settled at the property.
    paymentCollect: revision.payment_collect === 'ota' ? 'channel' : 'property',
    arrivalTime: revision.arrival_hour,
    notes: notesOf(revision),
    guest: {
      firstName: customer?.name ?? '',
      lastName: customer?.surname ?? '',
      email: customer?.mail ?? null,
      phone: customer?.phone ?? null,
      country: customer?.country ?? null,
      language: customer?.language ?? null,
      city: customer?.city && customer.city !== '.' ? customer.city : null,
      addressLine1: customer?.address ?? null,
      postalCode: customer?.zip ?? null,
      company: typeof company === 'string' ? company : (company?.title ?? null),
    },
    // A room cancelled out of a multi-room booking stays listed, flagged; it is no longer part of the stay.
    rooms: revision.rooms.filter((r) => !r.is_cancelled).map((r) => roomOf(r, currency)),
    raw: storable(revision),
  };
}

export function revisionToEvent(revision: ChannexRevision): BookingEvent {
  return toEvent(revision, { revisionId: revision.id, bookingId: revision.booking_id });
}

/** A booking from the bookings list (its latest state), for the first import. */
export function bookingToEvent(booking: ChannexBooking): BookingEvent {
  return toEvent(booking, { revisionId: booking.revision_id, bookingId: booking.id });
}

/** One PMS rate-and-restriction range in Channex's terms. */
export function restrictionToChannex(
  propertyId: string,
  update: RestrictionUpdate,
): { value: ChannexRestrictionUpdate; warning?: string } {
  const value: ChannexRestrictionUpdate = {
    property_id: propertyId,
    rate_plan_id: update.externalRatePlanId,
    date_from: update.dateFrom,
    date_to: update.dateTo,
    min_stay_arrival: Math.max(1, update.minStayArrival),
    min_stay_through: Math.max(1, update.minStayThrough),
    // Channex writes "no maximum" as 0.
    max_stay: update.maxStay ?? 0,
    closed_to_arrival: update.closedToArrival,
    closed_to_departure: update.closedToDeparture,
    stop_sell: update.stopSell,
  };
  if (update.rate > 0) {
    // Whole minor units, which Channex reads as "the minimum fraction of the currency".
    value.rate = update.rate;
    return { value };
  }
  // Channex refuses a zero price. The engine has already closed such nights for sale; say so.
  return {
    value,
    warning: `Rate plan ${update.externalRatePlanId} has no price from ${update.dateFrom} to ${update.dateTo}; those nights are closed for sale until a price is set.`,
  };
}

export const DRIFT_RESTRICTION_KINDS = [
  'rate',
  'min_stay_arrival',
  'min_stay_through',
  'max_stay',
  'closed_to_arrival',
  'closed_to_departure',
  // "Closed because someone closed it", as opposed to closed for lack of rooms or price.
  'stop_sell_manual',
] as const;

export function restrictionFromChannex(
  values: ChannexRestrictionValues,
  currency: string,
): RemoteRestriction {
  const out: RemoteRestriction = {};
  if (values.rate !== undefined && values.rate !== null) {
    const rate = decimalToMinor(values.rate, currency);
    if (rate !== null) out.rate = rate;
  }
  if (values.min_stay_arrival !== undefined) out.minStayArrival = values.min_stay_arrival;
  if (values.min_stay_through !== undefined) out.minStayThrough = values.min_stay_through;
  if (values.max_stay !== undefined) out.maxStay = values.max_stay === 0 ? null : values.max_stay;
  if (values.closed_to_arrival !== undefined) out.closedToArrival = values.closed_to_arrival;
  if (values.closed_to_departure !== undefined) out.closedToDeparture = values.closed_to_departure;
  if (values.stop_sell_manual !== undefined) out.stopSell = values.stop_sell_manual;
  else if (values.stop_sell !== undefined) out.stopSell = values.stop_sell;
  return out;
}
