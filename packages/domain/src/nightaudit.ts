import { and, desc, eq, sql } from 'drizzle-orm';
import {
  nightAudits,
  properties,
  reservationRooms,
  reservations,
  type Database,
  type DbOrTx,
  type NightAuditSummary,
  type Transaction,
} from '@pms/db';
import { raiseAlert, resolveAlert } from './alerts';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { addDays, timeIn, todayIn, type DateString } from './dates';
import { invalidState, notFound } from './errors';
import { businessDateOf } from './folios';
import { postRoomCharges } from './frontdesk';
import { generateHousekeepingTasks } from './housekeeping';
import { emit } from './outbox';
import { markNoShow } from './reservations';
import { transact } from './sqlx';

export type NightAuditRow = typeof nightAudits.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;

const DEFAULT_AUDIT_HOUR = 3;

/**
 * Closes a hotel day and opens the next.
 *
 * In one transaction, for the day being closed (D):
 * 1. every room occupied on the night of D is charged for it, once;
 * 2. guests due on D who never arrived are marked no-show (if the property
 *    has chosen that) or listed for staff;
 * 3. guests who should have left by D and are still checked in are listed;
 * 4. tomorrow's cleaning list is written and occupied rooms marked for service;
 * 5. the day's figures are saved for reports;
 * 6. the hotel day moves to D + 1.
 *
 * A day can be closed once. Closing it again is refused, and since a night
 * is charged at most once anyway, a retry after a failure cannot double-charge.
 */
export async function runNightAudit(
  db: DbOrTx,
  actor: Actor,
  propertyId: string,
  now: Date = new Date(),
): Promise<NightAuditRow> {
  const startedAt = new Date();
  return transact(db, async (tx) => {
    const [property] = await tx
      .select()
      .from(properties)
      .where(and(eq(properties.id, propertyId), eq(properties.orgId, actor.orgId)))
      .for('update');
    if (!property) throw notFound('Property', propertyId);
    const day = businessDateOf(property, now);
    const today = todayIn(property.timezone, now);
    if (day > today) {
      throw invalidState(`The hotel day ${day} has not started yet; there is nothing to close`);
    }
    const next = addDays(day, 1);
    const summary: NightAuditSummary = {
      roomChargesPosted: 0,
      roomRevenue: 0,
      noShows: [],
      pendingArrivals: [],
      overdueDepartures: [],
      stayovers: 0,
      housekeepingTasks: 0,
      warnings: [],
    };

    // 1. Room charges for everyone in the house tonight.
    const inHouse = await tx
      .select({ room: reservationRooms, reservation: reservations })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(eq(reservationRooms.propertyId, propertyId), eq(reservationRooms.status, 'in_house')),
      );
    for (const { room, reservation } of inHouse) {
      const posted = await postRoomCharges(tx, actor, reservation, room, next, 'night_audit');
      summary.roomChargesPosted += posted.nights;
      summary.roomRevenue += posted.amount;
      if (room.checkOut <= day) {
        summary.overdueDepartures.push(`${reservation.code} ${reservation.guestName}`);
      } else {
        summary.stayovers++;
      }
    }

    // 2. Arrivals that did not happen.
    const missing = await tx
      .select({ room: reservationRooms, reservation: reservations })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
      .where(
        and(
          eq(reservationRooms.propertyId, propertyId),
          eq(reservationRooms.status, 'confirmed'),
          sql`${reservationRooms.checkIn} <= ${day}::date`,
        ),
      );
    const seen = new Set<string>();
    for (const { reservation } of missing) {
      if (seen.has(reservation.id)) continue;
      seen.add(reservation.id);
      const label = `${reservation.code} ${reservation.guestName}`;
      if (property.settings.autoNoShow) {
        await markNoShow(tx, actor, reservation.id);
        summary.noShows.push(label);
      } else {
        summary.pendingArrivals.push(label);
      }
    }

    // 4. Tomorrow's cleaning: whoever stays or leaves tomorrow, and every occupied room needs service.
    summary.housekeepingTasks = await generateHousekeepingTasks(tx, propertyId, next);
    await tx.execute(sql`
      UPDATE units SET housekeeping_status = 'dirty'
      WHERE property_id = ${propertyId} AND housekeeping_status IN ('clean', 'inspected')
        AND id IN (SELECT unit_id FROM reservation_rooms
                   WHERE property_id = ${propertyId} AND status = 'in_house' AND unit_id IS NOT NULL)
    `);

    // 5. The day's figures.
    await snapshotDay(tx, property, day);

    if (summary.overdueDepartures.length > 0) {
      summary.warnings.push(
        `${summary.overdueDepartures.length} guest(s) were due to leave and are still checked in`,
      );
    }
    if (summary.pendingArrivals.length > 0) {
      summary.warnings.push(`${summary.pendingArrivals.length} booking(s) did not arrive`);
    }

    // 6. The next day begins.
    await tx.update(properties).set({ businessDate: next }).where(eq(properties.id, propertyId));
    const [audit] = await tx
      .insert(nightAudits)
      .values({
        propertyId,
        businessDate: day,
        status: 'completed',
        summary,
        runBy: actor.userId ?? null,
        runByLabel: actor.label,
        startedAt,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'night_audit.completed',
      entityType: 'property',
      entityId: propertyId,
      propertyId,
      summary: `Closed ${day}: ${summary.roomChargesPosted} room charge(s) posted`,
      changes: { ...summary },
    });
    const exceptionsKey = `night_audit_exceptions:${propertyId}`;
    if (summary.warnings.length > 0) {
      await raiseAlert(tx, {
        orgId: actor.orgId,
        propertyId,
        kind: 'night_audit',
        severity: 'warning',
        title: `${property.name}: the night audit for ${day} needs a look`,
        body: [
          ...summary.warnings,
          ...(summary.overdueDepartures.length > 0
            ? [
                `Still checked in: ${summary.overdueDepartures.slice(0, 10).join(', ')}. Extend their stay or check them out.`,
              ]
            : []),
          ...(summary.pendingArrivals.length > 0
            ? [
                `Did not arrive: ${summary.pendingArrivals.slice(0, 10).join(', ')}. Mark them no-show, or check them in if they are late.`,
              ]
            : []),
        ].join('\n'),
        dedupeKey: exceptionsKey,
        metadata: { businessDate: day },
      });
    } else {
      await resolveAlert(tx, actor.orgId, exceptionsKey);
    }
    await resolveAlert(tx, actor.orgId, `night_audit_failed:${propertyId}`);
    await emit(tx, actor.orgId, [
      { kind: 'folio.updated', propertyId, payload: {} },
      { kind: 'task.updated', propertyId, payload: {} },
    ]);
    return audit!;
  });
}

/** Saves what the day looked like, for reports. Replaces an earlier snapshot of the same day. */
async function snapshotDay(tx: Transaction, property: PropertyRow, day: DateString): Promise<void> {
  const tz = property.timezone;
  await tx.execute(sql`
    INSERT INTO daily_stats (property_id, date, available_rooms, sold_rooms, out_of_order, arrivals,
                             departures, no_shows, cancellations, room_revenue, other_revenue,
                             tax_amount, payments_received, by_channel)
    SELECT ${property.id}, ${day}::date,
      -- Rooms that could be sold: all of them, less those closed, less those taken by the other side of a linked villa.
      coalesce((SELECT sum(greatest(0, coalesce(i.total, u.n) - coalesce(i.out_of_order, 0) - coalesce(i.linked, 0)))
        FROM room_types rt
        LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM units WHERE room_type_id = rt.id AND active) u ON true
        LEFT JOIN inventory_days i ON i.room_type_id = rt.id AND i.date = ${day}::date
        WHERE rt.property_id = ${property.id} AND rt.active), 0)::int,
      (SELECT count(*) FROM reservation_rooms rr
        WHERE rr.property_id = ${property.id} AND rr.status IN ('in_house', 'checked_out', 'confirmed')
          AND rr.check_in <= ${day}::date AND rr.check_out > ${day}::date)::int,
      coalesce((SELECT sum(i.out_of_order) FROM inventory_days i
        JOIN room_types rt ON rt.id = i.room_type_id
        WHERE rt.property_id = ${property.id} AND i.date = ${day}::date), 0)::int,
      (SELECT count(*) FROM reservation_rooms rr
        WHERE rr.property_id = ${property.id} AND rr.checked_in_at IS NOT NULL
          AND (rr.checked_in_at AT TIME ZONE ${tz})::date = ${day}::date)::int,
      (SELECT count(*) FROM reservation_rooms rr
        WHERE rr.property_id = ${property.id} AND rr.checked_out_at IS NOT NULL
          AND (rr.checked_out_at AT TIME ZONE ${tz})::date = ${day}::date)::int,
      (SELECT count(*) FROM reservation_rooms rr
        WHERE rr.property_id = ${property.id} AND rr.status = 'no_show' AND rr.check_in = ${day}::date)::int,
      (SELECT count(*) FROM reservations r
        WHERE r.property_id = ${property.id} AND r.cancelled_at IS NOT NULL
          AND (r.cancelled_at AT TIME ZONE ${tz})::date = ${day}::date)::int,
      coalesce((SELECT sum(l.amount) FROM folio_lines l
        WHERE l.property_id = ${property.id} AND l.business_date = ${day}::date
          AND l.kind = 'room' AND l.voided_at IS NULL), 0),
      coalesce((SELECT sum(l.amount) FROM folio_lines l
        WHERE l.property_id = ${property.id} AND l.business_date = ${day}::date
          AND l.kind IN ('food', 'service', 'extra', 'fee', 'discount') AND l.voided_at IS NULL), 0),
      coalesce((SELECT sum(l.tax_amount) FROM folio_lines l
        WHERE l.property_id = ${property.id} AND l.business_date = ${day}::date AND l.voided_at IS NULL), 0),
      coalesce((SELECT -sum(l.amount) FROM folio_lines l
        WHERE l.property_id = ${property.id} AND l.business_date = ${day}::date
          AND l.kind IN ('payment', 'refund') AND l.voided_at IS NULL), 0),
      coalesce((SELECT jsonb_object_agg(channel, jsonb_build_object('rooms', rooms, 'revenue', revenue)) FROM (
        SELECT coalesce(r.channel_code, 'DIRECT') AS channel, count(*)::int AS rooms,
               coalesce(sum(n.amount), 0)::bigint AS revenue
        FROM reservation_rooms rr
        JOIN reservations r ON r.id = rr.reservation_id
        LEFT JOIN reservation_nights n ON n.reservation_room_id = rr.id AND n.date = ${day}::date
        WHERE rr.property_id = ${property.id} AND rr.status IN ('in_house', 'checked_out', 'confirmed')
          AND rr.check_in <= ${day}::date AND rr.check_out > ${day}::date
        GROUP BY 1) c), '{}'::jsonb)
    ON CONFLICT (property_id, date) DO UPDATE SET
      available_rooms = EXCLUDED.available_rooms, sold_rooms = EXCLUDED.sold_rooms,
      out_of_order = EXCLUDED.out_of_order, arrivals = EXCLUDED.arrivals,
      departures = EXCLUDED.departures, no_shows = EXCLUDED.no_shows,
      cancellations = EXCLUDED.cancellations, room_revenue = EXCLUDED.room_revenue,
      other_revenue = EXCLUDED.other_revenue, tax_amount = EXCLUDED.tax_amount,
      payments_received = EXCLUDED.payments_received, by_channel = EXCLUDED.by_channel
  `);
}

export interface NightAuditStatus {
  /** The hotel day in progress. */
  businessDate: DateString;
  /** Today by the calendar, at the property. */
  today: DateString;
  /** Days that have ended and are not yet closed. */
  daysBehind: number;
  /** Hour of the day (property time) at which it runs by itself, or null if that is off. */
  automaticAt: number | null;
  last: NightAuditRow | null;
}

function auditHour(property: PropertyRow): number | null {
  const hour = property.settings.nightAuditHour;
  return hour === null ? null : (hour ?? DEFAULT_AUDIT_HOUR);
}

export async function nightAuditStatus(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  now: Date = new Date(),
): Promise<NightAuditStatus> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const [last] = await db
    .select()
    .from(nightAudits)
    .where(eq(nightAudits.propertyId, propertyId))
    .orderBy(desc(nightAudits.businessDate), desc(nightAudits.completedAt))
    .limit(1);
  const businessDate = businessDateOf(property, now);
  const today = todayIn(property.timezone, now);
  return {
    businessDate,
    today,
    daysBehind: Math.max(
      0,
      Math.round(
        (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${businessDate}T00:00:00Z`)) / 86_400_000,
      ),
    ),
    automaticAt: auditHour(property),
    last: last ?? null,
  };
}

export async function listNightAudits(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  limit = 30,
): Promise<NightAuditRow[]> {
  const rows = await db
    .select({ audit: nightAudits })
    .from(nightAudits)
    .innerJoin(properties, eq(properties.id, nightAudits.propertyId))
    .where(and(eq(nightAudits.propertyId, propertyId), eq(properties.orgId, orgId)))
    .orderBy(desc(nightAudits.businessDate), desc(nightAudits.completedAt))
    .limit(Math.min(limit, 400));
  return rows.map((r) => r.audit);
}

/**
 * Runs the night audit wherever it is due: the hotel day has ended by the
 * calendar and the property's audit hour has come. A property that has
 * fallen several days behind is brought up to date one day at a time.
 *
 * Called by the worker every few minutes. A property with no hotel day yet
 * is given today's, so its first audit happens tonight.
 */
export async function runDueNightAudits(
  db: Database,
  actorFor: (orgId: string) => Actor,
  now: Date = new Date(),
): Promise<{ propertyId: string; businessDate: DateString; ok: boolean; error?: string }[]> {
  const all = await db.select().from(properties).where(eq(properties.active, true));
  const results: { propertyId: string; businessDate: DateString; ok: boolean; error?: string }[] =
    [];
  for (const property of all) {
    const hour = auditHour(property);
    const today = todayIn(property.timezone, now);
    if (property.businessDate === null) {
      await db
        .update(properties)
        .set({ businessDate: today })
        .where(and(eq(properties.id, property.id), sql`${properties.businessDate} IS NULL`));
      continue;
    }
    if (hour === null) continue;
    let day = property.businessDate;
    // Yesterday is closed once today's audit hour has come; anything older is overdue already.
    for (let guard = 0; guard < 31 && day < today; guard++) {
      const isYesterday = addDays(day, 1) === today;
      if (isYesterday && timeIn(property.timezone, now).hour < hour) break;
      const actor = actorFor(property.orgId);
      try {
        await runNightAudit(db, actor, property.id, now);
        results.push({ propertyId: property.id, businessDate: day, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ propertyId: property.id, businessDate: day, ok: false, error: message });
        await raiseAlert(db, {
          orgId: property.orgId,
          propertyId: property.id,
          kind: 'night_audit',
          severity: 'critical',
          title: `${property.name}: the night audit for ${day} failed`,
          body: `${message}\n\nRoom charges for that night have not been posted and the hotel day has not moved on. It will be tried again; it can also be run by hand from the night audit screen.`,
          dedupeKey: `night_audit_failed:${property.id}`,
        });
        break;
      }
      day = addDays(day, 1);
    }
  }
  return results;
}
