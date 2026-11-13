import { and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  companies,
  guests,
  ratePlans,
  reservationNights,
  reservationGroups,
  reservationRooms,
  reservations,
  roomTypes,
  units,
  INVENTORY_HOLDING_STATUSES,
  type DbOrTx,
  type PaymentCollect,
  type ReservationSource,
  type ReservationStatus,
  type Transaction,
} from '@pms/db';
import { raiseAlert } from './alerts';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { randomCode } from './crypto';
import { requireOpenGroup } from './group-access';
import { addDays, assertRange, diffDays, eachDate, type DateRange, type DateString } from './dates';
import { DomainError, invalidState, notFound, validationError } from './errors';
import {
  findOrCreateGuest,
  fullName,
  guestView,
  splitName,
  type GuestInput,
  type GuestRow,
} from './guests';
import { withInventoryLock, type InventoryScope, type OverbookedNight } from './inventory';
import {
  findFreeUnits,
  occupancyConflicts,
  occupyUnit,
  releaseOccupancy,
  unitOccupiedError,
} from './occupancy';
import { emit } from './outbox';
import {
  requireProperty,
  type PropertyRow,
  type RatePlanRow,
  type RoomTypeRow,
} from './properties';
import { recountPromoUses } from './promos';
import { assertNoViolations, getRateCalendar, nightlyCharge, restrictionViolations } from './rates';
import { transact } from './sqlx';

export type ReservationRow = typeof reservations.$inferSelect;
export type ReservationRoomRow = typeof reservationRooms.$inferSelect;

const MAX_NIGHTS = 365;
const MAX_ROOMS = 60;

const isHolding = (status: ReservationStatus): boolean =>
  (INVENTORY_HOLDING_STATUSES as readonly string[]).includes(status);

export interface RoomInput {
  roomTypeId: string;
  ratePlanId?: string | null;
  /** A specific unit. Omit to let the system choose one (villas) or leave it for check-in (hotels). */
  unitId?: string | null;
  checkIn: DateString;
  checkOut: DateString;
  adults: number;
  children?: number;
  guestName?: string | null;
  /** Charge per night in minor units, before tax. Omit to price from the rate plan. */
  nightlyRates?: number[];
  externalRoomRef?: string | null;
}

export interface CreateReservationInput {
  propertyId: string;
  status?: 'tentative' | 'confirmed';
  source: ReservationSource;
  channelCode?: string | null;
  connectionId?: string | null;
  externalId?: string | null;
  channelReservationCode?: string | null;
  externalRevisionAt?: Date | null;
  guest: GuestInput;
  rooms: RoomInput[];
  paymentCollect?: PaymentCollect;
  commissionAmount?: number;
  arrivalTime?: string | null;
  specialRequests?: string | null;
  notes?: string | null;
  holdExpiresAt?: Date | null;
  groupId?: string | null;
  companyId?: string | null;
  needsReview?: boolean;
  reviewReason?: string | null;
}

export interface ReservationOptions {
  /**
   * Record the reservation even when it exceeds capacity, and flag it. For
   * bookings a channel has already confirmed to the guest, and for staff with
   * the override permission.
   */
  allowOverbooking?: boolean;
  /** Reject stays that break minimum stay, closed-to-arrival and similar rules. On for guest self-service. */
  enforceRestrictions?: boolean;
  /** Accept party sizes above the room type's limits (channels send what the guest entered). */
  skipOccupancyLimits?: boolean;
  /** Optimistic concurrency: fail if the reservation changed since this version was read. */
  expectedVersion?: number;
}

export interface ReservationRoomView {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  ratePlanId: string | null;
  ratePlanName: string | null;
  unitId: string | null;
  unitName: string | null;
  checkIn: DateString;
  checkOut: DateString;
  adults: number;
  children: number;
  status: ReservationStatus;
  guestName: string | null;
  amount: number;
  nights: { date: DateString; amount: number }[];
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
}

export interface ReservationDetail extends Omit<ReservationRow, 'orgId'> {
  guest: ReturnType<typeof guestView> | null;
  /** The company or travel agent the stay is booked for, if any. */
  company: { id: string; name: string; kind: string } | null;
  /** The group booking this stay is part of, if any. */
  group: { id: string; code: string; name: string } | null;
  rooms: ReservationRoomView[];
  nights: number;
}

/** A reservation may only be linked to an active company of the same organisation. */
async function requireCompany(tx: DbOrTx, orgId: string, companyId: string): Promise<void> {
  const [company] = await tx
    .select({ active: companies.active })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.orgId, orgId)));
  if (!company) throw notFound('Company', companyId);
  if (!company.active) throw validationError('This company is no longer in use');
}

// ---------------------------------------------------------------------------
// Reading

export async function loadReservation(
  db: DbOrTx,
  orgId: string,
  reservationId: string,
): Promise<ReservationDetail> {
  const [row] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)));
  if (!row) throw notFound('Reservation', reservationId);
  const [details] = await loadDetails(db, [row]);
  return details!;
}

async function loadDetails(db: DbOrTx, rows: ReservationRow[]): Promise<ReservationDetail[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const roomRows = await db
    .select({
      room: reservationRooms,
      roomTypeName: roomTypes.name,
      ratePlanName: ratePlans.name,
      unitName: units.name,
    })
    .from(reservationRooms)
    .innerJoin(roomTypes, eq(roomTypes.id, reservationRooms.roomTypeId))
    .leftJoin(ratePlans, eq(ratePlans.id, reservationRooms.ratePlanId))
    .leftJoin(units, eq(units.id, reservationRooms.unitId))
    .where(inArray(reservationRooms.reservationId, ids))
    .orderBy(
      asc(reservationRooms.position),
      asc(reservationRooms.createdAt),
      asc(reservationRooms.id),
    );
  const roomIds = roomRows.map((r) => r.room.id);
  const nightRows = roomIds.length
    ? await db
        .select()
        .from(reservationNights)
        .where(inArray(reservationNights.reservationRoomId, roomIds))
        .orderBy(asc(reservationNights.date))
    : [];
  const guestIds = [
    ...new Set(rows.map((r) => r.guestId).filter((id): id is string => id !== null)),
  ];
  const guestRows: GuestRow[] = guestIds.length
    ? await db.select().from(guests).where(inArray(guests.id, guestIds))
    : [];
  const guestsById = new Map(guestRows.map((g) => [g.id, g]));
  const companyIds = [
    ...new Set(rows.map((r) => r.companyId).filter((id): id is string => id !== null)),
  ];
  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, name: companies.name, kind: companies.kind })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const companiesById = new Map(companyRows.map((c) => [c.id, c]));
  const groupIds = [
    ...new Set(rows.map((r) => r.groupId).filter((id): id is string => id !== null)),
  ];
  const groupRows = groupIds.length
    ? await db
        .select({
          id: reservationGroups.id,
          code: reservationGroups.code,
          name: reservationGroups.name,
        })
        .from(reservationGroups)
        .where(inArray(reservationGroups.id, groupIds))
    : [];
  const groupsById = new Map(groupRows.map((g) => [g.id, g]));

  return rows.map((row) => {
    const { orgId: _orgId, ...rest } = row;
    const guest = row.guestId ? guestsById.get(row.guestId) : undefined;
    return {
      ...rest,
      nights: diffDays(row.checkIn, row.checkOut),
      guest: guest ? guestView(guest) : null,
      company: (row.companyId && companiesById.get(row.companyId)) || null,
      group: (row.groupId && groupsById.get(row.groupId)) || null,
      rooms: roomRows
        .filter((r) => r.room.reservationId === row.id)
        .map(({ room, roomTypeName, ratePlanName, unitName }) => ({
          id: room.id,
          roomTypeId: room.roomTypeId,
          roomTypeName,
          ratePlanId: room.ratePlanId,
          ratePlanName,
          unitId: room.unitId,
          unitName,
          checkIn: room.checkIn,
          checkOut: room.checkOut,
          adults: room.adults,
          children: room.children,
          status: room.status,
          guestName: room.guestName,
          amount: room.amount,
          nights: nightRows
            .filter((n) => n.reservationRoomId === room.id)
            .map((n) => ({ date: n.date, amount: n.amount })),
          checkedInAt: room.checkedInAt,
          checkedOutAt: room.checkedOutAt,
        })),
    };
  });
}

export interface ReservationFilter {
  propertyIds: string[] | 'all';
  statuses?: ReservationStatus[];
  /** Stays overlapping this range. */
  staying?: DateRange;
  arrivingOn?: DateString;
  departingOn?: DateString;
  channelCode?: string;
  guestId?: string;
  needsReview?: boolean;
  overbooked?: boolean;
  /** Live reservations that are overbooked or waiting for staff to review them. */
  needsAttention?: boolean;
  /** Confirmation code, guest name, email, phone or channel reference. */
  search?: string;
  limit?: number;
  offset?: number;
  sort?: 'arrival' | 'created';
}

export async function listReservations(
  db: DbOrTx,
  orgId: string,
  filter: ReservationFilter,
): Promise<{ reservations: ReservationDetail[]; total: number }> {
  const conditions: SQL[] = [eq(reservations.orgId, orgId)];
  if (filter.propertyIds !== 'all') {
    if (filter.propertyIds.length === 0) return { reservations: [], total: 0 };
    conditions.push(inArray(reservations.propertyId, filter.propertyIds));
  }
  if (filter.statuses?.length) conditions.push(inArray(reservations.status, filter.statuses));
  if (filter.staying) {
    conditions.push(
      lt(reservations.checkIn, filter.staying.to),
      gte(reservations.checkOut, filter.staying.from),
    );
  }
  if (filter.arrivingOn) conditions.push(eq(reservations.checkIn, filter.arrivingOn));
  if (filter.departingOn) conditions.push(eq(reservations.checkOut, filter.departingOn));
  if (filter.channelCode) conditions.push(eq(reservations.channelCode, filter.channelCode));
  if (filter.guestId) conditions.push(eq(reservations.guestId, filter.guestId));
  if (filter.needsAttention) {
    conditions.push(
      and(
        or(eq(reservations.needsReview, true), eq(reservations.overbooked, true))!,
        inArray(reservations.status, ['tentative', 'confirmed', 'in_house']),
      )!,
    );
  }
  if (filter.needsReview !== undefined)
    conditions.push(eq(reservations.needsReview, filter.needsReview));
  if (filter.overbooked !== undefined)
    conditions.push(eq(reservations.overbooked, filter.overbooked));
  const q = filter.search?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    conditions.push(
      or(
        ilike(reservations.code, like),
        ilike(reservations.guestName, like),
        ilike(reservations.channelReservationCode, like),
        ilike(reservations.externalId, like),
        sql`EXISTS (SELECT 1 FROM guests g WHERE g.id = ${reservations.guestId}
                    AND (g.email::text ILIKE ${like} OR g.phone ILIKE ${like}))`,
      )!,
    );
  }
  const where = and(...conditions);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reservations)
    .where(where);
  const rows = await db
    .select()
    .from(reservations)
    .where(where)
    .orderBy(
      ...(filter.sort === 'created'
        ? [desc(reservations.createdAt)]
        : [asc(reservations.checkIn), asc(reservations.createdAt)]),
    )
    .limit(Math.min(filter.limit ?? 50, 500))
    .offset(filter.offset ?? 0);
  return { reservations: await loadDetails(db, rows), total: count?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// Shared helpers

export function deriveReservationStatus(roomStatuses: ReservationStatus[]): ReservationStatus {
  const live = roomStatuses.filter((s) => s !== 'cancelled' && s !== 'no_show');
  if (live.length === 0) {
    return roomStatuses.length > 0 && roomStatuses.every((s) => s === 'no_show')
      ? 'no_show'
      : 'cancelled';
  }
  if (live.some((s) => s === 'in_house')) return 'in_house';
  if (live.every((s) => s === 'checked_out')) return 'checked_out';
  if (live.every((s) => s === 'tentative')) return 'tentative';
  return 'confirmed';
}

/** Rewrites the reservation's summary columns from its rooms. */
export async function syncReservationSummary(
  tx: Transaction,
  reservationId: string,
): Promise<ReservationRow> {
  const rooms = await tx
    .select()
    .from(reservationRooms)
    .where(eq(reservationRooms.reservationId, reservationId));
  const live = rooms.filter((r) => r.status !== 'cancelled' && r.status !== 'no_show');
  // A fully cancelled reservation keeps showing the dates it was for.
  const basis = live.length > 0 ? live : rooms;
  const status = deriveReservationStatus(rooms.map((r) => r.status));
  const [updated] = await tx
    .update(reservations)
    .set({
      status,
      checkIn: basis.map((r) => r.checkIn).sort()[0]!,
      checkOut: basis
        .map((r) => r.checkOut)
        .sort()
        .reverse()[0]!,
      adults: Math.max(
        1,
        basis.reduce((sum, r) => sum + r.adults, 0),
      ),
      children: basis.reduce((sum, r) => sum + r.children, 0),
      totalAmount: live.reduce((sum, r) => sum + r.amount, 0),
      version: sql`${reservations.version} + 1`,
    })
    .where(eq(reservations.id, reservationId))
    .returning();
  // A booking that is cancelled gives its use of a promotional code back; one reinstated takes it again.
  if (updated!.promoCodeId) await recountPromoUses(tx, updated!.promoCodeId);
  return updated!;
}

async function newReservationCode(tx: Transaction): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode(8);
    const [clash] = await tx
      .select({ id: reservations.id })
      .from(reservations)
      .where(eq(reservations.code, code));
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique reservation code');
}

interface PricedRoom {
  input: RoomInput;
  roomType: RoomTypeRow;
  ratePlan: RatePlanRow | null;
  range: DateRange;
  nights: { date: DateString; amount: number }[];
}

function validateStay(
  room: Pick<RoomInput, 'checkIn' | 'checkOut' | 'adults' | 'children'>,
): DateRange {
  const range = assertRange(room.checkIn, room.checkOut, 'stay');
  if (diffDays(range.from, range.to) > MAX_NIGHTS) {
    throw validationError(`A stay may be at most ${MAX_NIGHTS} nights`);
  }
  if (!Number.isInteger(room.adults) || room.adults < 1)
    throw validationError('Each room needs at least one adult');
  if (room.children !== undefined && (!Number.isInteger(room.children) || room.children < 0)) {
    throw validationError('Children must be zero or more');
  }
  return range;
}

function checkOccupancy(roomType: RoomTypeRow, adults: number, children: number): void {
  if (adults > roomType.maxAdults) {
    throw validationError(`${roomType.name} takes at most ${roomType.maxAdults} adults`);
  }
  if (children > roomType.maxChildren) {
    throw validationError(`${roomType.name} takes at most ${roomType.maxChildren} children`);
  }
  if (adults + children > roomType.maxOccupancy) {
    throw validationError(`${roomType.name} takes at most ${roomType.maxOccupancy} guests`);
  }
}

/** Resolves room type and rate plan, and prices every night of a room. */
async function priceRoom(
  tx: Transaction,
  property: PropertyRow,
  input: RoomInput,
  options: ReservationOptions,
  /** Amounts to keep for nights that were already priced (when a stay is extended or shortened). */
  keep: Map<DateString, number> = new Map(),
): Promise<PricedRoom> {
  const range = validateStay(input);
  const [roomType] = await tx
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.id, input.roomTypeId), eq(roomTypes.propertyId, property.id)));
  if (!roomType) throw notFound('Room type', input.roomTypeId);
  if (!options.skipOccupancyLimits) checkOccupancy(roomType, input.adults, input.children ?? 0);

  let ratePlan: RatePlanRow | null = null;
  if (input.ratePlanId) {
    const [found] = await tx
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.id, input.ratePlanId), eq(ratePlans.propertyId, property.id)));
    if (!found) throw notFound('Rate plan', input.ratePlanId);
    ratePlan = found;
    if (ratePlan.roomTypeId !== roomType.id) {
      throw validationError(`Rate plan ${ratePlan.name} does not belong to ${roomType.name}`);
    }
  }

  const dates = eachDate(range.from, range.to);
  let nights: { date: DateString; amount: number }[];
  if (input.nightlyRates) {
    if (input.nightlyRates.length !== dates.length) {
      throw validationError(
        `Expected ${dates.length} nightly rates, got ${input.nightlyRates.length}`,
      );
    }
    if (input.nightlyRates.some((a) => !Number.isInteger(a) || a < 0)) {
      throw validationError('Nightly rates must be non-negative whole amounts in minor units');
    }
    nights = dates.map((date, i) => ({ date, amount: input.nightlyRates![i]! }));
  } else if (ratePlan) {
    const days = await getRateCalendar(tx, {
      propertyId: property.id,
      range: { from: range.from, to: addDays(range.to, 1) },
      ratePlanIds: [ratePlan.id],
    });
    if (options.enforceRestrictions)
      assertNoViolations(restrictionViolations(days, range.from, range.to));
    const byDate = new Map(days.map((d) => [d.date, d]));
    nights = dates.map((date) => ({
      date,
      amount:
        keep.get(date) ??
        nightlyCharge(byDate.get(date)!.rate, ratePlan!, input.adults, input.children ?? 0),
    }));
  } else {
    // No rate plan (a channel sent a plan that is not mapped): carry the last known nightly amount forward.
    const known = [...keep.values()];
    const fallback = known.length > 0 ? known[known.length - 1]! : 0;
    nights = dates.map((date) => ({ date, amount: keep.get(date) ?? fallback }));
  }
  return { input, roomType, ratePlan, range, nights };
}

/**
 * Chooses and records the physical unit for a reservation room. Must run
 * inside `withInventoryLock` for the room's dates, which is what makes the
 * "is it free" check and the insert race-free.
 */
async function placeRoom(
  tx: Transaction,
  params: {
    propertyId: string;
    roomId: string;
    roomType: RoomTypeRow;
    range: DateRange;
    /** undefined: choose automatically where the room type requires a unit. null: leave unassigned. */
    requestedUnitId: string | null | undefined;
    allowUnassigned: boolean;
  },
): Promise<string | null> {
  let unitId: string | null = null;
  if (params.requestedUnitId) {
    const [unit] = await tx.select().from(units).where(eq(units.id, params.requestedUnitId));
    if (!unit || unit.propertyId !== params.propertyId)
      throw notFound('Unit', params.requestedUnitId);
    if (unit.roomTypeId !== params.roomType.id) {
      throw validationError(`${unit.name} is not a ${params.roomType.name}`);
    }
    if (!unit.active) throw validationError(`${unit.name} is not in service`);
    const conflicts = await occupancyConflicts(tx, unit.id, params.range, {
      reservationRoomId: params.roomId,
    });
    if (conflicts.length > 0) throw unitOccupiedError(conflicts);
    unitId = unit.id;
  } else if (params.roomType.assignment === 'at_booking' && params.requestedUnitId === undefined) {
    const [free] = await findFreeUnits(tx, params.roomType.id, params.range);
    if (free) {
      unitId = free.id;
    } else if (!params.allowUnassigned) {
      throw new DomainError(
        'no_availability',
        `No ${params.roomType.name} is free for those dates`,
      );
    }
  } else if (
    params.roomType.assignment === 'at_booking' &&
    params.requestedUnitId === null &&
    !params.allowUnassigned
  ) {
    throw validationError(`${params.roomType.name} reservations must have a unit`);
  } else if (
    params.roomType.assignment === 'at_check_in' &&
    params.roomType.autoAssign &&
    params.requestedUnitId === undefined
  ) {
    // Sold by count: a room is a convenience, not a condition. Take the best
    // fitting free room if there is one; otherwise the stay waits unassigned.
    const [free] = await findFreeUnits(tx, params.roomType.id, params.range);
    if (free) unitId = free.id;
  }
  if (unitId) {
    await occupyUnit(tx, {
      propertyId: params.propertyId,
      unitId,
      range: params.range,
      reservationRoomId: params.roomId,
    });
  }
  return unitId;
}

async function flagOverbooking(
  tx: Transaction,
  reservation: Pick<
    ReservationRow,
    'id' | 'orgId' | 'propertyId' | 'code' | 'guestName' | 'channelCode'
  >,
  nights: OverbookedNight[],
): Promise<void> {
  if (nights.length === 0) return;
  await tx
    .update(reservations)
    .set({ overbooked: true })
    .where(eq(reservations.id, reservation.id));
  const typeIds = [...new Set(nights.map((n) => n.roomTypeId))];
  const types = await tx
    .select({ id: roomTypes.id, name: roomTypes.name })
    .from(roomTypes)
    .where(inArray(roomTypes.id, typeIds));
  const dates = [...new Set(nights.map((n) => n.date))].sort();
  const typeNames = types.map((t) => t.name).join(', ');
  const span = dates.length === 1 ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`;
  await raiseAlert(tx, {
    orgId: reservation.orgId,
    propertyId: reservation.propertyId,
    kind: 'overbooking',
    severity: 'critical',
    title: `Overbooking: ${typeNames} on ${span}`,
    body:
      `Reservation ${reservation.code} for ${reservation.guestName}` +
      `${reservation.channelCode ? ` (${reservation.channelCode})` : ''} was recorded although no ${typeNames} ` +
      `was left on ${dates.length} night(s). Move a reservation to another unit, or contact one of the guests.`,
    entityType: 'reservation',
    entityId: reservation.id,
    dedupeKey: `overbooking:${reservation.id}`,
    metadata: { nights },
  });
}

// ---------------------------------------------------------------------------
// Creating

export async function createReservation(
  db: DbOrTx,
  actor: Actor,
  input: CreateReservationInput,
  options: ReservationOptions = {},
): Promise<ReservationDetail> {
  if (input.rooms.length === 0) throw validationError('A reservation needs at least one room');
  if (input.rooms.length > MAX_ROOMS)
    throw validationError(`A reservation may have at most ${MAX_ROOMS} rooms`);
  input.rooms.forEach(validateStay);
  const status = input.status ?? 'confirmed';

  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, input.propertyId);
    const priced: PricedRoom[] = [];
    for (const room of input.rooms) priced.push(await priceRoom(tx, property, room, options));
    for (const p of priced) {
      if (p.ratePlan && p.ratePlan.currency !== property.currency) {
        throw validationError('The rate plan currency does not match the property currency');
      }
    }

    const group = input.groupId
      ? await requireOpenGroup(tx, actor.orgId, input.groupId, property.id)
      : null;
    // A group's bookings are for the company the group is for, unless one says otherwise.
    const companyId = input.companyId === undefined ? (group?.companyId ?? null) : input.companyId;
    if (input.companyId) await requireCompany(tx, actor.orgId, input.companyId);
    const guest = await findOrCreateGuest(tx, actor.orgId, input.guest);
    // The name as given for this booking; the profile may spell it differently.
    const guestName = input.guest.firstName?.trim()
      ? `${input.guest.firstName.trim()} ${input.guest.lastName?.trim() ?? ''}`.trim()
      : fullName(guest);
    const holdMinutes = property.settings.bookingHoldMinutes ?? 15;
    const holdExpiresAt =
      status === 'tentative'
        ? (input.holdExpiresAt ?? new Date(Date.now() + holdMinutes * 60_000))
        : null;

    const scopes: InventoryScope[] = priced.map((p) => ({
      roomTypeId: p.roomType.id,
      range: p.range,
    }));
    const outcome = await withInventoryLock(
      tx,
      actor.orgId,
      scopes,
      { allowOverbooking: options.allowOverbooking },
      async () => {
        const [reservation] = await tx
          .insert(reservations)
          .values({
            orgId: actor.orgId,
            propertyId: property.id,
            code: await newReservationCode(tx),
            status,
            source: input.source,
            channelCode: input.channelCode ?? null,
            connectionId: input.connectionId ?? null,
            externalId: input.externalId ?? null,
            channelReservationCode: input.channelReservationCode ?? null,
            externalRevisionAt: input.externalRevisionAt ?? null,
            guestId: guest.id,
            guestName,
            checkIn: priced.map((p) => p.range.from).sort()[0]!,
            checkOut: priced
              .map((p) => p.range.to)
              .sort()
              .reverse()[0]!,
            adults: priced.reduce((sum, p) => sum + p.input.adults, 0),
            children: priced.reduce((sum, p) => sum + (p.input.children ?? 0), 0),
            currency: property.currency,
            totalAmount: priced.reduce(
              (sum, p) => sum + p.nights.reduce((s, n) => s + n.amount, 0),
              0,
            ),
            commissionAmount: input.commissionAmount ?? 0,
            paymentCollect: input.paymentCollect ?? 'property',
            arrivalTime: input.arrivalTime ?? null,
            specialRequests: input.specialRequests ?? null,
            notes: input.notes ?? null,
            holdExpiresAt,
            groupId: group?.id ?? null,
            companyId,
            needsReview: input.needsReview ?? false,
            reviewReason: input.reviewReason ?? null,
            createdBy: actor.userId ?? null,
          })
          .returning();

        for (const [position, p] of priced.entries()) {
          const [room] = await tx
            .insert(reservationRooms)
            .values({
              reservationId: reservation!.id,
              propertyId: property.id,
              position,
              roomTypeId: p.roomType.id,
              ratePlanId: p.ratePlan?.id ?? null,
              checkIn: p.range.from,
              checkOut: p.range.to,
              adults: p.input.adults,
              children: p.input.children ?? 0,
              status,
              guestName: p.input.guestName ?? guestName,
              amount: p.nights.reduce((sum, n) => sum + n.amount, 0),
              externalRoomRef: p.input.externalRoomRef ?? null,
            })
            .returning();
          await tx.insert(reservationNights).values(
            p.nights.map((n) => ({
              reservationRoomId: room!.id,
              date: n.date,
              amount: n.amount,
            })),
          );
          const unitId = await placeRoom(tx, {
            propertyId: property.id,
            roomId: room!.id,
            roomType: p.roomType,
            range: p.range,
            requestedUnitId: p.input.unitId === null ? undefined : p.input.unitId,
            allowUnassigned: options.allowOverbooking ?? false,
          });
          if (unitId)
            await tx
              .update(reservationRooms)
              .set({ unitId })
              .where(eq(reservationRooms.id, room!.id));
        }
        return reservation!;
      },
    );

    const reservation = outcome.value;
    await flagOverbooking(tx, reservation, outcome.newlyOverbooked);
    await writeAudit(tx, actor, {
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: reservation.id,
      propertyId: property.id,
      summary: `Created reservation ${reservation.code} for ${guestName}, ${reservation.checkIn} to ${reservation.checkOut}`,
      changes: {
        source: input.source,
        channelCode: input.channelCode ?? null,
        rooms: priced.map((p) => ({
          roomType: p.roomType.name,
          from: p.range.from,
          to: p.range.to,
        })),
        overbooked: outcome.newlyOverbooked.length > 0,
      },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.created',
        propertyId: property.id,
        payload: {
          reservationId: reservation.id,
          code: reservation.code,
          from: reservation.checkIn,
          to: reservation.checkOut,
        },
      },
    ]);
    return loadReservation(tx, actor.orgId, reservation.id);
  });
}

// ---------------------------------------------------------------------------
// Changing

export async function lockReservation(
  tx: Transaction,
  orgId: string,
  reservationId: string,
  expectedVersion?: number,
): Promise<ReservationRow> {
  const [row] = await tx
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)))
    .for('update');
  if (!row) throw notFound('Reservation', reservationId);
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new DomainError(
      'stale_version',
      'This reservation was changed by someone else. Reload and try again.',
      {
        currentVersion: row.version,
      },
    );
  }
  return row;
}

export interface ReservationPatch {
  guest?: GuestInput;
  arrivalTime?: string | null;
  specialRequests?: string | null;
  notes?: string | null;
  commissionAmount?: number;
  paymentCollect?: PaymentCollect;
  needsReview?: boolean;
  companyId?: string | null;
  channelReservationCode?: string | null;
  externalRevisionAt?: Date | null;
}

/** Changes details that do not affect inventory. */
export async function updateReservation(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  patch: ReservationPatch,
  options: Pick<ReservationOptions, 'expectedVersion'> = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const before = await lockReservation(tx, actor.orgId, reservationId, options.expectedVersion);
    const { guest: guestInput, ...fields } = patch;
    const set: Partial<typeof reservations.$inferInsert> = { ...fields };
    if (patch.needsReview === false) set.reviewReason = null;
    if (patch.companyId && patch.companyId !== before.companyId) {
      await requireCompany(tx, actor.orgId, patch.companyId);
    }
    if (guestInput) {
      const guest = await findOrCreateGuest(tx, actor.orgId, guestInput);
      set.guestId = guest.id;
      set.guestName = guestInput.firstName
        ? `${guestInput.firstName} ${guestInput.lastName ?? ''}`.trim()
        : fullName(guest);
    }
    const changed = Object.entries(set).filter(
      ([k, v]) =>
        v !== undefined &&
        JSON.stringify(v) !== JSON.stringify((before as Record<string, unknown>)[k]),
    );
    if (changed.length === 0) return loadReservation(tx, actor.orgId, reservationId);
    await tx
      .update(reservations)
      .set({ ...set, version: sql`${reservations.version} + 1` })
      .where(eq(reservations.id, reservationId));
    await writeAudit(tx, actor, {
      action: 'reservation.updated',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: before.propertyId,
      summary: `Updated ${changed.map(([k]) => k).join(', ')} on reservation ${before.code}`,
      changes: Object.fromEntries(
        changed.map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k], to: v }]),
      ),
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: before.propertyId,
        payload: { reservationId, code: before.code },
      },
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

export interface RoomPatch {
  roomTypeId?: string;
  ratePlanId?: string | null;
  /** A unit id moves the room there; null clears the assignment; omit to keep the current unit where possible. */
  unitId?: string | null;
  checkIn?: DateString;
  checkOut?: DateString;
  adults?: number;
  children?: number;
  guestName?: string | null;
  nightlyRates?: number[];
}

export interface RoomChangeResult {
  reservation: ReservationDetail;
  /** True when the room lost its unit because the unit is taken on the new dates and no other was free. */
  unitReleased: boolean;
  /** Name of the room the stay was moved to because its own was taken on the new dates. */
  movedToUnit: string | null;
}

/**
 * Moves, extends, shortens, re-types or re-prices one room of a reservation.
 * Inventory for the old and the new dates is locked and rebuilt together, so
 * a move can never leave both, or neither, of the date ranges held.
 */
export async function updateReservationRoom(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  roomId: string,
  patch: RoomPatch,
  options: ReservationOptions = {},
): Promise<RoomChangeResult> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(
      tx,
      actor.orgId,
      reservationId,
      options.expectedVersion,
    );
    const property = await requireProperty(tx, actor.orgId, reservation.propertyId);
    const [room] = await tx
      .select()
      .from(reservationRooms)
      .where(
        and(eq(reservationRooms.id, roomId), eq(reservationRooms.reservationId, reservationId)),
      );
    if (!room) throw notFound('Reservation room', roomId);
    if (!isHolding(room.status) || room.status === 'checked_out') {
      throw invalidState(`A ${room.status.replace('_', ' ')} room cannot be changed`);
    }
    if (
      room.status === 'in_house' &&
      patch.checkIn !== undefined &&
      patch.checkIn !== room.checkIn
    ) {
      throw invalidState('The arrival date of a guest who has checked in cannot be changed');
    }

    const typeChanged = patch.roomTypeId !== undefined && patch.roomTypeId !== room.roomTypeId;
    const planChanged = patch.ratePlanId !== undefined && patch.ratePlanId !== room.ratePlanId;
    const next: RoomInput = {
      roomTypeId: patch.roomTypeId ?? room.roomTypeId,
      // A plan belongs to one room type, so a type change without a new plan drops the plan.
      ratePlanId:
        patch.ratePlanId !== undefined ? patch.ratePlanId : typeChanged ? null : room.ratePlanId,
      checkIn: patch.checkIn ?? room.checkIn,
      checkOut: patch.checkOut ?? room.checkOut,
      adults: patch.adults ?? room.adults,
      children: patch.children ?? room.children,
      nightlyRates: patch.nightlyRates,
    };

    const existingNights = await tx
      .select()
      .from(reservationNights)
      .where(eq(reservationNights.reservationRoomId, roomId));
    const occupancyChanged = next.adults !== room.adults || next.children !== room.children;
    // Nights already agreed keep their price unless the product itself changed.
    const keep =
      typeChanged || planChanged || occupancyChanged
        ? new Map<DateString, number>()
        : new Map(existingNights.map((n) => [n.date, n.amount]));
    if (typeChanged && next.ratePlanId === null && !patch.nightlyRates) {
      // Moving to another room type without choosing a plan: use that type's default plan.
      const [fallback] = await tx
        .select({ id: ratePlans.id })
        .from(ratePlans)
        .where(and(eq(ratePlans.roomTypeId, next.roomTypeId), eq(ratePlans.active, true)))
        .orderBy(desc(ratePlans.isDefault), asc(ratePlans.name))
        .limit(1);
      next.ratePlanId = fallback?.id ?? null;
    }
    const priced = await priceRoom(tx, property, next, options, keep);

    const oldRange: DateRange = { from: room.checkIn, to: room.checkOut };
    const scopes: InventoryScope[] = [
      { roomTypeId: room.roomTypeId, range: oldRange },
      { roomTypeId: priced.roomType.id, range: priced.range },
    ];

    let unitReleased = false;
    let movedToUnitId: string | null = null;
    const outcome = await withInventoryLock(
      tx,
      actor.orgId,
      scopes,
      { allowOverbooking: options.allowOverbooking },
      async () => {
        await releaseOccupancy(tx, { reservationRoomId: roomId });
        await tx
          .update(reservationRooms)
          .set({
            roomTypeId: priced.roomType.id,
            ratePlanId: priced.ratePlan?.id ?? null,
            unitId: null,
            checkIn: priced.range.from,
            checkOut: priced.range.to,
            adults: next.adults,
            children: next.children ?? 0,
            guestName: patch.guestName !== undefined ? patch.guestName : room.guestName,
            amount: priced.nights.reduce((sum, n) => sum + n.amount, 0),
          })
          .where(eq(reservationRooms.id, roomId));
        await tx.delete(reservationNights).where(eq(reservationNights.reservationRoomId, roomId));
        await tx.insert(reservationNights).values(
          priced.nights.map((n) => ({
            reservationRoomId: roomId,
            date: n.date,
            amount: n.amount,
          })),
        );

        // Decide the unit: an explicit request wins; otherwise keep the current
        // unit if it still fits; otherwise choose again or leave it open.
        let requested: string | null | undefined = patch.unitId;
        let keptUnitTaken = false;
        if (requested === undefined && room.unitId && !typeChanged) {
          const conflicts = await occupancyConflicts(tx, room.unitId, priced.range, {
            reservationRoomId: roomId,
          });
          if (conflicts.length === 0) {
            requested = room.unitId;
          } else if (room.status === 'in_house') {
            // Never silently take the room away from a guest who is in it.
            throw unitOccupiedError(conflicts);
          } else if (priced.roomType.assignment === 'at_check_in') {
            // Rooms of one type are interchangeable before arrival: take another
            // free one if the room type assigns automatically, else leave it open.
            keptUnitTaken = true;
            requested = priced.roomType.autoAssign ? undefined : null;
          }
        }
        const unitId = await placeRoom(tx, {
          propertyId: property.id,
          roomId,
          roomType: priced.roomType,
          range: priced.range,
          requestedUnitId: requested,
          allowUnassigned: options.allowOverbooking ?? false,
        });
        if (room.status === 'in_house' && !unitId) {
          throw validationError('A guest who has checked in must have a room');
        }
        if (unitId)
          await tx.update(reservationRooms).set({ unitId }).where(eq(reservationRooms.id, roomId));
        if (keptUnitTaken) {
          if (unitId) movedToUnitId = unitId;
          else unitReleased = true;
        }
      },
    );

    const summary = await syncReservationSummary(tx, reservationId);
    await flagOverbooking(tx, summary, outcome.newlyOverbooked);
    await writeAudit(tx, actor, {
      action: 'reservation.room_changed',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: property.id,
      summary: `Changed a room on reservation ${reservation.code}`,
      changes: {
        from: {
          roomTypeId: room.roomTypeId,
          unitId: room.unitId,
          checkIn: room.checkIn,
          checkOut: room.checkOut,
          amount: room.amount,
        },
        to: {
          roomTypeId: priced.roomType.id,
          checkIn: priced.range.from,
          checkOut: priced.range.to,
          amount: priced.nights.reduce((sum, n) => sum + n.amount, 0),
        },
        unitReleased,
      },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: property.id,
        payload: {
          reservationId,
          code: reservation.code,
          from: summary.checkIn,
          to: summary.checkOut,
        },
      },
    ]);
    const updated = await loadReservation(tx, actor.orgId, reservationId);
    return {
      reservation: updated,
      unitReleased,
      movedToUnit: movedToUnitId
        ? (updated.rooms.find((r) => r.id === roomId)?.unitName ?? null)
        : null,
    };
  });
}

/** Adds a room to an existing reservation. */
export async function addReservationRoom(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  input: RoomInput,
  options: ReservationOptions = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(
      tx,
      actor.orgId,
      reservationId,
      options.expectedVersion,
    );
    if (!['tentative', 'confirmed', 'in_house'].includes(reservation.status)) {
      throw invalidState(
        `Rooms cannot be added to a ${reservation.status.replace('_', ' ')} reservation`,
      );
    }
    const property = await requireProperty(tx, actor.orgId, reservation.propertyId);
    const priced = await priceRoom(tx, property, input, options);
    const status: ReservationStatus =
      reservation.status === 'tentative' ? 'tentative' : 'confirmed';
    const outcome = await withInventoryLock(
      tx,
      actor.orgId,
      [{ roomTypeId: priced.roomType.id, range: priced.range }],
      { allowOverbooking: options.allowOverbooking },
      async () => {
        const [last] = await tx
          .select({ position: sql<number>`coalesce(max(${reservationRooms.position}), -1)::int` })
          .from(reservationRooms)
          .where(eq(reservationRooms.reservationId, reservationId));
        const [room] = await tx
          .insert(reservationRooms)
          .values({
            reservationId,
            propertyId: property.id,
            position: (last?.position ?? -1) + 1,
            roomTypeId: priced.roomType.id,
            ratePlanId: priced.ratePlan?.id ?? null,
            checkIn: priced.range.from,
            checkOut: priced.range.to,
            adults: input.adults,
            children: input.children ?? 0,
            status,
            guestName: input.guestName ?? reservation.guestName,
            amount: priced.nights.reduce((sum, n) => sum + n.amount, 0),
            externalRoomRef: input.externalRoomRef ?? null,
          })
          .returning();
        await tx.insert(reservationNights).values(
          priced.nights.map((n) => ({
            reservationRoomId: room!.id,
            date: n.date,
            amount: n.amount,
          })),
        );
        const unitId = await placeRoom(tx, {
          propertyId: property.id,
          roomId: room!.id,
          roomType: priced.roomType,
          range: priced.range,
          requestedUnitId: input.unitId === null ? undefined : input.unitId,
          allowUnassigned: options.allowOverbooking ?? false,
        });
        if (unitId)
          await tx
            .update(reservationRooms)
            .set({ unitId })
            .where(eq(reservationRooms.id, room!.id));
      },
    );
    const summary = await syncReservationSummary(tx, reservationId);
    await flagOverbooking(tx, summary, outcome.newlyOverbooked);
    await writeAudit(tx, actor, {
      action: 'reservation.room_added',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: property.id,
      summary: `Added a ${priced.roomType.name} to reservation ${reservation.code}`,
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: property.id,
        payload: { reservationId, code: reservation.code },
      },
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

/** Moves a room between statuses that release or take inventory, rebuilding the ledger for its nights. */
async function transitionRooms(
  tx: Transaction,
  actor: Actor,
  reservation: ReservationRow,
  rooms: ReservationRoomRow[],
  to: ReservationStatus,
  options: ReservationOptions,
): Promise<OverbookedNight[]> {
  if (rooms.length === 0) return [];
  const scopes: InventoryScope[] = rooms.map((r) => ({
    roomTypeId: r.roomTypeId,
    range: { from: r.checkIn, to: r.checkOut },
  }));
  const outcome = await withInventoryLock(
    tx,
    actor.orgId,
    scopes,
    { allowOverbooking: options.allowOverbooking },
    async () => {
      for (const room of rooms) {
        const wasHolding = isHolding(room.status);
        const willHold = isHolding(to);
        await tx
          .update(reservationRooms)
          .set({ status: to })
          .where(eq(reservationRooms.id, room.id));
        if (wasHolding && !willHold) {
          await releaseOccupancy(tx, { reservationRoomId: room.id });
          await tx
            .update(reservationRooms)
            .set({ unitId: null })
            .where(eq(reservationRooms.id, room.id));
        } else if (!wasHolding && willHold) {
          const [roomType] = await tx
            .select()
            .from(roomTypes)
            .where(eq(roomTypes.id, room.roomTypeId));
          const unitId = await placeRoom(tx, {
            propertyId: reservation.propertyId,
            roomId: room.id,
            roomType: roomType!,
            range: { from: room.checkIn, to: room.checkOut },
            requestedUnitId: undefined,
            allowUnassigned: options.allowOverbooking ?? false,
          });
          if (unitId)
            await tx
              .update(reservationRooms)
              .set({ unitId })
              .where(eq(reservationRooms.id, room.id));
        }
      }
    },
  );
  return outcome.newlyOverbooked;
}

export async function cancelReservation(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  params: { reason?: string | null; roomIds?: string[]; expectedVersion?: number } = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(
      tx,
      actor.orgId,
      reservationId,
      params.expectedVersion,
    );
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const targets = rooms.filter((r) => (params.roomIds ? params.roomIds.includes(r.id) : true));
    if (params.roomIds && targets.length !== params.roomIds.length)
      throw notFound('Reservation room');
    if (targets.some((r) => r.status === 'in_house')) {
      throw invalidState('A guest who has checked in must be checked out, not cancelled');
    }
    const cancellable = targets.filter((r) => r.status === 'tentative' || r.status === 'confirmed');
    if (cancellable.length === 0) {
      // Cancelling something already cancelled is a no-op, so repeated channel messages are harmless.
      if (targets.every((r) => r.status === 'cancelled'))
        return loadReservation(tx, actor.orgId, reservationId);
      throw invalidState(
        `A ${reservation.status.replace('_', ' ')} reservation cannot be cancelled`,
      );
    }
    await transitionRooms(tx, actor, reservation, cancellable, 'cancelled', {});
    const summary = await syncReservationSummary(tx, reservationId);
    if (summary.status === 'cancelled') {
      await tx
        .update(reservations)
        .set({
          cancelledAt: new Date(),
          cancellationReason: params.reason ?? null,
          holdExpiresAt: null,
        })
        .where(eq(reservations.id, reservationId));
    }
    await writeAudit(tx, actor, {
      action: 'reservation.cancelled',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary:
        summary.status === 'cancelled'
          ? `Cancelled reservation ${reservation.code}`
          : `Cancelled ${cancellable.length} room(s) of reservation ${reservation.code}`,
      changes: { reason: params.reason ?? null, rooms: cancellable.map((r) => r.id) },
    });
    await emit(tx, actor.orgId, [
      {
        kind: summary.status === 'cancelled' ? 'reservation.cancelled' : 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: {
          reservationId,
          code: reservation.code,
          from: reservation.checkIn,
          to: reservation.checkOut,
        },
      },
    ]);
    return loadReservation(tx, actor.orgId, reservationId);
  });
}

/** Marks a reservation whose guest never arrived. Its remaining nights go back on sale. */
export async function markNoShow(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(tx, actor.orgId, reservationId);
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const targets = rooms.filter((r) => r.status === 'confirmed');
    if (targets.length === 0)
      throw invalidState('Only a confirmed reservation that has not checked in can be a no-show');
    await transitionRooms(tx, actor, reservation, targets, 'no_show', {});
    await syncReservationSummary(tx, reservationId);
    await writeAudit(tx, actor, {
      action: 'reservation.no_show',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Marked reservation ${reservation.code} as a no-show`,
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

/** Brings a cancelled or no-show reservation back, if its dates are still available. */
export async function reinstateReservation(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  options: ReservationOptions = {},
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(
      tx,
      actor.orgId,
      reservationId,
      options.expectedVersion,
    );
    const rooms = await tx
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, reservationId));
    const targets = rooms.filter((r) => r.status === 'cancelled' || r.status === 'no_show');
    if (targets.length === 0)
      throw invalidState('Only a cancelled or no-show reservation can be reinstated');
    const overbooked = await transitionRooms(tx, actor, reservation, targets, 'confirmed', options);
    const summary = await syncReservationSummary(tx, reservationId);
    await tx
      .update(reservations)
      .set({ cancelledAt: null, cancellationReason: null })
      .where(eq(reservations.id, reservationId));
    await flagOverbooking(tx, summary, overbooked);
    await writeAudit(tx, actor, {
      action: 'reservation.reinstated',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Reinstated reservation ${reservation.code}`,
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

/** Turns a tentative hold into a confirmed reservation. Inventory is already held, so this cannot fail on availability. */
export async function confirmReservation(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
): Promise<ReservationDetail> {
  return transact(db, async (tx) => {
    const reservation = await lockReservation(tx, actor.orgId, reservationId);
    if (reservation.status === 'confirmed') return loadReservation(tx, actor.orgId, reservationId);
    if (reservation.status !== 'tentative') {
      throw invalidState(
        `A ${reservation.status.replace('_', ' ')} reservation cannot be confirmed`,
      );
    }
    await tx
      .update(reservationRooms)
      .set({ status: 'confirmed' })
      .where(
        and(
          eq(reservationRooms.reservationId, reservationId),
          eq(reservationRooms.status, 'tentative'),
        ),
      );
    await tx
      .update(reservations)
      .set({ holdExpiresAt: null })
      .where(eq(reservations.id, reservationId));
    await syncReservationSummary(tx, reservationId);
    await writeAudit(tx, actor, {
      action: 'reservation.confirmed',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Confirmed reservation ${reservation.code}`,
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

/** Cancels tentative reservations whose hold has run out, releasing their inventory. Returns how many. */
export async function expireHolds(
  db: DbOrTx,
  actor: Actor,
  now: Date = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.orgId, actor.orgId),
        eq(reservations.status, 'tentative'),
        lte(reservations.holdExpiresAt, now),
      ),
    )
    .limit(200);
  let expired = 0;
  for (const { id } of due) {
    try {
      await cancelReservation(db, actor, id, {
        reason: 'Hold expired before the booking was completed',
      });
      expired++;
    } catch (err) {
      // Confirmed or cancelled in the meantime: nothing to release.
      if (!(err instanceof DomainError)) throw err;
    }
  }
  return expired;
}

export function guestInputFromName(
  name: string,
  extra: Omit<GuestInput, 'firstName' | 'lastName'> = {},
): GuestInput {
  return { ...splitName(name), ...extra };
}
