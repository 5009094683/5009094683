import { and, eq, sql } from 'drizzle-orm';
import { properties, type Database, type DbOrTx } from '@pms/db';
import {
  addDays,
  businessDateOf,
  eachDate,
  notFound,
  raiseAlert,
  todayIn,
  updateReservationRoom,
  uuidArray,
  type Actor,
  type DateString,
} from '@pms/domain';

// ---------------------------------------------------------------------------
// Risk that a booking is cancelled or the guest does not arrive

export interface ReservationRisk {
  reservationId: string;
  /** 1 to 95: how likely the booking is to be cancelled, and how likely the guest is not to turn up. */
  cancellation: number;
  noShow: number;
  level: 'low' | 'medium' | 'high';
  /** The reasons, most telling first, in words. */
  factors: string[];
}

interface RiskRow extends Record<string, unknown> {
  id: string;
  source: string;
  channel_code: string | null;
  payment_collect: string;
  lead_days: number;
  nights: number;
  non_refundable: boolean;
  total_amount: string;
  paid: string | null;
  has_email: boolean;
  has_phone: boolean;
  past_stays: number;
  past_cancellations: number;
  past_no_shows: number;
  online_checkin: boolean;
  days_to_arrival: number;
}

/** The weights behind a score, as a pure function, so it can be read and tested on its own. */
export function scoreRisk(row: {
  source: string;
  paymentCollect: string;
  leadDays: number;
  nights: number;
  nonRefundable: boolean;
  totalAmount: number;
  paid: number;
  hasContact: boolean;
  pastStays: number;
  pastCancellations: number;
  pastNoShows: number;
  onlineCheckin: boolean;
  daysToArrival: number;
}): Omit<ReservationRisk, 'reservationId'> {
  let cancellation = 12;
  let noShow = 5;
  const factors: [weight: number, text: string][] = [];
  const add = (cancel: number, absent: number, text: string): void => {
    cancellation += cancel;
    noShow += absent;
    if (cancel !== 0 || absent !== 0) factors.push([Math.abs(cancel) + Math.abs(absent), text]);
  };

  const prepaidByChannel = row.source === 'ota' && row.paymentCollect === 'channel';
  const paidShare = row.totalAmount > 0 ? row.paid / row.totalAmount : 0;
  if (row.nonRefundable) add(-10, -3, 'Non-refundable rate');
  if (paidShare >= 0.95 || prepaidByChannel) add(-12, -4, 'Paid in full');
  else if (paidShare >= 0.2) add(-6, -2, 'Deposit paid');
  else if (row.source === 'ota') add(14, 8, 'Booked on a booking site with nothing paid');
  else add(6, 5, 'Nothing paid yet');

  if (row.leadDays > 60) add(14, 0, 'Booked more than two months ahead');
  else if (row.leadDays > 21) add(8, 0, 'Booked several weeks ahead');
  else if (row.leadDays <= 1) add(-4, 6, 'Booked at the last minute');

  if (row.pastNoShows > 0) add(8, 25, 'This guest did not arrive for an earlier booking');
  if (row.pastCancellations >= 2) add(12, 3, 'This guest has cancelled before');
  if (row.pastStays > 0) add(-8, -3, 'Returning guest');
  if (!row.hasContact) add(3, 10, 'No phone number or email address');
  if (row.nights >= 7) add(5, 0, 'Long stay');
  if (row.onlineCheckin) add(-15, -20, 'Checked in online');
  // A booking still standing on the eve of arrival is far less likely to be cancelled than one made months out.
  if (row.daysToArrival < 0) add(0, 20, 'Was due earlier and has not arrived');
  else if (row.daysToArrival <= 1) add(-8, 0, 'Arriving within a day');

  const clamp = (n: number): number => Math.min(95, Math.max(1, Math.round(n)));
  const worst = Math.max(clamp(cancellation), clamp(noShow));
  return {
    cancellation: clamp(cancellation),
    noShow: clamp(noShow),
    level: worst >= 45 ? 'high' : worst >= 25 ? 'medium' : 'low',
    factors: factors.sort((a, b) => b[0] - a[0]).map(([, text]) => text),
  };
}

/** Scores upcoming reservations. Rule-based: it needs no history and no language model. */
export async function reservationRisks(
  db: DbOrTx,
  orgId: string,
  reservationIds: string[],
): Promise<ReservationRisk[]> {
  if (reservationIds.length === 0) return [];
  const { rows } = await db.execute<RiskRow>(sql`
    SELECT r.id, r.source, r.channel_code, r.payment_collect,
      greatest(0, r.check_in - (r.created_at AT TIME ZONE p.timezone)::date)::int AS lead_days,
      (r.check_out - r.check_in)::int AS nights,
      EXISTS (SELECT 1 FROM reservation_rooms rr JOIN rate_plans rp ON rp.id = rr.rate_plan_id
              WHERE rr.reservation_id = r.id AND (rp.cancellation_policy->>'nonRefundable')::boolean) AS non_refundable,
      r.total_amount::text,
      (SELECT (-sum(l.amount))::text FROM folio_lines l JOIN folios f ON f.id = l.folio_id
        WHERE f.reservation_id = r.id AND l.voided_at IS NULL AND l.kind IN ('payment', 'refund')) AS paid,
      (g.email IS NOT NULL) AS has_email, (g.phone IS NOT NULL) AS has_phone,
      (SELECT count(*) FROM reservations o WHERE o.guest_id = r.guest_id AND o.id <> r.id AND o.status = 'checked_out')::int AS past_stays,
      (SELECT count(*) FROM reservations o WHERE o.guest_id = r.guest_id AND o.id <> r.id AND o.status = 'cancelled'
          AND o.cancellation_reason IS DISTINCT FROM 'Hold expired before the booking was completed')::int AS past_cancellations,
      (SELECT count(*) FROM reservations o WHERE o.guest_id = r.guest_id AND o.id <> r.id AND o.status = 'no_show')::int AS past_no_shows,
      (r.online_checkin_at IS NOT NULL) AS online_checkin,
      (r.check_in - (now() AT TIME ZONE p.timezone)::date)::int AS days_to_arrival
    FROM reservations r
    JOIN properties p ON p.id = r.property_id
    LEFT JOIN guests g ON g.id = r.guest_id
    WHERE r.org_id = ${orgId} AND r.id = ANY(${uuidArray(reservationIds)})
  `);
  return rows.map((r) => ({
    reservationId: r.id,
    ...scoreRisk({
      source: r.source,
      paymentCollect: r.payment_collect,
      leadDays: r.lead_days,
      nights: r.nights,
      nonRefundable: r.non_refundable,
      totalAmount: Number(r.total_amount),
      paid: Number(r.paid ?? 0),
      hasContact: r.has_email || r.has_phone,
      pastStays: r.past_stays,
      pastCancellations: r.past_cancellations,
      pastNoShows: r.past_no_shows,
      onlineCheckin: r.online_checkin,
      daysToArrival: r.days_to_arrival,
    }),
  }));
}

/** Upcoming arrivals at a property with their risk, riskiest first. */
export async function arrivalsAtRisk(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  options: { days?: number; now?: Date } = {},
): Promise<
  (ReservationRisk & {
    code: string;
    guestName: string;
    checkIn: DateString;
    checkOut: DateString;
    source: string;
  })[]
> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const today = todayIn(property.timezone, options.now);
  const { rows } = await db.execute<{
    id: string;
    code: string;
    guest_name: string;
    check_in: string;
    check_out: string;
    source: string;
  }>(sql`
    SELECT id, code, guest_name, check_in::text, check_out::text, coalesce(channel_code, source) AS source
    FROM reservations
    WHERE property_id = ${propertyId} AND status = 'confirmed'
      -- Also those due earlier who may still come: the front desk lists them as arrivals too.
      AND check_out > ${businessDateOf(property, options.now)}::date
      AND check_in < ${addDays(today, options.days ?? 14)}::date
    ORDER BY check_in LIMIT 500
  `);
  const risks = await reservationRisks(
    db,
    orgId,
    rows.map((r) => r.id),
  );
  const byId = new Map(risks.map((r) => [r.reservationId, r]));
  return rows
    .map((r) => ({
      ...byId.get(r.id)!,
      code: r.code,
      guestName: r.guest_name,
      checkIn: r.check_in,
      checkOut: r.check_out,
      source: r.source,
    }))
    .sort((a, b) => Math.max(b.cancellation, b.noShow) - Math.max(a.cancellation, a.noShow));
}

// ---------------------------------------------------------------------------
// Room assignment that leaves the fewest gaps

interface Stay {
  roomId: string;
  reservationId: string;
  code: string;
  guestName: string;
  checkIn: DateString;
  checkOut: DateString;
}

export interface Assignment extends Stay {
  unitId: string;
  unitName: string;
  /** Empty nights left between this stay and the one before it in the same room. */
  gapBefore: number | null;
}

export interface AssignmentPlan {
  roomTypeId: string;
  roomTypeName: string;
  assignments: Assignment[];
  /** Stays no room can take without moving someone already placed. */
  unplaced: Stay[];
}

const days = (from: DateString, to: DateString): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Places stays that have no room yet into rooms, as a pure function. Stays
 * are taken in order of arrival; each goes to the free room whose last guest
 * left closest before it, so short gaps that nobody can book are avoided and
 * long free runs are kept whole for longer stays.
 */
export function planAssignments(
  units: { id: string; name: string }[],
  taken: { unitId: string; from: DateString; to: DateString }[],
  stays: Stay[],
): { assignments: Assignment[]; unplaced: Stay[] } {
  const busy = new Map<string, { from: DateString; to: DateString }[]>(
    units.map((u) => [u.id, taken.filter((t) => t.unitId === u.id)]),
  );
  const assignments: Assignment[] = [];
  const unplaced: Stay[] = [];
  const ordered = [...stays].sort(
    (a, b) =>
      a.checkIn.localeCompare(b.checkIn) ||
      days(b.checkIn, b.checkOut) - days(a.checkIn, a.checkOut) ||
      a.code.localeCompare(b.code),
  );
  for (const stay of ordered) {
    let best: {
      unit: { id: string; name: string };
      gap: number | null;
      after: number | null;
    } | null = null;
    for (const unit of units) {
      const spans = busy.get(unit.id)!;
      if (spans.some((s) => s.from < stay.checkOut && s.to > stay.checkIn)) continue;
      const before = spans
        .filter((s) => s.to <= stay.checkIn)
        .map((s) => s.to)
        .sort()
        .pop();
      const next = spans
        .filter((s) => s.from >= stay.checkOut)
        .map((s) => s.from)
        .sort()[0];
      const gap = before ? days(before, stay.checkIn) : null;
      const after = next ? days(stay.checkOut, next) : null;
      // Back to back with the previous guest is best; a room nobody has used yet is kept for last.
      const rank = (g: number | null): number => (g === null ? 10_000 : g);
      if (
        !best ||
        rank(gap) < rank(best.gap) ||
        (rank(gap) === rank(best.gap) && rank(after) < rank(best.after))
      ) {
        best = { unit, gap, after };
      }
    }
    if (!best) {
      unplaced.push(stay);
      continue;
    }
    busy.get(best.unit.id)!.push({ from: stay.checkIn, to: stay.checkOut });
    assignments.push({
      ...stay,
      unitId: best.unit.id,
      unitName: best.unit.name,
      gapBefore: best.gap,
    });
  }
  return { assignments, unplaced };
}

/** Suggests rooms for upcoming stays that have none, for the room types that leave the choice until check-in. */
export async function suggestAssignments(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  options: { days?: number; now?: Date } = {},
): Promise<AssignmentPlan[]> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const today = todayIn(property.timezone, options.now);
  const until = addDays(today, options.days ?? 30);
  const { rows: types } = await db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM room_types
    WHERE property_id = ${propertyId} AND active AND assignment = 'at_check_in' ORDER BY sort_order, name
  `);
  const plans: AssignmentPlan[] = [];
  for (const type of types) {
    const { rows: stays } = await db.execute<{
      room_id: string;
      reservation_id: string;
      code: string;
      guest_name: string;
      check_in: string;
      check_out: string;
    }>(sql`
      SELECT rr.id AS room_id, r.id AS reservation_id, r.code, r.guest_name, rr.check_in::text, rr.check_out::text
      FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id
      WHERE rr.room_type_id = ${type.id} AND rr.status = 'confirmed' AND rr.unit_id IS NULL
        AND rr.check_in >= ${today}::date AND rr.check_in < ${until}::date
    `);
    if (stays.length === 0) continue;
    const { rows: units } = await db.execute<{ id: string; name: string }>(sql`
      SELECT id, name FROM units
      WHERE room_type_id = ${type.id} AND active AND housekeeping_status <> 'out_of_service'
      ORDER BY sort_order, name
    `);
    // Everything already holding a room: guests with a room, and blocks.
    const { rows: taken } = await db.execute<{ unit_id: string; from: string; to: string }>(sql`
      SELECT unit_id, lower(stay)::text AS "from", upper(stay)::text AS "to"
      FROM unit_occupancy
      WHERE unit_id = ANY(${uuidArray(units.map((u) => u.id))}) AND upper(stay) > ${today}::date
    `);
    const plan = planAssignments(
      units,
      taken.map((t) => ({ unitId: t.unit_id, from: t.from, to: t.to })),
      stays.map((s) => ({
        roomId: s.room_id,
        reservationId: s.reservation_id,
        code: s.code,
        guestName: s.guest_name,
        checkIn: s.check_in,
        checkOut: s.check_out,
      })),
    );
    plans.push({ roomTypeId: type.id, roomTypeName: type.name, ...plan });
  }
  return plans;
}

/** Gives the suggested rooms. Each one goes through the same checks as assigning a room by hand. */
export async function applyAssignments(
  db: Database,
  actor: Actor,
  assignments: { reservationId: string; roomId: string; unitId: string }[],
): Promise<{ applied: number; failed: { roomId: string; reason: string }[] }> {
  let applied = 0;
  const failed: { roomId: string; reason: string }[] = [];
  for (const a of assignments) {
    try {
      await updateReservationRoom(db, actor, a.reservationId, a.roomId, { unitId: a.unitId });
      applied++;
    } catch (err) {
      // One room taken in the meantime must not undo the rest.
      failed.push({ roomId: a.roomId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, failed };
}

// ---------------------------------------------------------------------------
// Housekeeping load

export interface HousekeepingDay {
  date: DateString;
  departures: number;
  stayovers: number;
  arrivals: number;
  minutes: number;
  /** Housekeepers needed, at seven working hours each. */
  staff: number;
}

/** The cleaning work ahead, day by day, from who leaves and who stays. */
export async function housekeepingForecast(
  db: DbOrTx,
  orgId: string,
  propertyId: string,
  options: { days?: number; now?: Date } = {},
): Promise<{ days: HousekeepingDay[]; busiest: DateString | null }> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
  const today = todayIn(property.timezone, options.now);
  const until = addDays(today, options.days ?? 7);
  const { rows } = await db.execute<{ check_in: string; check_out: string }>(sql`
    SELECT check_in::text, check_out::text FROM reservation_rooms
    WHERE property_id = ${propertyId} AND status IN ('confirmed', 'in_house')
      AND check_in < ${until}::date AND check_out >= ${today}::date
  `);
  const departureMinutes = property.settings.departureCleanMinutes ?? 45;
  const stayoverMinutes = property.settings.stayoverCleanMinutes ?? 20;
  const out = eachDate(today, until).map((date) => {
    const departures = rows.filter((r) => r.check_out === date).length;
    const stayovers = rows.filter((r) => r.check_in < date && r.check_out > date).length;
    const arrivals = rows.filter((r) => r.check_in === date).length;
    const minutes = departures * departureMinutes + stayovers * stayoverMinutes;
    return { date, departures, stayovers, arrivals, minutes, staff: Math.ceil(minutes / 420) };
  });
  const peak = out.reduce<HousekeepingDay | null>(
    (max, d) => (d.minutes > (max?.minutes ?? 0) ? d : max),
    null,
  );
  return { days: out, busiest: peak?.date ?? null };
}

// ---------------------------------------------------------------------------
// Unusual cancellations

/**
 * Raises an alert when a property loses far more bookings in a day than it
 * normally does: a rate or content mistake on a booking site, a bad review,
 * or a local event are the usual causes, and the sooner someone looks the
 * better. Run by the worker.
 */
export async function detectUnusualCancellations(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await db.execute<{
    org_id: string;
    property_id: string;
    name: string;
    recent: number;
    usual: number;
    channels: string | null;
  }>(sql`
    WITH c AS (
      SELECT r.property_id, r.cancelled_at, coalesce(r.channel_code, r.source) AS channel
      FROM reservations r
      WHERE r.status = 'cancelled' AND r.cancelled_at > ${now.toISOString()}::timestamptz - interval '29 days'
        AND r.cancellation_reason IS DISTINCT FROM 'Hold expired before the booking was completed'
        AND r.cancellation_reason IS DISTINCT FROM 'The payment page could not be opened'
    )
    SELECT p.org_id, p.id AS property_id, p.name,
      count(*) FILTER (WHERE c.cancelled_at > ${now.toISOString()}::timestamptz - interval '24 hours')::int AS recent,
      (count(*) FILTER (WHERE c.cancelled_at <= ${now.toISOString()}::timestamptz - interval '24 hours'))::float / 28 AS usual,
      string_agg(DISTINCT c.channel, ', ') FILTER (WHERE c.cancelled_at > ${now.toISOString()}::timestamptz - interval '24 hours') AS channels
    FROM c JOIN properties p ON p.id = c.property_id
    GROUP BY p.org_id, p.id, p.name
  `);
  let raised = 0;
  for (const row of rows) {
    // At least four in a day, and at least three times the usual number.
    if (row.recent < 4 || row.recent < Math.max(1, row.usual) * 3) continue;
    const day = now.toISOString().slice(0, 10);
    const { created } = await raiseAlert(db, {
      orgId: row.org_id,
      propertyId: row.property_id,
      kind: 'unusual_cancellations',
      severity: 'warning',
      title: `${row.name}: ${row.recent} cancellations in the last 24 hours`,
      body: `That is well above the usual ${row.usual < 1 ? 'less than one' : Math.round(row.usual * 10) / 10} a day. They came from: ${row.channels ?? 'unknown'}. Check the rates and restrictions on those channels, recent reviews, and whether something local explains it.`,
      dedupeKey: `unusual_cancellations:${row.property_id}:${day}`,
      metadata: { recent: row.recent, usualPerDay: row.usual },
    });
    if (created) raised++;
  }
  return raised;
}
