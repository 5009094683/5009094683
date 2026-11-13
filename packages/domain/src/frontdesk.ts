import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  folioLines,
  folios,
  housekeepingTasks,
  properties,
  reservationNights,
  reservationRooms,
  reservations,
  roomTypes,
  units,
  type DbOrTx,
  type HousekeepingStatus,
  type ReservationStatus,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { addDays, type DateString } from './dates';
import { DomainError, invalidState, notFound, validationError } from './errors';
import {
  businessDateOf,
  ensureGuestFolio,
  recordPayment,
  reservationBalance,
  totalsOf,
  transferToCompany,
} from './folios';
import { displayMoney } from './money';
import { findFreeUnits } from './occupancy';
import { emit } from './outbox';
import {
  loadReservation,
  lockReservation,
  syncReservationSummary,
  updateReservationRoom,
  type ReservationDetail,
  type ReservationRoomRow,
} from './reservations';
import { parsePgTimestamp, transact } from './sqlx';
import { computeTax, taxRuleFor } from './taxes';

type ReservationRow = typeof reservations.$inferSelect;

/**
 * Posts the room charge for every night a room has been occupied up to (not
 * including) `before`, where it has not been posted yet. The night audit
 * does this once a day; check-out does it for whatever is still missing.
 * A night is charged at most once however often this runs.
 *
 * For a booking the channel collects payment for, the same amount is entered
 * as collected by the channel, so the guest is not asked to pay again.
 */
export async function postRoomCharges(
  tx: Transaction,
  actor: Actor,
  reservation: ReservationRow,
  room: ReservationRoomRow,
  before: DateString,
  source: string,
): Promise<{ nights: number; amount: number }> {
  const nights = await tx
    .select()
    .from(reservationNights)
    .where(eq(reservationNights.reservationRoomId, room.id))
    .orderBy(asc(reservationNights.date));
  const due = nights.filter((n) => n.date < before);
  if (due.length === 0) return { nights: 0, amount: 0 };
  const posted = await tx
    .select({ date: folioLines.businessDate })
    .from(folioLines)
    .where(
      and(
        eq(folioLines.reservationRoomId, room.id),
        eq(folioLines.kind, 'room'),
        sql`${folioLines.voidedAt} IS NULL`,
      ),
    );
  const have = new Set(posted.map((p) => p.date));
  const missing = due.filter((n) => !have.has(n.date));
  if (missing.length === 0) return { nights: 0, amount: 0 };

  const guestFolio = await ensureGuestFolio(tx, reservation.id);
  const open = await tx
    .select()
    .from(folios)
    .where(and(eq(folios.reservationId, reservation.id), eq(folios.status, 'open')))
    .orderBy(asc(folios.createdAt));
  const folio = open.find((f) => f.routes.includes('room')) ?? guestFolio;
  if (folio.status !== 'open') {
    // A folio settled and closed mid-stay takes the next night all the same.
    await tx.update(folios).set({ status: 'open', closedAt: null }).where(eq(folios.id, folio.id));
  }
  const rule = await taxRuleFor(tx, reservation.propertyId, 'room');
  const [type] = await tx
    .select({ name: roomTypes.name })
    .from(roomTypes)
    .where(eq(roomTypes.id, room.roomTypeId));
  let total = 0;
  for (const night of missing) {
    const tax = computeTax(rule, night.amount);
    await tx.insert(folioLines).values({
      folioId: folio.id,
      propertyId: reservation.propertyId,
      businessDate: night.date,
      kind: 'room',
      description: `${type?.name ?? 'Room'}, night of ${longDate(night.date)}`,
      amount: night.amount,
      taxAmount: tax.taxAmount,
      taxes: tax.taxes,
      serviceCode: rule?.serviceCode ?? null,
      reservationRoomId: room.id,
      source,
      postedBy: actor.userId ?? null,
      postedByLabel: actor.label,
    });
    total += night.amount + tax.taxAmount;
  }
  if (reservation.paymentCollect === 'channel' && total > 0) {
    await recordPayment(tx, actor, {
      folioId: folio.id,
      method: 'channel',
      amount: total,
      reference: reservation.channelReservationCode,
      note: 'Collected from the guest by the channel',
      businessDate: missing[missing.length - 1]!.date,
    });
  }
  return { nights: missing.length, amount: total };
}

export interface CheckInOptions {
  /** Rooms to check in. Default: every room of the reservation that is due. */
  roomIds?: string[];
  /** Unit to give a room that has none, by room id. A room left out gets the best free unit. */
  units?: Record<string, string>;
  /** Check in although the unit has not been cleaned. */
  allowDirty?: boolean;
}

/**
 * Checks guests in. Each room must end up in a unit that is free for the
 * whole stay; a room without one is given the best-fitting free unit of its
 * type. A unit that is not clean is refused unless the caller insists.
 */
export async function checkIn(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  options: CheckInOptions = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(tx, actor.orgId, reservationId);
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, reservation.propertyId));
    const today = businessDateOf(property!);
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId))
      .orderBy(asc(reservationRooms.position));
    const targets = rooms.filter(
      (r) => r.status === 'confirmed' && (!options.roomIds || options.roomIds.includes(r.id)),
    );
    if (options.roomIds && targets.length !== options.roomIds.length) {
      throw invalidState('Only rooms that are confirmed and not yet checked in can be checked in');
    }
    if (targets.length === 0) {
      throw invalidState(
        reservation.status === 'tentative'
          ? 'Confirm the reservation before checking the guest in'
          : `A ${reservation.status.replace('_', ' ')} reservation cannot be checked in`,
      );
    }
    for (const room of targets) {
      if (room.checkIn > today) {
        throw invalidState(
          `This stay starts on ${room.checkIn}; change the arrival date to check in earlier`,
        );
      }
      if (room.checkOut <= today) {
        throw invalidState(`This stay ended on ${room.checkOut}; extend it before checking in`);
      }
    }

    for (const room of targets) {
      let unitId = options.units?.[room.id] ?? room.unitId;
      if (!unitId) {
        const [free] = await findFreeUnits(tx, room.roomTypeId, {
          from: room.checkIn,
          to: room.checkOut,
        });
        if (!free) {
          throw new DomainError(
            'no_availability',
            'No room of this type is free for the whole stay. Choose a room, or move another booking first.',
          );
        }
        unitId = free.id;
      }
      if (unitId !== room.unitId) {
        // Goes through the ledger, which refuses a unit that is taken on any night of the stay.
        await updateReservationRoom(tx, actor, reservationId, room.id, { unitId });
      }
      const [unit] = await tx.select().from(units).where(eq(units.id, unitId));
      if (!unit) throw notFound('Unit', unitId);
      if (unit.housekeepingStatus === 'out_of_service') {
        throw invalidState(`${unit.name} is out of service`);
      }
      if (unit.housekeepingStatus === 'dirty' && !options.allowDirty) {
        throw new DomainError('conflict', `${unit.name} has not been cleaned yet`, {
          reason: 'unit_dirty',
          unitId,
        });
      }
      await tx
        .update(reservationRooms)
        .set({ status: 'in_house', checkedInAt: new Date() })
        .where(eq(reservationRooms.id, room.id));
    }
    await ensureGuestFolio(tx, reservationId);
    await syncReservationSummary(tx, reservationId);
    await writeAudit(tx, actor, {
      action: 'reservation.checked_in',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Checked in ${reservation.guestName} (${reservation.code})`,
      changes: { rooms: targets.map((r) => r.id) },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: {
          reservationId,
          code: reservation.code,
          from: reservation.checkIn,
          to: reservation.checkOut,
        },
      },
      // Checking in opens the guest's bill.
      { kind: 'folio.updated', propertyId: reservation.propertyId, payload: { reservationId } },
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

/** Reverses a check-in made by mistake, on the day it was made and before anything was charged for the night. */
export async function undoCheckIn(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  roomIds?: string[],
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(tx, actor.orgId, reservationId);
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const targets = rooms.filter(
      (r) => r.status === 'in_house' && (!roomIds || roomIds.includes(r.id)),
    );
    if (targets.length === 0) throw invalidState('No room of this reservation is checked in');
    const charged = await tx
      .select({ id: folioLines.id })
      .from(folioLines)
      .where(
        and(
          inArray(
            folioLines.reservationRoomId,
            targets.map((r) => r.id),
          ),
          eq(folioLines.kind, 'room'),
          sql`${folioLines.voidedAt} IS NULL`,
        ),
      )
      .limit(1);
    if (charged.length > 0) {
      throw invalidState(
        'A night has already been charged for this stay; check the guest out instead',
      );
    }
    await tx
      .update(reservationRooms)
      .set({ status: 'confirmed', checkedInAt: null })
      .where(
        inArray(
          reservationRooms.id,
          targets.map((r) => r.id),
        ),
      );
    await syncReservationSummary(tx, reservationId);
    await writeAudit(tx, actor, {
      action: 'reservation.check_in_undone',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Undid the check-in of ${reservation.guestName} (${reservation.code})`,
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: { reservationId, code: reservation.code },
      },
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

export interface CheckOutOptions {
  /** Rooms to check out. Default: every room that is checked in. */
  roomIds?: string[];
  /**
   * What to do when money is still owed once the last room leaves:
   * `require_settled` (the default) refuses; `bill_company` moves it to the
   * reservation's company account; `leave_open` checks out anyway and leaves
   * the folio open to be settled later.
   */
  balance?: 'require_settled' | 'bill_company' | 'leave_open';
}

export interface CheckOutResult {
  reservation: ReservationDetail;
  /** What is still owed after check-out (zero unless the folio was left open). */
  balance: number;
  /** Nights given back because the guest left early. */
  nightsReleased: number;
}

/**
 * Checks guests out: charges any night not yet charged, hands back the
 * nights of an early departure (they go on sale again at once), marks the
 * unit for cleaning, and closes folios that are settled.
 */
export async function checkOut(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  options: CheckOutOptions = {},
): Promise<CheckOutResult> {
  return transact(db, async (tx) => {
    let reservation = await lockReservation(tx, actor.orgId, reservationId);
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, reservation.propertyId));
    const today = businessDateOf(property!);
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const targets = rooms.filter(
      (r) => r.status === 'in_house' && (!options.roomIds || options.roomIds.includes(r.id)),
    );
    if (options.roomIds && targets.length !== options.roomIds.length) {
      throw invalidState('Only rooms that are checked in can be checked out');
    }
    if (targets.length === 0) throw invalidState('No room of this reservation is checked in');

    let nightsReleased = 0;
    for (const room of targets) {
      // The stay is made to end today: nights not used go back on sale, and a guest who
      // stayed past the booked date is charged for the nights actually spent.
      const departure = today > room.checkIn ? today : addDays(room.checkIn, 1);
      let current = room;
      if (departure !== room.checkOut) {
        if (departure < room.checkOut) nightsReleased += daysBetween(departure, room.checkOut);
        await updateReservationRoom(
          tx,
          actor,
          reservationId,
          room.id,
          { checkOut: departure },
          { allowOverbooking: true, skipOccupancyLimits: true },
        );
        const [moved] = await tx
          .select()
          .from(reservationRooms)
          .where(eq(reservationRooms.id, room.id));
        current = moved!;
      }
      reservation = (
        await tx.select().from(reservations).where(eq(reservations.id, reservationId))
      )[0]!;
      await postRoomCharges(tx, actor, reservation, current, current.checkOut, 'check_out');
      await tx
        .update(reservationRooms)
        .set({ status: 'checked_out', checkedOutAt: new Date() })
        .where(eq(reservationRooms.id, room.id));
      if (current.unitId) {
        await tx
          .update(units)
          .set({ housekeepingStatus: 'dirty' })
          .where(eq(units.id, current.unitId));
        await tx
          .insert(housekeepingTasks)
          .values({
            propertyId: reservation.propertyId,
            unitId: current.unitId,
            date: today,
            kind: 'departure',
          })
          .onConflictDoNothing();
      }
    }
    const summary = await syncReservationSummary(tx, reservationId);

    let balance = await reservationBalance(tx, reservationId);
    const everyoneGone = summary.status === 'checked_out';
    if (everyoneGone && balance !== 0) {
      const mode = options.balance ?? 'require_settled';
      if (mode === 'require_settled') {
        throw new DomainError(
          'conflict',
          balance > 0
            ? `${displayMoney(balance, reservation.currency)} is still owed. Take payment, bill it to a company, or check out leaving the folio open.`
            : `The guest is ${displayMoney(-balance, reservation.currency)} in credit. Refund it, or check out leaving the folio open.`,
          { reason: 'balance_due', balance },
        );
      }
      if (mode === 'bill_company') {
        if (!reservation.companyId)
          throw validationError('This reservation is not linked to a company');
        if (balance < 0) throw invalidState('The guest is in credit; there is nothing to bill');
        const owing = await tx.select().from(folios).where(eq(folios.reservationId, reservationId));
        for (const folio of owing) {
          const lines = await tx.select().from(folioLines).where(eq(folioLines.folioId, folio.id));
          if (totalsOf(lines).balance > 0)
            await transferToCompany(tx, actor, folio.id, reservation.companyId);
        }
        balance = await reservationBalance(tx, reservationId);
      }
    }
    if (everyoneGone) {
      // Folios that are settled are closed; one left owing stays open so it can be found and collected.
      const all = await tx.select().from(folios).where(eq(folios.reservationId, reservationId));
      for (const folio of all) {
        const lines = await tx.select().from(folioLines).where(eq(folioLines.folioId, folio.id));
        if (folio.status === 'open' && totalsOf(lines).balance === 0) {
          await tx
            .update(folios)
            .set({ status: 'closed', closedAt: new Date() })
            .where(eq(folios.id, folio.id));
        }
      }
    }
    await writeAudit(tx, actor, {
      action: 'reservation.checked_out',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Checked out ${reservation.guestName} (${reservation.code})`,
      changes: { rooms: targets.map((r) => r.id), balance, nightsReleased },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: {
          reservationId,
          code: reservation.code,
          from: reservation.checkIn,
          to: reservation.checkOut,
        },
      },
      // Checking out charges the nights not yet charged and closes bills that are settled.
      { kind: 'folio.updated', propertyId: reservation.propertyId, payload: { reservationId } },
      { kind: 'task.updated', propertyId: reservation.propertyId, payload: {} },
    ]);
    return {
      reservation: await loadReservation(tx, actor.orgId, reservationId),
      balance,
      nightsReleased,
    };
  });
}

/** "13 Nov 2026": how a date reads on a bill and on the invoice printed from it. */
function longDate(date: DateString): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function daysBetween(from: DateString, to: DateString): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface FrontDeskStay {
  reservationId: string;
  roomId: string;
  code: string;
  guestName: string;
  status: ReservationStatus;
  channelCode: string | null;
  roomTypeId: string;
  roomTypeName: string;
  unitId: string | null;
  unitName: string | null;
  unitHousekeeping: HousekeepingStatus | null;
  checkIn: DateString;
  checkOut: DateString;
  adults: number;
  children: number;
  arrivalTime: string | null;
  specialRequests: string | null;
  /** Owed across the reservation's folios. */
  balance: number;
  currency: string;
  overbooked: boolean;
  needsReview: boolean;
  /** When the guest filled in online check-in, if they did. */
  onlineCheckinAt: Date | null;
}

export interface FrontDeskBoard {
  /** The hotel day the lists are for. */
  date: DateString;
  /** Due today or earlier and not yet arrived. */
  arrivals: FrontDeskStay[];
  /** Checked in and due to leave today or earlier. */
  departures: FrontDeskStay[];
  /** Checked in and staying on. */
  inHouse: FrontDeskStay[];
  counts: {
    arrivals: number;
    arrived: number;
    departures: number;
    departed: number;
    inHouse: number;
  };
}

/** Who is arriving, leaving and staying at a property on its current hotel day. */
export async function frontDeskBoard(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  date?: DateString,
): Promise<FrontDeskBoard> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const day = date ?? businessDateOf(property);
  const { rows } = await db.execute<{
    reservation_id: string;
    room_id: string;
    code: string;
    guest_name: string;
    room_guest: string | null;
    status: ReservationStatus;
    channel_code: string | null;
    room_type_id: string;
    room_type_name: string;
    unit_id: string | null;
    unit_name: string | null;
    housekeeping: HousekeepingStatus | null;
    check_in: string;
    check_out: string;
    adults: number;
    children: number;
    arrival_time: string | null;
    special_requests: string | null;
    balance: string | null;
    currency: string;
    overbooked: boolean;
    needs_review: boolean;
    online_checkin_at: string | null;
    checked_in_on: string | null;
    checked_out_on: string | null;
  }>(sql`
    SELECT r.id AS reservation_id, rr.id AS room_id, r.code, r.guest_name, rr.guest_name AS room_guest,
           rr.status, r.channel_code, rr.room_type_id, rt.name AS room_type_name,
           rr.unit_id, u.name AS unit_name, u.housekeeping_status AS housekeeping,
           rr.check_in::text, rr.check_out::text, rr.adults, rr.children,
           r.arrival_time, r.special_requests, r.currency, r.overbooked, r.needs_review,
           r.online_checkin_at,
           (rr.checked_in_at AT TIME ZONE ${property.timezone})::date::text AS checked_in_on,
           (rr.checked_out_at AT TIME ZONE ${property.timezone})::date::text AS checked_out_on,
           (SELECT sum(l.amount + l.tax_amount) FROM folio_lines l JOIN folios f ON f.id = l.folio_id
             WHERE f.reservation_id = r.id AND l.voided_at IS NULL)::text AS balance
    FROM reservation_rooms rr
    JOIN reservations r ON r.id = rr.reservation_id
    JOIN room_types rt ON rt.id = rr.room_type_id
    LEFT JOIN units u ON u.id = rr.unit_id
    WHERE rr.property_id = ${propertyId}
      AND (
        (rr.status = 'confirmed' AND rr.check_in <= ${day}::date AND rr.check_out > ${day}::date - 1)
        OR rr.status = 'in_house'
        OR (rr.status = 'checked_out' AND rr.check_out >= ${day}::date - 1 AND rr.check_out <= ${day}::date + 1)
      )
    ORDER BY rt.sort_order, rt.name, u.sort_order NULLS LAST, u.name NULLS LAST, r.guest_name
  `);
  const stays = rows.map((r) => ({
    stay: {
      reservationId: r.reservation_id,
      roomId: r.room_id,
      code: r.code,
      guestName: r.room_guest ?? r.guest_name,
      status: r.status,
      channelCode: r.channel_code,
      roomTypeId: r.room_type_id,
      roomTypeName: r.room_type_name,
      unitId: r.unit_id,
      unitName: r.unit_name,
      unitHousekeeping: r.housekeeping,
      checkIn: r.check_in,
      checkOut: r.check_out,
      adults: r.adults,
      children: r.children,
      arrivalTime: r.arrival_time,
      specialRequests: r.special_requests,
      balance: Number(r.balance ?? 0),
      currency: r.currency,
      overbooked: r.overbooked,
      needsReview: r.needs_review,
      onlineCheckinAt: parsePgTimestamp(r.online_checkin_at),
    } satisfies FrontDeskStay,
    checkedInOn: r.checked_in_on,
    checkedOutOn: r.checked_out_on,
  }));
  const arrivals = stays.filter((s) => s.stay.status === 'confirmed').map((s) => s.stay);
  const inHouseAll = stays.filter((s) => s.stay.status === 'in_house');
  const departures = inHouseAll.filter((s) => s.stay.checkOut <= day).map((s) => s.stay);
  const inHouse = inHouseAll.filter((s) => s.stay.checkOut > day).map((s) => s.stay);
  return {
    date: day,
    arrivals,
    departures,
    inHouse,
    counts: {
      arrivals: arrivals.length,
      arrived: stays.filter((s) => s.checkedInOn === day && s.stay.status !== 'confirmed').length,
      departures: departures.length,
      departed: stays.filter((s) => s.stay.status === 'checked_out' && s.checkedOutOn === day)
        .length,
      inHouse: inHouseAll.length,
    },
  };
}

/** Units of a room type that are free for a stay, for choosing a room at check-in. */
export async function freeUnitsFor(
  db: DbOrTx,
  orgId: string,
  reservationId: string,
  roomId: string,
): Promise<{ id: string; name: string; housekeepingStatus: HousekeepingStatus }[]> {
  const [room] = await db
    .select({ room: reservationRooms })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .where(
      and(
        eq(reservationRooms.id, roomId),
        eq(reservationRooms.reservationId, reservationId),
        eq(reservations.orgId, orgId),
      ),
    );
  if (!room) throw notFound('Reservation room', roomId);
  const free = await findFreeUnits(db, room.room.roomTypeId, {
    from: room.room.checkIn,
    to: room.room.checkOut,
  });
  const ids = free.map((f) => f.id);
  if (room.room.unitId && !ids.includes(room.room.unitId)) ids.unshift(room.room.unitId);
  if (ids.length === 0) return [];
  const rows = await db.select().from(units).where(inArray(units.id, ids));
  return ids
    .map((id) => rows.find((u) => u.id === id))
    .filter((u): u is typeof units.$inferSelect => Boolean(u))
    .map((u) => ({ id: u.id, name: u.name, housekeepingStatus: u.housekeepingStatus }));
}
