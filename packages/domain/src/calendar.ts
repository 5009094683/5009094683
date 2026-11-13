import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import {
  properties,
  ratePlans,
  reservationRooms,
  reservations,
  roomTypes,
  units,
  type BlockKind,
  type DbOrTx,
  type HousekeepingStatus,
  type ReservationStatus,
} from '@pms/db';
import { listBlocks } from './blocks';
import { assertRange, diffDays, eachDate, type DateRange, type DateString } from './dates';
import { validationError } from './errors';
import { getAvailability } from './inventory';
import { getRateCalendar } from './rates';

export interface CalendarUnit {
  id: string;
  name: string;
  parentUnitId: string | null;
  housekeepingStatus: HousekeepingStatus;
}

export interface CalendarDay {
  date: DateString;
  total: number;
  available: number;
  sold: number;
  blocked: number;
  outOfOrder: number;
  linked: number;
  overbooked: number;
  /** Rate of the room type's default plan, for orientation. Null when the type has no plan. */
  rate: number | null;
  stopSell: boolean;
  minStay: number | null;
}

export interface CalendarRoomType {
  id: string;
  code: string;
  name: string;
  assignment: 'at_booking' | 'at_check_in';
  defaultRatePlanId: string | null;
  units: CalendarUnit[];
  days: CalendarDay[];
}

export interface CalendarStay {
  /** Reservation room id: one bar on the grid. */
  id: string;
  reservationId: string;
  code: string;
  guestName: string;
  status: ReservationStatus;
  source: string;
  channelCode: string | null;
  roomTypeId: string;
  /** Null while no physical unit is assigned; shown in the room type's unassigned row. */
  unitId: string | null;
  checkIn: DateString;
  checkOut: DateString;
  adults: number;
  children: number;
  amount: number;
  overbooked: boolean;
  needsReview: boolean;
  version: number;
}

export interface CalendarBlock {
  id: string;
  roomTypeId: string;
  unitId: string | null;
  kind: BlockKind;
  startDate: DateString;
  endDate: DateString;
  quantity: number;
  reason: string | null;
  source: string;
}

export interface CalendarProperty {
  id: string;
  code: string;
  name: string;
  kind: 'hotel' | 'villa';
  timezone: string;
  currency: string;
  roomTypes: CalendarRoomType[];
  stays: CalendarStay[];
  blocks: CalendarBlock[];
}

export interface CalendarView {
  range: DateRange;
  dates: DateString[];
  properties: CalendarProperty[];
}

const MAX_CALENDAR_DAYS = 120;

/**
 * Everything the multi-property calendar grid shows for a date range: units
 * grouped by room type, per-night availability and rates, stays and blocks.
 */
export async function getCalendar(
  db: DbOrTx,
  orgId: string,
  params: { propertyIds: string[]; range: DateRange },
): Promise<CalendarView> {
  const range = assertRange(params.range.from, params.range.to);
  if (diffDays(range.from, range.to) > MAX_CALENDAR_DAYS) {
    throw validationError(`The calendar shows at most ${MAX_CALENDAR_DAYS} days at a time`);
  }
  const dates = eachDate(range.from, range.to);
  if (params.propertyIds.length === 0) return { range, dates, properties: [] };

  const propertyRows = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.orgId, orgId),
        inArray(properties.id, params.propertyIds),
        eq(properties.active, true),
      ),
    )
    .orderBy(asc(properties.name));
  const ids = propertyRows.map((p) => p.id);
  if (ids.length === 0) return { range, dates, properties: [] };

  const [typeRows, unitRows, planRows, stayRows, blockRows] = await Promise.all([
    db
      .select()
      .from(roomTypes)
      .where(and(inArray(roomTypes.propertyId, ids), eq(roomTypes.active, true)))
      .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name)),
    db
      .select()
      .from(units)
      .where(and(inArray(units.propertyId, ids), eq(units.active, true)))
      .orderBy(asc(units.sortOrder), asc(units.name)),
    db
      .select()
      .from(ratePlans)
      .where(and(inArray(ratePlans.propertyId, ids), eq(ratePlans.active, true))),
    db
      .select({ room: reservationRooms, reservation: reservations })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(
          inArray(reservationRooms.propertyId, ids),
          inArray(reservationRooms.status, ['tentative', 'confirmed', 'in_house', 'checked_out']),
          lt(reservationRooms.checkIn, range.to),
          gt(reservationRooms.checkOut, range.from),
        ),
      )
      .orderBy(asc(reservationRooms.checkIn)),
    listBlocks(db, { propertyIds: ids, range }),
  ]);

  const out: CalendarProperty[] = [];
  for (const property of propertyRows) {
    const types = typeRows.filter((t) => t.propertyId === property.id);
    const availability = await getAvailability(db, { propertyId: property.id, range });
    const defaultPlanOf = new Map<string, string>();
    for (const type of types) {
      const plans = planRows.filter((p) => p.roomTypeId === type.id);
      const chosen = plans.find((p) => p.isDefault) ?? plans[0];
      if (chosen) defaultPlanOf.set(type.id, chosen.id);
    }
    const rateDays = defaultPlanOf.size
      ? await getRateCalendar(db, {
          propertyId: property.id,
          range,
          ratePlanIds: [...defaultPlanOf.values()],
        })
      : [];
    const rateByKey = new Map(rateDays.map((d) => [`${d.ratePlanId}|${d.date}`, d]));
    const availabilityByKey = new Map(availability.map((a) => [`${a.roomTypeId}|${a.date}`, a]));

    out.push({
      id: property.id,
      code: property.code,
      name: property.name,
      kind: property.kind,
      timezone: property.timezone,
      currency: property.currency,
      roomTypes: types.map((type) => {
        const planId = defaultPlanOf.get(type.id) ?? null;
        return {
          id: type.id,
          code: type.code,
          name: type.name,
          assignment: type.assignment,
          defaultRatePlanId: planId,
          units: unitRows
            .filter((u) => u.roomTypeId === type.id)
            .map((u) => ({
              id: u.id,
              name: u.name,
              parentUnitId: u.parentUnitId,
              housekeepingStatus: u.housekeepingStatus,
            })),
          days: dates.map((date) => {
            const a = availabilityByKey.get(`${type.id}|${date}`);
            const r = planId ? rateByKey.get(`${planId}|${date}`) : undefined;
            return {
              date,
              total: a?.total ?? 0,
              available: a?.available ?? 0,
              sold: a?.sold ?? 0,
              blocked: a?.blocked ?? 0,
              outOfOrder: a?.outOfOrder ?? 0,
              linked: a?.linked ?? 0,
              overbooked: a?.overbooked ?? 0,
              rate: r?.rate ?? null,
              stopSell: r?.stopSell ?? false,
              minStay: r?.minStayArrival ?? null,
            };
          }),
        };
      }),
      stays: stayRows
        .filter((s) => s.room.propertyId === property.id)
        .map(({ room, reservation }) => ({
          id: room.id,
          reservationId: reservation.id,
          code: reservation.code,
          guestName: room.guestName ?? reservation.guestName,
          status: room.status,
          source: reservation.source,
          channelCode: reservation.channelCode,
          roomTypeId: room.roomTypeId,
          unitId: room.unitId,
          checkIn: room.checkIn,
          checkOut: room.checkOut,
          adults: room.adults,
          children: room.children,
          amount: room.amount,
          overbooked: reservation.overbooked,
          needsReview: reservation.needsReview,
          version: reservation.version,
        })),
      blocks: blockRows
        .filter((b) => b.propertyId === property.id)
        .map((b) => ({
          id: b.id,
          roomTypeId: b.roomTypeId,
          unitId: b.unitId,
          kind: b.kind,
          startDate: b.startDate,
          endDate: b.endDate,
          quantity: b.quantity,
          reason: b.reason,
          source: b.source,
        })),
    });
  }
  return { range, dates, properties: out };
}
