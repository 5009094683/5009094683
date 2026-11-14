import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  bookingRevisions,
  channelConnections,
  channelRateMappings,
  channelRoomMappings,
  inventoryBlocks,
  properties,
  ratePlans,
  reservationNights,
  reservationRooms,
  reservations,
  roomTypes,
  type Database,
  type DbOrTx,
  type RevisionStatus,
  type Transaction,
} from '@pms/db';
import {
  addReservationRoom,
  cancelReservation,
  channelActor,
  createBlock,
  createReservation,
  eachDate,
  emit,
  formatMoney,
  isDomainError,
  isValidDate,
  invalidState,
  notFound,
  raiseAlert,
  reinstateReservation,
  releaseBlock,
  resolveAlert,
  todayIn,
  transact,
  updateBlock,
  updateReservation,
  updateReservationRoom,
  validationError,
  writeAudit,
  type Actor,
  type DateString,
  type GuestInput,
  type ReservationOptions,
  type RoomInput,
  type RoomPatch,
} from '@pms/domain';
import {
  createAdapter,
  deserializeBookingEvent,
  serializeBookingEvent,
  type BookingEvent,
  type BookingEventRoom,
  type ChannelAdapter,
  type StoredBookingEvent,
} from '../adapter';
import { adapterContext, adapterFor, writeSyncLog, type ConnectionRow } from './connections';

export type ReceivedVia = 'webhook' | 'poll' | 'import';
type RevisionRow = typeof bookingRevisions.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;
type RoomRow = typeof reservationRooms.$inferSelect;

/** A booking a channel has confirmed to a guest is recorded whatever the PMS thinks of it. */
const CHANNEL_BOOKING: ReservationOptions = { allowOverbooking: true, skipOccupancyLimits: true };

/** Waits before a failed revision is tried again; after the last one it waits for a person. */
const RETRY_DELAYS_S = [30, 120, 600, 1800, 7200];
/** Failed acknowledgements before staff are told. The channel keeps re-sending meanwhile. */
const ACK_FAILURES_BEFORE_ALERT = 5;

export interface IngestResult {
  /** Row id of the stored revision. */
  id: string;
  externalRevisionId: string;
  externalBookingId: string;
  status: RevisionStatus;
  /** True when this revision had been received before. */
  duplicate: boolean;
  reservationId: string | null;
  acknowledged: boolean;
  error?: string;
}

export interface ApplyResult {
  status: RevisionStatus;
  reservationId: string | null;
  /** False when the revision was already settled and nothing was done. */
  changed: boolean;
  error?: string;
}

const CHANNEL_NAMES: Record<string, string> = {
  BDC: 'Booking.com',
  ABB: 'Airbnb',
  EXP: 'Expedia',
  AGO: 'Agoda',
  MMT: 'MakeMyTrip',
  GIB: 'Goibibo',
  CTP: 'Trip.com',
  VRB: 'Vrbo',
  GHA: 'Google',
  HWD: 'Hostelworld',
  TRA: 'Traveloka',
  YAT: 'Yatra',
  CLT: 'Cleartrip',
  EMT: 'EaseMyTrip',
  TBO: 'TBO',
  HBD: 'Hotelbeds',
};

export function channelName(code: string | null | undefined): string {
  if (!code) return 'the channel';
  return CHANNEL_NAMES[code.toUpperCase()] ?? code;
}

function bookingLockKey(connectionId: string, bookingId: string): string {
  return `pms-booking:${connectionId}:${bookingId}`;
}

// ---------------------------------------------------------------------------
// 1. Store

/**
 * Writes the message down before anything is done with it. The unique key on
 * (connection, revision id) makes a repeated delivery land on the same row.
 */
async function storeRevision(
  db: DbOrTx,
  connection: ConnectionRow,
  event: BookingEvent,
  via: ReceivedVia,
): Promise<{ id: string; isNew: boolean }> {
  const revisionAt = Number.isNaN(event.revisionAt.getTime()) ? new Date() : event.revisionAt;
  const stored = serializeBookingEvent({ ...event, revisionAt });
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO booking_revisions
      (connection_id, external_revision_id, external_booking_id, channel_code, received_via, revision_at, raw, event)
    VALUES (${connection.id}, ${event.revisionId}, ${event.bookingId}, ${event.channelCode}, ${via},
            ${revisionAt.toISOString()}::timestamptz, ${JSON.stringify(event.raw)}::jsonb, ${JSON.stringify(stored)}::jsonb)
    ON CONFLICT (connection_id, external_revision_id) DO NOTHING
    RETURNING id
  `);
  if (rows[0]) return { id: rows[0].id, isNew: true };
  const [existing] = await db
    .select({ id: bookingRevisions.id })
    .from(bookingRevisions)
    .where(
      and(
        eq(bookingRevisions.connectionId, connection.id),
        eq(bookingRevisions.externalRevisionId, event.revisionId),
      ),
    );
  return { id: existing!.id, isNew: false };
}

// ---------------------------------------------------------------------------
// 2. Apply

interface ResolvedRoom extends RoomInput {
  ratePlanId: string | null;
  externalRoomRef: string | null;
}

interface Resolution {
  rooms: ResolvedRoom[];
  /** Channel room ids that have no mapping. Any entry stops the booking from being applied. */
  unmapped: string[];
  reviewReasons: string[];
  notes: string[];
  sameCurrency: boolean;
}

/** Spreads what the channel charged over the nights of the stay. */
function nightlyRatesOf(room: BookingEventRoom, dates: DateString[]): number[] | undefined {
  if (room.nightlyRates) {
    const perNight = dates.map((d) => room.nightlyRates![d]);
    if (perNight.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      return perNight.map((v) => Math.round(v as number));
    }
  }
  if (room.amount !== null && Number.isFinite(room.amount) && room.amount >= 0) {
    const total = Math.round(room.amount);
    const base = Math.floor(total / dates.length);
    const remainder = total - base * dates.length;
    return dates.map((_, i) => base + (i < remainder ? 1 : 0));
  }
  return undefined;
}

async function resolveRooms(
  tx: Transaction,
  connection: ConnectionRow,
  property: PropertyRow,
  event: BookingEvent,
): Promise<Resolution> {
  const roomMappings = await tx
    .select()
    .from(channelRoomMappings)
    .where(eq(channelRoomMappings.connectionId, connection.id));
  const rateMappings = await tx
    .select({
      externalRatePlanId: channelRateMappings.externalRatePlanId,
      ratePlanId: channelRateMappings.ratePlanId,
      roomTypeId: ratePlans.roomTypeId,
    })
    .from(channelRateMappings)
    .innerJoin(ratePlans, eq(ratePlans.id, channelRateMappings.ratePlanId))
    .where(eq(channelRateMappings.connectionId, connection.id));
  const roomByExternal = new Map(roomMappings.map((m) => [m.externalRoomTypeId, m.roomTypeId]));
  const rateByExternal = new Map(rateMappings.map((m) => [m.externalRatePlanId, m]));
  // A property that sells one thing (a villa) leaves no doubt about what was booked.
  const sellable = await tx
    .select({ id: roomTypes.id, name: roomTypes.name })
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, connection.propertyId), eq(roomTypes.active, true)));
  const onlyRoomType = sellable.length === 1 ? sellable[0]!.id : undefined;
  /** The one room type whose name is, contains, or is contained in the name the source used. */
  const byName = (name: string | null | undefined): string | undefined => {
    const wanted = name?.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!wanted) return undefined;
    const exact = sellable.filter((t) => t.name.toLowerCase() === wanted);
    if (exact.length === 1) return exact[0]!.id;
    const close = sellable.filter((t) => {
      const own = t.name.toLowerCase();
      return wanted.includes(own) || own.includes(wanted);
    });
    return close.length === 1 ? close[0]!.id : undefined;
  };

  const sameCurrency =
    !event.currency || event.currency.toUpperCase() === property.currency.toUpperCase();
  const result: Resolution = {
    rooms: [],
    unmapped: [],
    reviewReasons: [],
    notes: [],
    sameCurrency,
  };
  const review = (reason: string): void => {
    if (!result.reviewReasons.includes(reason)) result.reviewReasons.push(reason);
  };

  for (const [index, room] of event.rooms.entries()) {
    if (
      !isValidDate(room.checkIn) ||
      !isValidDate(room.checkOut) ||
      room.checkOut <= room.checkIn
    ) {
      throw validationError(
        `Room ${index + 1} of the booking has unusable dates (${String(room.checkIn)} to ${String(room.checkOut)})`,
      );
    }
    let roomTypeId: string;
    let unitId: string | undefined;
    if (room.internal) {
      roomTypeId = room.internal.roomTypeId;
      unitId = room.internal.unitId;
    } else {
      const mapped =
        (room.externalRoomTypeId ? roomByExternal.get(room.externalRoomTypeId) : undefined) ??
        byName(room.externalRoomName) ??
        onlyRoomType;
      if (!mapped) {
        result.unmapped.push(room.externalRoomName ?? room.externalRoomTypeId ?? '(no room given)');
        continue;
      }
      roomTypeId = mapped;
    }

    let ratePlanId: string | null = null;
    if (room.externalRatePlanId) {
      const rate = rateByExternal.get(room.externalRatePlanId);
      if (rate && rate.roomTypeId === roomTypeId) ratePlanId = rate.ratePlanId;
      else if (rate)
        review('The rate plan the channel sent belongs to a different room type here.');
      // A rate plan with no mapping is not fatal: the booking keeps the channel's own prices.
    }

    const dates = eachDate(room.checkIn, room.checkOut);
    const nightlyRates = sameCurrency ? nightlyRatesOf(room, dates) : undefined;
    if (!nightlyRates && !ratePlanId) {
      review(
        'The channel sent no usable price and the rate plan is not mapped, so the amount is zero.',
      );
    }
    result.rooms.push({
      roomTypeId,
      ratePlanId,
      unitId,
      checkIn: room.checkIn,
      checkOut: room.checkOut,
      adults: Math.max(1, Math.trunc(room.adults) || 1),
      children: Math.max(0, Math.trunc(room.children) || 0),
      guestName: room.guestName?.trim() || null,
      nightlyRates,
      externalRoomRef: room.externalRoomRef,
    });
  }

  if (!sameCurrency && event.currency) {
    const total =
      event.totalAmount !== null ? ` (${formatMoney(event.totalAmount, event.currency)})` : '';
    result.notes.push(
      `Sold in ${event.currency}${total}. Amounts here are priced from the PMS rate plan in ${property.currency}, not converted from the channel.`,
    );
    review(`Sold in ${event.currency}, not ${property.currency}: check the amounts.`);
  }
  return result;
}

function guestInputOf(event: BookingEvent): GuestInput {
  let first = (event.guest.firstName ?? '').trim();
  let last = (event.guest.lastName ?? '').trim();
  if (!first && !last) {
    first = 'Guest';
    last = `(${channelName(event.channelCode)})`;
  } else if (!first) {
    first = last;
    last = '';
  }
  return {
    firstName: first,
    lastName: last,
    email: event.guest.email?.trim() || null,
    phone: event.guest.phone?.trim() || null,
    language: event.guest.language ?? null,
    country: event.guest.country ?? null,
    city: event.guest.city ?? null,
    addressLine1: event.guest.addressLine1 ?? null,
    postalCode: event.guest.postalCode ?? null,
    company: event.guest.company ?? null,
  };
}

function guestNameOf(event: BookingEvent): string {
  const guest = guestInputOf(event);
  return `${guest.firstName ?? ''} ${guest.lastName ?? ''}`.trim();
}

/** Marks a reservation for a person to look at, and tells staff why. */
async function flagForReview(
  tx: Transaction,
  connection: ConnectionRow,
  property: PropertyRow,
  reservation: Pick<ReservationRow, 'id' | 'code' | 'guestName'>,
  reason: string,
  alert: boolean,
): Promise<void> {
  await tx
    .update(reservations)
    .set({ needsReview: true, reviewReason: reason.slice(0, 1000) })
    .where(eq(reservations.id, reservation.id));
  if (!alert) return;
  await raiseAlert(tx, {
    orgId: connection.orgId,
    propertyId: connection.propertyId,
    kind: 'booking_needs_review',
    severity: 'warning',
    title: `${property.name}: reservation ${reservation.code} needs a look`,
    body: `${reservation.guestName}: ${reason}`,
    entityType: 'reservation',
    entityId: reservation.id,
    dedupeKey: `booking_review:${reservation.id}`,
  });
}

/**
 * Creates the reservation. A source tied to one unit (a calendar feed) names
 * the unit; if that unit is already taken the booking is still recorded,
 * unassigned and flagged, rather than refused.
 */
async function createFromEvent(
  tx: Transaction,
  actor: Actor,
  connection: ConnectionRow,
  event: BookingEvent,
  resolution: Resolution,
): Promise<{ id: string; code: string; guestName: string }> {
  const reviewReasons = [...resolution.reviewReasons];
  if (event.needsReview) reviewReasons.unshift(event.needsReview);
  const build = (rooms: ResolvedRoom[]) => ({
    propertyId: connection.propertyId,
    status: 'confirmed' as const,
    source: 'ota' as const,
    channelCode: event.channelCode,
    connectionId: connection.id,
    externalId: event.bookingId,
    channelReservationCode: event.channelReservationCode,
    externalRevisionAt: event.revisionAt,
    guest: guestInputOf(event),
    rooms,
    paymentCollect: event.paymentCollect ?? ('property' as const),
    commissionAmount:
      resolution.sameCurrency && event.commissionAmount !== null
        ? Math.max(0, Math.round(event.commissionAmount))
        : 0,
    arrivalTime: event.arrivalTime,
    specialRequests: event.notes,
    notes: resolution.notes.join('\n') || null,
    needsReview: reviewReasons.length > 0,
    reviewReason: reviewReasons.join(' ').slice(0, 1000) || null,
  });
  try {
    return await createReservation(tx, actor, build(resolution.rooms), CHANNEL_BOOKING);
  } catch (err) {
    if (!isDomainError(err, 'unit_occupied') || !resolution.rooms.some((r) => r.unitId)) throw err;
    // Let the ledger place it (or leave it unassigned and raise the overbooking alert).
    return createReservation(
      tx,
      actor,
      build(resolution.rooms.map((r) => ({ ...r, unitId: undefined }))),
      CHANNEL_BOOKING,
    );
  }
}

/** Pairs the rooms a revision lists with the rooms the reservation has. */
function matchRooms(
  live: RoomRow[],
  incoming: ResolvedRoom[],
): { pairs: { room: RoomRow; next: ResolvedRoom }[]; added: ResolvedRoom[]; removed: RoomRow[] } {
  const freeRooms = new Set(live);
  const freeIncoming = new Set(incoming);
  const pairs: { room: RoomRow; next: ResolvedRoom }[] = [];
  const passes: ((room: RoomRow, next: ResolvedRoom) => boolean)[] = [
    (room, next) => next.externalRoomRef !== null && room.externalRoomRef === next.externalRoomRef,
    (room, next) =>
      room.roomTypeId === next.roomTypeId &&
      room.checkIn === next.checkIn &&
      room.checkOut === next.checkOut,
    (room, next) => room.roomTypeId === next.roomTypeId,
    () => true,
  ];
  for (const matches of passes) {
    for (const next of incoming) {
      if (!freeIncoming.has(next)) continue;
      const room = [...freeRooms].find((r) => matches(r, next));
      if (!room) continue;
      pairs.push({ room, next });
      freeRooms.delete(room);
      freeIncoming.delete(next);
    }
  }
  return { pairs, added: [...freeIncoming], removed: [...freeRooms] };
}

async function modifyFromEvent(
  tx: Transaction,
  actor: Actor,
  connection: ConnectionRow,
  property: PropertyRow,
  existing: ReservationRow,
  event: BookingEvent,
  resolution: Resolution,
): Promise<void> {
  const who = channelName(event.channelCode);
  const manual: string[] = [];

  if (existing.status === 'checked_out' || existing.status === 'no_show') {
    await tx
      .update(reservations)
      .set({ externalRevisionAt: event.revisionAt })
      .where(eq(reservations.id, existing.id));
    await flagForReview(
      tx,
      connection,
      property,
      existing,
      `${who} changed this booking after ${existing.status === 'no_show' ? 'it was marked a no-show' : 'the guest checked out'}. Nothing was changed here; compare it with the channel.`,
      true,
    );
    return;
  }
  if (existing.status === 'cancelled') {
    // The channel has brought a cancelled booking back.
    await reinstateReservation(tx, actor, existing.id, CHANNEL_BOOKING);
  }

  const current = await tx
    .select()
    .from(reservationRooms)
    .where(eq(reservationRooms.reservationId, existing.id))
    .orderBy(asc(reservationRooms.position));
  const live = current.filter((r) => r.status !== 'cancelled' && r.status !== 'no_show');
  const { pairs, added, removed } = matchRooms(live, resolution.rooms);

  for (const { room, next } of pairs) {
    const patch: RoomPatch = {};
    if (next.roomTypeId !== room.roomTypeId) patch.roomTypeId = next.roomTypeId;
    if (next.ratePlanId !== room.ratePlanId) patch.ratePlanId = next.ratePlanId;
    if (next.checkIn !== room.checkIn) patch.checkIn = next.checkIn;
    if (next.checkOut !== room.checkOut) patch.checkOut = next.checkOut;
    if (next.adults !== room.adults) patch.adults = next.adults;
    if ((next.children ?? 0) !== room.children) patch.children = next.children ?? 0;
    if (next.guestName && next.guestName !== room.guestName) patch.guestName = next.guestName;
    if (next.nightlyRates) {
      const nights = await tx
        .select()
        .from(reservationNights)
        .where(eq(reservationNights.reservationRoomId, room.id));
      const have = new Map(nights.map((n) => [n.date, n.amount]));
      const dates = eachDate(next.checkIn, next.checkOut);
      const repriced =
        nights.length !== dates.length ||
        dates.some((d, i) => have.get(d) !== next.nightlyRates![i]);
      if (repriced || Object.keys(patch).length > 0) patch.nightlyRates = next.nightlyRates;
    }
    if (Object.keys(patch).length === 0) continue;

    if (room.status === 'checked_out') {
      manual.push('a room that has already checked out was changed on the channel');
      continue;
    }
    if (room.status === 'in_house' && patch.checkIn !== undefined) {
      // The guest is here; their actual arrival stands. Apply the rest.
      manual.push(`the channel moved the arrival date to ${patch.checkIn} after check-in`);
      delete patch.checkIn;
      if (patch.nightlyRates) {
        const given = patch.nightlyRates;
        const byDate = new Map(eachDate(next.checkIn, next.checkOut).map((d, i) => [d, given[i]!]));
        const fallback = given[0] ?? 0;
        patch.nightlyRates = eachDate(room.checkIn, next.checkOut).map(
          (d) => byDate.get(d) ?? fallback,
        );
      }
      if (Object.keys(patch).length === 0) continue;
    }
    await updateReservationRoom(tx, actor, existing.id, room.id, patch, CHANNEL_BOOKING);
  }

  for (const next of added) {
    try {
      await addReservationRoom(tx, actor, existing.id, next, CHANNEL_BOOKING);
    } catch (err) {
      if (!isDomainError(err, 'unit_occupied') || !next.unitId) throw err;
      await addReservationRoom(
        tx,
        actor,
        existing.id,
        { ...next, unitId: undefined },
        CHANNEL_BOOKING,
      );
    }
  }

  const cancellable = removed.filter((r) => r.status === 'tentative' || r.status === 'confirmed');
  if (cancellable.length > 0) {
    await cancelReservation(tx, actor, existing.id, {
      roomIds: cancellable.map((r) => r.id),
      reason: `Removed on ${who}`,
    });
  }
  if (removed.some((r) => r.status === 'in_house')) {
    manual.push('the channel removed a room whose guest has checked in');
  }

  const commission =
    resolution.sameCurrency && event.commissionAmount !== null
      ? Math.max(0, Math.round(event.commissionAmount))
      : undefined;
  await updateReservation(tx, actor, existing.id, {
    ...(guestNameOf(event) !== existing.guestName ? { guest: guestInputOf(event) } : {}),
    arrivalTime: event.arrivalTime ?? existing.arrivalTime,
    specialRequests: event.notes ?? existing.specialRequests,
    ...(commission !== undefined ? { commissionAmount: commission } : {}),
    ...(event.paymentCollect ? { paymentCollect: event.paymentCollect } : {}),
    channelReservationCode: event.channelReservationCode ?? existing.channelReservationCode,
    externalRevisionAt: event.revisionAt,
  });

  const reasons = [...resolution.reviewReasons];
  if (event.needsReview) reasons.unshift(event.needsReview);
  if (manual.length > 0) {
    reasons.unshift(`Not everything ${who} changed could be applied: ${manual.join('; ')}.`);
  }
  if (reasons.length > 0) {
    await flagForReview(tx, connection, property, existing, reasons.join(' '), manual.length > 0);
  }
}

async function cancelFromEvent(
  tx: Transaction,
  actor: Actor,
  connection: ConnectionRow,
  property: PropertyRow,
  existing: ReservationRow,
  event: BookingEvent,
): Promise<void> {
  const who = channelName(event.channelCode);
  if (existing.status === 'in_house' || existing.status === 'checked_out') {
    // Never throw a guest out of the system because a channel says so.
    await flagForReview(
      tx,
      connection,
      property,
      existing,
      `${who} reported this booking cancelled after the guest ${existing.status === 'in_house' ? 'checked in' : 'checked out'}. It was left as it is.`,
      true,
    );
  } else if (existing.status !== 'cancelled' && existing.status !== 'no_show') {
    await cancelReservation(tx, actor, existing.id, { reason: `Cancelled on ${who}` });
  }
  await tx
    .update(reservations)
    .set({ externalRevisionAt: event.revisionAt })
    .where(eq(reservations.id, existing.id));
}

interface Settled {
  status: RevisionStatus;
  reservationId: string | null;
  note?: string;
}

/**
 * Dates a channel's calendar shows as closed, with no guest behind them. They
 * become a block on the unit. Where the PMS already has those dates taken
 * (often its own reservation, read back from the channel) nothing is added:
 * the dates are unavailable either way, and nothing of the PMS's is disturbed.
 */
async function applyBlockEvent(
  tx: Transaction,
  actor: Actor,
  connection: ConnectionRow,
  event: BookingEvent,
): Promise<Settled> {
  const [existing] = await tx
    .select()
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.connectionId, connection.id),
        eq(inventoryBlocks.externalRef, event.bookingId),
        sql`${inventoryBlocks.releasedAt} IS NULL`,
      ),
    );
  if (event.status === 'cancelled') {
    if (existing) await releaseBlock(tx, actor, existing.id);
    return { status: 'applied', reservationId: null };
  }
  const room = event.rooms[0];
  const unitId = room?.internal?.unitId;
  if (!room || !unitId) throw validationError('A closure needs the unit it applies to');
  if (!isValidDate(room.checkIn) || !isValidDate(room.checkOut) || room.checkOut <= room.checkIn) {
    throw validationError(`The closure has unusable dates (${room.checkIn} to ${room.checkOut})`);
  }
  try {
    if (existing) {
      if (existing.startDate !== room.checkIn || existing.endDate !== room.checkOut) {
        await updateBlock(tx, actor, existing.id, {
          startDate: room.checkIn,
          endDate: room.checkOut,
        });
      }
    } else {
      await createBlock(tx, actor, {
        propertyId: connection.propertyId,
        unitId,
        kind: 'block',
        startDate: room.checkIn,
        endDate: room.checkOut,
        reason: event.block?.reason ?? null,
        source: 'ical',
        connectionId: connection.id,
        externalRef: event.bookingId,
      });
    }
  } catch (err) {
    if (
      !isDomainError(err, 'unit_occupied') &&
      !isDomainError(err, 'no_availability') &&
      !isDomainError(err, 'conflict')
    ) {
      throw err;
    }
    return {
      status: 'applied',
      reservationId: null,
      note: 'The dates are already taken in the PMS; no block was added',
    };
  }
  return { status: 'applied', reservationId: null };
}

async function applyEvent(
  tx: Transaction,
  connection: ConnectionRow,
  property: PropertyRow,
  row: RevisionRow,
  event: BookingEvent,
): Promise<Settled> {
  const actor = channelActor(connection.orgId, event.channelCode ?? connection.adapter);
  const [existing] = await tx
    .select()
    .from(reservations)
    .where(
      and(
        eq(reservations.connectionId, connection.id),
        eq(reservations.externalId, event.bookingId),
      ),
    )
    .for('update');

  // A revision older than one already applied must not undo it. On a tie, a cancellation wins.
  const { rows: newer } = await tx.execute(sql`
    SELECT 1 FROM booking_revisions
    WHERE connection_id = ${connection.id} AND external_booking_id = ${event.bookingId}
      AND id <> ${row.id} AND status = 'applied'
      AND (revision_at > ${row.revisionAt.toISOString()}::timestamptz
           OR (revision_at = ${row.revisionAt.toISOString()}::timestamptz
               AND event->>'status' = 'cancelled' AND ${event.status}::text <> 'cancelled'))
    LIMIT 1
  `);
  if (newer.length > 0) {
    return {
      status: 'superseded',
      reservationId: existing?.id ?? null,
      note: 'A newer revision was already applied',
    };
  }

  if (event.unreadable) return { status: 'failed', reservationId: null, note: event.unreadable };
  if (event.block) return applyBlockEvent(tx, actor, connection, event);

  if (event.status === 'cancelled') {
    if (!existing)
      return {
        status: 'applied',
        reservationId: null,
        note: 'Nothing to cancel: the booking was never recorded here',
      };
    await cancelFromEvent(tx, actor, connection, property, existing, event);
    return { status: 'applied', reservationId: existing.id };
  }

  const resolution = await resolveRooms(tx, connection, property, event);
  if (resolution.unmapped.length > 0) {
    return {
      status: 'unmapped',
      reservationId: existing?.id ?? null,
      note: `No room type is mapped to channel room ${[...new Set(resolution.unmapped)].join(', ')}`,
    };
  }
  if (resolution.rooms.length === 0) throw validationError('The booking lists no rooms');

  if (!existing) {
    const created = await createFromEvent(tx, actor, connection, event, resolution);
    return { status: 'applied', reservationId: created.id };
  }
  await modifyFromEvent(tx, actor, connection, property, existing, event, resolution);
  return { status: 'applied', reservationId: existing.id };
}

function describeBooking(event: BookingEvent): string {
  const first = event.rooms[0];
  const stay = first ? `, ${first.checkIn} to ${first.checkOut}` : '';
  const code = event.channelReservationCode ? ` ${event.channelReservationCode}` : '';
  return `${channelName(event.channelCode)} booking${code} for ${guestNameOf(event)}${stay}`;
}

/**
 * Applies one stored revision to the reservations, exactly once.
 *
 * Revisions of one booking are applied one at a time (an advisory lock on the
 * booking), and the revision's status changes in the same transaction as the
 * reservation, so a crash leaves either both or neither. A revision that is
 * already settled is left alone, which is what makes repeated deliveries safe.
 */
export async function applyRevision(db: Database, revisionRowId: string): Promise<ApplyResult> {
  let context:
    { connection: ConnectionRow; property: PropertyRow; event: BookingEvent } | undefined;
  try {
    return await transact(db, async (tx) => {
      const [peek] = await tx
        .select({
          connectionId: bookingRevisions.connectionId,
          bookingId: bookingRevisions.externalBookingId,
        })
        .from(bookingRevisions)
        .where(eq(bookingRevisions.id, revisionRowId));
      if (!peek) throw notFound('Booking revision', revisionRowId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${bookingLockKey(peek.connectionId, peek.bookingId)}, 0))`,
      );
      const [row] = await tx
        .select()
        .from(bookingRevisions)
        .where(eq(bookingRevisions.id, revisionRowId))
        .for('update');
      if (!row) throw notFound('Booking revision', revisionRowId);
      // Settled, one way or another. A message that was set aside by a person stays so when
      // the channel delivers it again; only applying it again by hand reopens it.
      if (row.status === 'applied' || row.status === 'superseded' || row.status === 'set_aside') {
        return { status: row.status, reservationId: row.reservationId, changed: false };
      }
      // Its contents were dropped (too old, or its guest was erased): there is nothing to apply.
      if (row.raw.erased === true) {
        return { status: row.status, reservationId: row.reservationId, changed: false };
      }
      const [connection] = await tx
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, row.connectionId));
      const [property] = await tx
        .select()
        .from(properties)
        .where(eq(properties.id, connection!.propertyId));
      const event = deserializeBookingEvent(row.event as unknown as StoredBookingEvent, row.raw);
      context = { connection: connection!, property: property!, event };

      const settled = await applyEvent(tx, connection!, property!, row, event);
      await tx
        .update(bookingRevisions)
        .set({
          status: settled.status,
          appliedAt: settled.status === 'applied' ? new Date() : null,
          reservationId: settled.reservationId,
          error: settled.note ?? null,
          attempts: sql`${bookingRevisions.attempts} + 1`,
          nextAttemptAt: null,
        })
        .where(eq(bookingRevisions.id, row.id));

      const bookingKey = `${connection!.id}:${event.bookingId}`;
      if (settled.status === 'unmapped') {
        await raiseAlert(tx, {
          orgId: connection!.orgId,
          propertyId: connection!.propertyId,
          kind: 'unmapped_booking',
          severity: 'critical',
          title: `${property!.name}: a booking arrived for a room that is not mapped`,
          body:
            `${describeBooking(event)} could not be placed: ${settled.note}. ` +
            'The dates are NOT held in the PMS. Map the room under Channels, then re-apply the booking from the sync monitor.',
          entityType: 'booking_revision',
          entityId: row.id,
          dedupeKey: `unmapped_booking:${bookingKey}`,
        });
      } else if (settled.status === 'failed') {
        // The message itself is the problem; trying again would change nothing.
        await raiseAlert(tx, {
          orgId: connection!.orgId,
          propertyId: connection!.propertyId,
          kind: 'booking_needs_review',
          severity: 'critical',
          title: `${property!.name}: a booking message could not be used`,
          body: `${settled.note}\n\nUntil someone deals with it, the calendar may be missing a booking, a change or a cancellation.`,
          entityType: 'booking_revision',
          entityId: row.id,
          dedupeKey: `unreadable:${row.id}`,
        });
      } else {
        await resolveAlert(tx, connection!.orgId, `unmapped_booking:${bookingKey}`);
        await resolveAlert(tx, connection!.orgId, `inbound_failure:${bookingKey}`);
        await resolveAlert(tx, connection!.orgId, `unreadable:${row.id}`);
      }
      const problem = settled.status === 'unmapped' || settled.status === 'failed';
      await writeSyncLog(tx, {
        connectionId: connection!.id,
        propertyId: connection!.propertyId,
        direction: 'in',
        operation: `booking.${event.status}`,
        status: problem ? 'error' : 'ok',
        itemCount: 1,
        lagMs: Math.max(0, Date.now() - event.revisionAt.getTime()),
        error: problem ? settled.note : undefined,
        detail: {
          revisionId: row.externalRevisionId,
          bookingId: event.bookingId,
          channel: event.channelCode,
          outcome: settled.status,
          reservationId: settled.reservationId,
          note: settled.note,
        },
      });
      await emit(tx, connection!.orgId, [
        {
          kind: 'sync.updated',
          propertyId: connection!.propertyId,
          payload: { connectionId: connection!.id },
        },
      ]);
      return {
        status: settled.status,
        reservationId: settled.reservationId,
        changed: true,
        ...(settled.status === 'failed' ? { error: settled.note } : {}),
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordFailure(db, revisionRowId, message, context);
    return { status: 'failed', reservationId: null, changed: true, error: message };
  }
}

async function recordFailure(
  db: Database,
  revisionRowId: string,
  message: string,
  context: { connection: ConnectionRow; property: PropertyRow; event: BookingEvent } | undefined,
): Promise<void> {
  const delays = sql.join(
    RETRY_DELAYS_S.map((s) => sql`${s}`),
    sql`, `,
  );
  const { rows } = await db.execute<{ attempts: number; will_retry: boolean }>(sql`
    UPDATE booking_revisions
    SET status = 'failed',
        attempts = attempts + 1,
        error = ${message.slice(0, 2000)},
        next_attempt_at = CASE WHEN attempts + 1 <= ${RETRY_DELAYS_S.length}
          THEN now() + make_interval(secs => (ARRAY[${delays}]::int[])[attempts + 1]) ELSE NULL END
    WHERE id = ${revisionRowId} AND status NOT IN ('applied', 'superseded', 'set_aside')
    RETURNING attempts, next_attempt_at IS NOT NULL AS will_retry
  `);
  if (!rows[0] || !context) return;
  const { connection, property, event } = context;
  await writeSyncLog(db, {
    connectionId: connection.id,
    propertyId: connection.propertyId,
    direction: 'in',
    operation: `booking.${event.status}`,
    status: rows[0].will_retry ? 'retry' : 'error',
    itemCount: 1,
    error: message,
    detail: {
      revisionId: event.revisionId,
      bookingId: event.bookingId,
      attempts: rows[0].attempts,
    },
  });
  await raiseAlert(db, {
    orgId: connection.orgId,
    propertyId: connection.propertyId,
    kind: 'inbound_failure',
    severity: 'critical',
    title: `${property.name}: a booking from ${channelName(event.channelCode)} could not be recorded`,
    body:
      `${describeBooking(event)} (${event.status}) failed to apply: ${message}\n\n` +
      (rows[0].will_retry
        ? 'The system will try again shortly. Until it succeeds, the calendar does not reflect this booking.'
        : 'Automatic retries are exhausted. Enter the change by hand, or fix the cause and re-apply it from the sync monitor.'),
    entityType: 'booking_revision',
    entityId: revisionRowId,
    dedupeKey: `inbound_failure:${connection.id}:${event.bookingId}`,
    metadata: { attempts: rows[0].attempts },
  });
}

// ---------------------------------------------------------------------------
// 3. Acknowledge

/**
 * Tells the channel the revision is safely stored. Called once the revision
 * is settled one way or the other: from then on the PMS owns it (including
 * retrying it), and the channel can stop re-sending.
 */
export async function acknowledgeRevision(
  db: Database,
  revision: { id: string; connectionId: string; externalRevisionId: string },
  adapter: ChannelAdapter,
): Promise<boolean> {
  if (!adapter.ack) {
    await db
      .update(bookingRevisions)
      .set({ ackedAt: new Date() })
      .where(and(eq(bookingRevisions.id, revision.id), sql`${bookingRevisions.ackedAt} IS NULL`));
    return true;
  }
  try {
    await adapter.ack(revision.externalRevisionId);
  } catch (err) {
    const { rows } = await db.execute<{
      ack_attempts: number;
      org_id: string;
      property_id: string;
      name: string;
    }>(sql`
      UPDATE booking_revisions r SET ack_attempts = r.ack_attempts + 1
      FROM channel_connections c
      WHERE r.id = ${revision.id} AND c.id = r.connection_id
      RETURNING r.ack_attempts, c.org_id, c.property_id, c.name
    `);
    const row = rows[0];
    if (row && row.ack_attempts >= ACK_FAILURES_BEFORE_ALERT) {
      await raiseAlert(db, {
        orgId: row.org_id,
        propertyId: row.property_id,
        kind: 'unacknowledged_booking',
        severity: 'warning',
        title: `${row.name}: bookings cannot be confirmed back to the channel`,
        body:
          `The booking itself is recorded, but the channel did not accept the receipt: ${(err as Error).message}. ` +
          'It will keep re-sending the booking and may email you that it was not delivered.',
        entityType: 'channel_connection',
        entityId: revision.connectionId,
        dedupeKey: `ack_failure:${revision.connectionId}`,
      });
    }
    return false;
  }
  const { rows } = await db.execute<{ org_id: string }>(sql`
    UPDATE booking_revisions r SET acked_at = now()
    FROM channel_connections c
    WHERE r.id = ${revision.id} AND c.id = r.connection_id
    RETURNING c.org_id
  `);
  if (rows[0]) await resolveAlert(db, rows[0].org_id, `ack_failure:${revision.connectionId}`);
  return true;
}

// ---------------------------------------------------------------------------
// The pipeline

/**
 * Takes one booking message from a channel through the whole pipeline:
 * store, apply once, acknowledge. Safe to call any number of times with the
 * same message.
 */
export async function ingestBookingEvent(
  db: Database,
  connection: ConnectionRow,
  event: BookingEvent,
  via: ReceivedVia,
  adapter: ChannelAdapter = adapterFor(connection),
): Promise<IngestResult> {
  const stored = await storeRevision(db, connection, event, via);
  const applied = await applyRevision(db, stored.id);
  const acknowledged = await acknowledgeRevision(
    db,
    { id: stored.id, connectionId: connection.id, externalRevisionId: event.revisionId },
    adapter,
  );
  return {
    id: stored.id,
    externalRevisionId: event.revisionId,
    externalBookingId: event.bookingId,
    status: applied.status,
    duplicate: !stored.isNew,
    reservationId: applied.reservationId,
    acknowledged,
    error: applied.error,
  };
}

export interface PullResult {
  connectionId: string;
  outcome: 'pulled' | 'skipped' | 'failed';
  received: number;
  /** Revisions seen for the first time. */
  fresh: number;
  results: IngestResult[];
  error?: string;
}

/** A pull that has been failing this long is treated as an outage, not a blip. */
const PULL_OUTAGE_MS = 30 * 60_000;

/**
 * Fetches whatever bookings the channel has waiting and runs each through the
 * pipeline. Webhooks trigger this for speed; a timer triggers it regardless,
 * so a missed webhook costs minutes, never a booking.
 */
export async function pullConnection(
  db: Database,
  connectionId: string,
  via: ReceivedVia = 'poll',
  now: Date = new Date(),
): Promise<PullResult> {
  // One fetch per connection at a time. A second one waits its turn rather than being
  // dropped (it may have been asked for because of a booking the first has already
  // missed), and each starts from the notes the one before it left.
  return db.transaction(async (turn) => {
    await turn.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pms-pull:${connectionId}`}, 0))`,
    );
    return pullInTurn(db, connectionId, via, now);
  });
}

async function pullInTurn(
  db: Database,
  connectionId: string,
  via: ReceivedVia,
  now: Date,
): Promise<PullResult> {
  const result: PullResult = {
    connectionId,
    outcome: 'skipped',
    received: 0,
    fresh: 0,
    results: [],
  };
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId));
  if (!connection || (connection.status !== 'active' && connection.status !== 'error'))
    return result;
  const context = adapterContext(connection);
  const adapter = createAdapter(connection.adapter, context);
  if (!adapter.pullBookings) return result;

  const started = Date.now();
  let events: BookingEvent[];
  try {
    const cursor = typeof connection.state.cursor === 'string' ? connection.state.cursor : null;
    events = await adapter.pullBookings(cursor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [property] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, connection.propertyId));
    const since = connection.lastPullAt ?? connection.createdAt;
    await writeSyncLog(db, {
      connectionId,
      propertyId: connection.propertyId,
      direction: 'in',
      operation: 'bookings.pull',
      status: 'retry',
      durationMs: Date.now() - started,
      error: message,
    });
    await raiseAlert(db, {
      orgId: connection.orgId,
      propertyId: connection.propertyId,
      kind: 'inbound_failure',
      severity: now.getTime() - since.getTime() > PULL_OUTAGE_MS ? 'critical' : 'warning',
      title: `${property?.name ?? 'Property'}: bookings cannot be fetched from ${connection.name}`,
      body: `${message}\n\nNew bookings, changes and cancellations may be missing from the calendar until this recovers. The system keeps trying.`,
      entityType: 'channel_connection',
      entityId: connectionId,
      dedupeKey: `pull_failure:${connectionId}`,
    });
    // What the adapter noted about the failure itself (which source, since when) is kept;
    // by contract it records nothing as seen until it has been read.
    if (JSON.stringify(context.state) !== JSON.stringify(connection.state)) {
      await db
        .update(channelConnections)
        .set({ state: context.state })
        .where(eq(channelConnections.id, connectionId));
    }
    return { ...result, outcome: 'failed', error: message };
  }

  let allStored = true;
  for (const event of events) {
    try {
      const ingested = await ingestBookingEvent(db, connection, event, via, adapter);
      result.results.push(ingested);
      if (!ingested.duplicate) result.fresh++;
    } catch (err) {
      // Storing failed (the database, not the booking). Nothing was acknowledged, so it comes again.
      allStored = false;
      result.error = err instanceof Error ? err.message : String(err);
    }
  }
  result.received = events.length;
  result.outcome = 'pulled';

  // The adapter's notes say "these have been seen". They are only kept once everything
  // seen is safely stored; otherwise the next pull must report the same things again.
  const stateChanged =
    allStored && JSON.stringify(context.state) !== JSON.stringify(connection.state);
  await db
    .update(channelConnections)
    .set({ lastPullAt: now, ...(stateChanged ? { state: context.state } : {}) })
    .where(eq(channelConnections.id, connectionId));
  await resolveAlert(db, connection.orgId, `pull_failure:${connectionId}`);
  await reportSourceProblems(db, connection, adapter.problems?.() ?? []);
  return result;
}

/** Raises an alert for each source that could not be read, and clears alerts for those that now can. */
async function reportSourceProblems(
  db: Database,
  connection: ConnectionRow,
  problems: { key: string; message: string }[],
): Promise<void> {
  const prefix = `source_failure:${connection.id}:`;
  const failing = new Set(problems.map((p) => `${prefix}${p.key}`));
  const { rows: open } = await db.execute<{ dedupe_key: string }>(sql`
    SELECT dedupe_key FROM alerts
    WHERE org_id = ${connection.orgId} AND status <> 'resolved' AND dedupe_key LIKE ${`${prefix}%`}
  `);
  for (const { dedupe_key } of open) {
    if (!failing.has(dedupe_key)) await resolveAlert(db, connection.orgId, dedupe_key);
  }
  if (problems.length === 0) return;
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  for (const problem of problems) {
    await raiseAlert(db, {
      orgId: connection.orgId,
      propertyId: connection.propertyId,
      kind: 'calendar_feed_failure',
      severity: 'warning',
      title: `${property?.name ?? 'Property'}: a calendar could not be read`,
      body: `${problem.message}\n\nBookings made there are not reaching the PMS until this is fixed. Check that the calendar address is still the one the channel shows.`,
      entityType: 'channel_connection',
      entityId: connection.id,
      dedupeKey: `${prefix}${problem.key}`,
    });
  }
}

export interface ImportResult {
  connectionId: string;
  outcome: 'imported' | 'skipped';
  /** Bookings the channel listed. */
  found: number;
  /** Reservations created or updated from them. */
  applied: number;
  /** Bookings that could not be placed (unmapped room, unusable data). Each has an alert. */
  problems: number;
}

/**
 * Brings in bookings that exist at the channel but were made before the
 * connection, so the calendar starts out complete. Each goes through the same
 * pipeline as a live booking, so running it twice changes nothing.
 */
export async function importBookings(
  db: Database,
  connectionId: string,
  now: Date = new Date(),
): Promise<ImportResult> {
  const result: ImportResult = {
    connectionId,
    outcome: 'skipped',
    found: 0,
    applied: 0,
    problems: 0,
  };
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId));
  if (!connection || (connection.status !== 'active' && connection.status !== 'error'))
    return result;
  const adapter = adapterFor(connection);
  if (!adapter.listBookings) return result;
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  if (!property) return result;

  const started = Date.now();
  const events = await adapter.listBookings(todayIn(property.timezone, now));
  result.found = events.length;
  result.outcome = 'imported';
  // Oldest first, so several states of one booking land in the order they happened.
  events.sort((a, b) => a.revisionAt.getTime() - b.revisionAt.getTime());
  for (const event of events) {
    const ingested = await ingestBookingEvent(db, connection, event, 'import', adapter);
    if (ingested.status === 'applied' && ingested.reservationId) result.applied++;
    else if (ingested.status === 'unmapped' || ingested.status === 'failed') result.problems++;
  }
  await writeSyncLog(db, {
    connectionId,
    propertyId: connection.propertyId,
    direction: 'in',
    operation: 'bookings.import',
    status: result.problems > 0 ? 'error' : 'ok',
    itemCount: result.found,
    durationMs: Date.now() - started,
    detail: { ...result },
  });
  return result;
}

/**
 * Picks up revisions that were stored but not finished: a worker died between
 * storing and applying, an apply failed and is due another try, or the
 * channel did not take the acknowledgement.
 */
export async function retryPendingRevisions(
  db: Database,
  now: Date = new Date(),
): Promise<{ applied: number; failed: number; acknowledged: number }> {
  const outcome = { applied: 0, failed: 0, acknowledged: 0 };
  const { rows: due } = await db.execute<{ id: string }>(sql`
    SELECT id FROM booking_revisions
    WHERE (status = 'received' AND received_at < ${now.toISOString()}::timestamptz - interval '1 minute')
       OR (status IN ('failed', 'unmapped') AND next_attempt_at <= ${now.toISOString()}::timestamptz)
    ORDER BY revision_at
    LIMIT 200
  `);
  for (const { id } of due) {
    const applied = await applyRevision(db, id);
    if (applied.status === 'failed') outcome.failed++;
    else outcome.applied++;
  }

  const unacked = await db
    .select({
      id: bookingRevisions.id,
      connectionId: bookingRevisions.connectionId,
      externalRevisionId: bookingRevisions.externalRevisionId,
    })
    .from(bookingRevisions)
    .where(
      and(
        sql`${bookingRevisions.ackedAt} IS NULL`,
        sql`${bookingRevisions.status} <> 'received'`,
        sql`${bookingRevisions.ackAttempts} < 50`,
      ),
    )
    .orderBy(asc(bookingRevisions.receivedAt))
    .limit(200);
  if (unacked.length === 0) return outcome;
  const connections = await db
    .select()
    .from(channelConnections)
    .where(inArray(channelConnections.id, [...new Set(unacked.map((r) => r.connectionId))]));
  const adapters = new Map(connections.map((c) => [c.id, adapterFor(c)]));
  for (const revision of unacked) {
    const adapter = adapters.get(revision.connectionId);
    if (adapter && (await acknowledgeRevision(db, revision, adapter))) outcome.acknowledged++;
  }
  return outcome;
}

/**
 * Applies a revision again on request: after a missing mapping was added, or
 * after the cause of a failure was fixed.
 */
export async function reprocessRevision(
  db: Database,
  actor: Actor,
  revisionRowId: string,
): Promise<ApplyResult> {
  const [row] = await db
    .select({ revision: bookingRevisions, connection: channelConnections })
    .from(bookingRevisions)
    .innerJoin(channelConnections, eq(channelConnections.id, bookingRevisions.connectionId))
    .where(and(eq(bookingRevisions.id, revisionRowId), eq(channelConnections.orgId, actor.orgId)));
  if (!row) throw notFound('Booking revision', revisionRowId);
  if (row.revision.raw.erased === true) {
    throw invalidState(
      'The contents of this booking message are no longer kept, so it cannot be applied again.',
    );
  }
  await writeAudit(db, actor, {
    action: 'channel.revision_reprocessed',
    entityType: 'booking_revision',
    entityId: revisionRowId,
    propertyId: row.connection.propertyId,
    summary: `Re-applied booking message ${row.revision.externalRevisionId} from ${row.connection.name}`,
  });
  // Applying again is also how a message that was set aside by mistake is taken up again.
  if (row.revision.status === 'set_aside') {
    await db
      .update(bookingRevisions)
      .set({ status: 'failed' })
      .where(and(eq(bookingRevisions.id, revisionRowId), eq(bookingRevisions.status, 'set_aside')));
  }
  // A message that could not be read is read again first: the reading may have improved,
  // or a setting that held it back may have changed.
  const stored = row.revision.event as unknown as StoredBookingEvent;
  const adapter = adapterFor(row.connection);
  if (stored.unreadable && adapter.reparse && row.revision.status !== 'applied') {
    const again = await adapter.reparse(row.revision.raw);
    if (again && !again.unreadable) {
      await db
        .update(bookingRevisions)
        .set({
          event: serializeBookingEvent(again) as unknown as Record<string, unknown>,
          externalBookingId: again.bookingId,
          channelCode: again.channelCode,
        })
        .where(eq(bookingRevisions.id, revisionRowId));
    }
  }
  return applyRevision(db, revisionRowId);
}

/**
 * Closes a booking message that will not be recorded from here: the booking was entered by
 * hand, or the message was not about a booking after all. It is no longer tried, no longer
 * counted as outstanding, and the alerts about it are closed. Applying it again reopens it.
 */
export async function setAsideRevision(
  db: Database,
  actor: Actor,
  revisionRowId: string,
): Promise<{ status: RevisionStatus }> {
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ revision: bookingRevisions, connection: channelConnections })
      .from(bookingRevisions)
      .innerJoin(channelConnections, eq(channelConnections.id, bookingRevisions.connectionId))
      .where(and(eq(bookingRevisions.id, revisionRowId), eq(channelConnections.orgId, actor.orgId)))
      .for('update', { of: bookingRevisions });
    if (!row) throw notFound('Booking revision', revisionRowId);
    const { revision, connection } = row;
    if (revision.status === 'set_aside') return { status: revision.status };
    if (revision.status !== 'failed' && revision.status !== 'unmapped') {
      throw invalidState(
        'Only a booking message that could not be recorded can be marked as dealt with',
      );
    }
    await tx
      .update(bookingRevisions)
      .set({ status: 'set_aside', nextAttemptAt: null })
      .where(eq(bookingRevisions.id, revisionRowId));

    await resolveAlert(tx, connection.orgId, `unreadable:${revision.id}`);
    // The other alerts are about the booking, which may have further messages still waiting.
    const { rows: waiting } = await tx.execute(sql`
      SELECT 1 FROM booking_revisions
      WHERE connection_id = ${connection.id} AND external_booking_id = ${revision.externalBookingId}
        AND id <> ${revision.id} AND status IN ('failed', 'unmapped')
      LIMIT 1
    `);
    if (waiting.length === 0) {
      const bookingKey = `${connection.id}:${revision.externalBookingId}`;
      await resolveAlert(tx, connection.orgId, `unmapped_booking:${bookingKey}`);
      await resolveAlert(tx, connection.orgId, `inbound_failure:${bookingKey}`);
    }
    await writeAudit(tx, actor, {
      action: 'channel.revision_set_aside',
      entityType: 'booking_revision',
      entityId: revisionRowId,
      propertyId: connection.propertyId,
      summary: `Marked booking message ${revision.externalRevisionId} from ${connection.name} as dealt with by hand`,
    });
    await emit(tx, connection.orgId, [
      {
        kind: 'sync.updated',
        propertyId: connection.propertyId,
        payload: { connectionId: connection.id },
      },
    ]);
    return { status: 'set_aside' };
  });
}

export interface RevisionSummary {
  id: string;
  connectionId: string;
  propertyId: string;
  externalRevisionId: string;
  externalBookingId: string;
  channelCode: string | null;
  kind: BookingEvent['status'];
  guestName: string;
  checkIn: DateString | null;
  checkOut: DateString | null;
  receivedVia: ReceivedVia;
  receivedAt: Date;
  revisionAt: Date;
  status: RevisionStatus;
  error: string | null;
  acknowledged: boolean;
  attempts: number;
  reservationId: string | null;
  reservationCode: string | null;
  /**
   * True once the message's contents are no longer kept (it was never used and grew old, or
   * its guest was erased). It can then be neither read in full nor applied again.
   */
  contentsDropped: boolean;
}

/** Recent booking messages for the sync monitor, newest first. */
export async function listRevisions(
  db: DbOrTx,
  orgId: string,
  filter: {
    propertyIds: string[] | 'all';
    connectionId?: string;
    status?: RevisionStatus;
    limit?: number;
  },
): Promise<RevisionSummary[]> {
  if (filter.propertyIds !== 'all' && filter.propertyIds.length === 0) return [];
  const rows = await db
    .select({
      revision: bookingRevisions,
      propertyId: channelConnections.propertyId,
      reservationCode: reservations.code,
    })
    .from(bookingRevisions)
    .innerJoin(channelConnections, eq(channelConnections.id, bookingRevisions.connectionId))
    .leftJoin(reservations, eq(reservations.id, bookingRevisions.reservationId))
    .where(
      and(
        eq(channelConnections.orgId, orgId),
        filter.propertyIds === 'all'
          ? undefined
          : inArray(channelConnections.propertyId, filter.propertyIds),
        filter.connectionId ? eq(bookingRevisions.connectionId, filter.connectionId) : undefined,
        filter.status ? eq(bookingRevisions.status, filter.status) : undefined,
      ),
    )
    .orderBy(desc(bookingRevisions.receivedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.map(({ revision: r, propertyId, reservationCode }) => {
    const event = r.event as unknown as StoredBookingEvent;
    const first = event.rooms?.[0];
    return {
      id: r.id,
      connectionId: r.connectionId,
      propertyId,
      externalRevisionId: r.externalRevisionId,
      externalBookingId: r.externalBookingId,
      channelCode: r.channelCode,
      kind: event.status,
      guestName: `${event.guest?.firstName ?? ''} ${event.guest?.lastName ?? ''}`.trim(),
      checkIn: first?.checkIn ?? null,
      checkOut: first?.checkOut ?? null,
      receivedVia: r.receivedVia,
      receivedAt: r.receivedAt,
      revisionAt: r.revisionAt,
      status: r.status,
      error: r.error,
      acknowledged: r.ackedAt !== null,
      attempts: r.attempts,
      reservationId: r.reservationId,
      reservationCode,
      contentsDropped: r.raw.erased === true,
    };
  });
}
