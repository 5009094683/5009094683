import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { properties, type DbOrTx, type PaymentMethod, type ReservationSource } from '@pms/db';
import { addDays, assertRange, dayOfWeek, diffDays, type DateString } from './dates';
import { validationError } from './errors';
import { SILENT_CANCELLATIONS } from './messaging';
import { uuidArray } from './sqlx';

/**
 * Management reports. Everything is worked out from the reservations and the
 * folios as they stand, so a report can be asked for any day, past or future,
 * and always agrees with the calendar and the bills.
 *
 * A room night counts as sold when its reservation is confirmed, in house or
 * checked out. Tentative holds, cancellations and no-shows do not count.
 * Revenue is room revenue before tax, in minor units.
 */

/** The longest period one report covers: a little over two years, enough for a year against the year before. */
const MAX_REPORT_DAYS = 800;

export interface ReportWindow {
  /** The properties the reader may see, already narrowed to those asked for. */
  propertyIds: 'all' | string[];
  from: DateString;
  /** Exclusive. */
  to: DateString;
}

interface Scope {
  ids: string[];
  currency: string | null;
  names: Map<string, string>;
}

/** The properties a report covers. Amounts are only ever added up within one currency. */
async function scopeOf(db: DbOrTx, orgId: string, propertyIds: 'all' | string[]): Promise<Scope> {
  const rows = await db
    .select({ id: properties.id, name: properties.name, currency: properties.currency })
    .from(properties)
    .where(
      and(
        eq(properties.orgId, orgId),
        propertyIds === 'all'
          ? undefined
          : propertyIds.length > 0
            ? inArray(properties.id, propertyIds)
            : sql`false`,
      ),
    )
    .orderBy(properties.name);
  const currencies = [...new Set(rows.map((r) => r.currency))];
  if (currencies.length > 1) {
    throw validationError(
      `These properties are priced in different currencies (${currencies.join(', ')}). Choose properties that share one.`,
      { reason: 'mixed_currencies', currencies },
    );
  }
  return {
    ids: rows.map((r) => r.id),
    currency: currencies[0] ?? null,
    names: new Map(rows.map((r) => [r.id, r.name])),
  };
}

function windowOf(from: string, to: string): { from: DateString; to: DateString } {
  const range = assertRange(from, to, 'report period');
  if (diffDays(range.from, range.to) > MAX_REPORT_DAYS) {
    throw validationError(`A report covers at most ${MAX_REPORT_DAYS} days`);
  }
  return range;
}

const SOLD: SQL = sql`('confirmed', 'in_house', 'checked_out')`;

const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round(part / whole) : null;
const shareBp = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part * 10_000) / whole) : null;

/** The Monday on or before a date. */
function weekStart(date: DateString): DateString {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

// ---------------------------------------------------------------------------
// Occupancy, average rate, revenue per available room

export const PERFORMANCE_GROUPINGS = ['day', 'week', 'month', 'property', 'room_type'] as const;
export type PerformanceGrouping = (typeof PERFORMANCE_GROUPINGS)[number];

export interface PerformanceRow {
  key: string;
  label: string;
  /** Room nights that could be sold: the rooms there are, less those out of order. */
  available: number;
  sold: number;
  /** Share of the available room nights that were sold, in basis points: 7,550 is 75.5%. */
  occupancyBp: number | null;
  roomRevenue: number;
  /** Average daily rate: room revenue for each room night sold. */
  adr: number | null;
  /** Room revenue for each room night that could have been sold. */
  revpar: number | null;
}

export interface PerformanceReport {
  from: DateString;
  to: DateString;
  groupBy: PerformanceGrouping;
  /** Null when no property is in scope. */
  currency: string | null;
  rows: PerformanceRow[];
  total: PerformanceRow;
}

interface NightCell {
  propertyId: string;
  roomTypeId: string;
  roomTypeName: string;
  date: DateString;
  available: number;
  sold: number;
  revenue: number;
}

/** Capacity, room nights sold and room revenue for every room type on every date of the window. */
async function nightCells(
  db: DbOrTx,
  scope: Scope,
  from: DateString,
  to: DateString,
  /** Count what was on the books at this moment instead of now. */
  asOf?: Date,
): Promise<NightCell[]> {
  if (scope.ids.length === 0) return [];
  const props = uuidArray(scope.ids);
  const onBooks = asOf ? onBooksAt(asOf) : sql`rr.status IN ${SOLD}`;
  const { rows } = await db.execute<{
    property_id: string;
    room_type_id: string;
    name: string;
    date: string;
    available: number;
    sold: number;
    revenue: string;
  }>(sql`
    WITH days AS (
      SELECT d::date AS date FROM generate_series(${from}::date, ${to}::date - 1, interval '1 day') d
    ),
    types AS (
      SELECT rt.id, rt.property_id, rt.name, rt.active,
        (SELECT count(*) FROM units u WHERE u.room_type_id = rt.id AND u.active)::int AS units
      FROM room_types rt WHERE rt.property_id = ANY(${props})
    ),
    sold AS (
      SELECT rr.room_type_id, n.date, count(*)::int AS sold, sum(n.amount)::bigint AS revenue
      FROM reservation_nights n
      JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
      JOIN reservations r ON r.id = rr.reservation_id
      WHERE rr.property_id = ANY(${props}) AND n.date >= ${from}::date AND n.date < ${to}::date
        AND ${onBooks}
      GROUP BY rr.room_type_id, n.date
    )
    SELECT t.property_id, t.id AS room_type_id, t.name, d.date::text AS date,
      -- A room closed for repair, or taken by the other side of a linked villa, could not have been sold.
      greatest(0, coalesce(i.total, CASE WHEN t.active THEN t.units ELSE 0 END)
                  - coalesce(i.out_of_order, 0) - coalesce(i.linked, 0))::int AS available,
      coalesce(s.sold, 0)::int AS sold, coalesce(s.revenue, 0)::text AS revenue
    FROM types t
    CROSS JOIN days d
    LEFT JOIN inventory_days i ON i.room_type_id = t.id AND i.date = d.date
    LEFT JOIN sold s ON s.room_type_id = t.id AND s.date = d.date
    WHERE t.active OR s.sold IS NOT NULL
  `);
  return rows.map((r) => ({
    propertyId: r.property_id,
    roomTypeId: r.room_type_id,
    roomTypeName: r.name,
    date: r.date,
    available: r.available,
    sold: r.sold,
    revenue: Number(r.revenue),
  }));
}

/**
 * Whether a room was on the books at a moment in the past. A booking made
 * later was not; one cancelled later still was. Changes of dates are not
 * kept, so a stay moved since then is counted on its present dates.
 */
function onBooksAt(moment: Date): SQL {
  const t = sql`${moment.toISOString()}::timestamptz`;
  return sql`(
    r.created_at <= ${t} AND rr.created_at <= ${t} AND rr.status <> 'tentative'
    AND NOT (rr.status = 'cancelled' AND coalesce(r.cancelled_at, rr.updated_at) <= ${t})
    AND NOT (rr.status = 'no_show' AND rr.check_in <= (${t} AT TIME ZONE 'UTC')::date)
    AND NOT (r.cancellation_reason IS NOT NULL AND r.cancellation_reason IN (${sql.join(
      SILENT_CANCELLATIONS.map((reason) => sql`${reason}`),
      sql`, `,
    )}))
  )`;
}

function performanceRow(key: string, label: string, cells: NightCell[]): PerformanceRow {
  const available = cells.reduce((sum, c) => sum + c.available, 0);
  const sold = cells.reduce((sum, c) => sum + c.sold, 0);
  const roomRevenue = cells.reduce((sum, c) => sum + c.revenue, 0);
  return {
    key,
    label,
    available,
    sold,
    occupancyBp: shareBp(sold, available),
    roomRevenue,
    adr: ratio(roomRevenue, sold),
    revpar: ratio(roomRevenue, available),
  };
}

/** How full the rooms were, at what average rate, and what each available room earned. */
export async function performanceReport(
  db: DbOrTx,
  orgId: string,
  input: ReportWindow & { groupBy?: PerformanceGrouping },
): Promise<PerformanceReport> {
  const { from, to } = windowOf(input.from, input.to);
  const groupBy = input.groupBy ?? 'day';
  const scope = await scopeOf(db, orgId, input.propertyIds);
  const cells = await nightCells(db, scope, from, to);

  const keyOf = (cell: NightCell): [key: string, label: string] => {
    switch (groupBy) {
      case 'day':
        return [cell.date, cell.date];
      case 'week': {
        const start = weekStart(cell.date);
        return [start, `Week of ${start}`];
      }
      case 'month':
        return [cell.date.slice(0, 7), cell.date.slice(0, 7)];
      case 'property':
        return [cell.propertyId, scope.names.get(cell.propertyId) ?? ''];
      case 'room_type':
        return [
          cell.roomTypeId,
          scope.ids.length > 1
            ? `${scope.names.get(cell.propertyId) ?? ''}: ${cell.roomTypeName}`
            : cell.roomTypeName,
        ];
    }
  };
  const groups = new Map<string, { label: string; cells: NightCell[] }>();
  for (const cell of cells) {
    const [key, label] = keyOf(cell);
    const group = groups.get(key) ?? { label, cells: [] };
    group.cells.push(cell);
    groups.set(key, group);
  }
  const rows = [...groups].map(([key, group]) => performanceRow(key, group.label, group.cells));
  const byTime = groupBy === 'day' || groupBy === 'week' || groupBy === 'month';
  rows.sort((a, b) => (byTime ? a.key.localeCompare(b.key) : a.label.localeCompare(b.label)));
  return {
    from,
    to,
    groupBy,
    currency: scope.currency,
    rows,
    total: performanceRow('total', 'Total', cells),
  };
}

// ---------------------------------------------------------------------------
// Where the business came from, and what it cost

export interface ChannelMixRow {
  /** A booking site's code (BDC, ABB), or how the booking came when not through a site (website, phone). */
  key: string;
  channelCode: string | null;
  source: ReservationSource | null;
  reservations: number;
  roomNights: number;
  roomRevenue: number;
  /** What the booking site or travel agent keeps, for the nights in the period. */
  commission: number;
  netRevenue: number;
  adr: number | null;
  /** This row's part of all room revenue in the period, in basis points. */
  revenueShareBp: number | null;
  /** Days between booking and arrival, on average. */
  avgLeadDays: number | null;
  avgNights: number | null;
  /** Of the bookings due to arrive in the period, the share that was cancelled, in basis points. */
  cancellationBp: number | null;
}

export interface ChannelMixReport {
  from: DateString;
  to: DateString;
  currency: string | null;
  rows: ChannelMixRow[];
  total: Omit<ChannelMixRow, 'key' | 'channelCode' | 'source'>;
}

/** Room nights, revenue and commission by booking site and by other source, for stays in the period. */
export async function channelMixReport(
  db: DbOrTx,
  orgId: string,
  input: ReportWindow,
): Promise<ChannelMixReport> {
  const { from, to } = windowOf(input.from, input.to);
  const scope = await scopeOf(db, orgId, input.propertyIds);
  const empty = {
    reservations: 0,
    roomNights: 0,
    roomRevenue: 0,
    commission: 0,
    netRevenue: 0,
    adr: null,
    revenueShareBp: null,
    avgLeadDays: null,
    avgNights: null,
    cancellationBp: null,
  };
  if (scope.ids.length === 0) return { from, to, currency: null, rows: [], total: empty };
  const props = uuidArray(scope.ids);

  const { rows: stays } = await db.execute<{
    key: string;
    channel_code: string | null;
    source: ReservationSource;
    reservations: number;
    nights: number;
    revenue: string;
    commission: string;
    lead_days: string | null;
    los: string | null;
  }>(sql`
    WITH per_booking AS (
      SELECT r.id, r.channel_code, r.source, r.total_amount, r.commission_amount,
        c.kind AS company_kind, c.commission_bp,
        count(*)::int AS nights, sum(n.amount)::bigint AS revenue,
        greatest(0, r.check_in - (r.created_at AT TIME ZONE p.timezone)::date) AS lead_days,
        (r.check_out - r.check_in) AS los
      FROM reservation_nights n
      JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
      JOIN reservations r ON r.id = rr.reservation_id
      JOIN properties p ON p.id = r.property_id
      LEFT JOIN companies c ON c.id = r.company_id
      WHERE rr.property_id = ANY(${props}) AND n.date >= ${from}::date AND n.date < ${to}::date
        AND rr.status IN ${SOLD}
      GROUP BY r.id, c.kind, c.commission_bp, p.timezone
    )
    SELECT coalesce(channel_code, source) AS key, max(channel_code) AS channel_code, max(source) AS source,
      count(*)::int AS reservations, sum(nights)::int AS nights, sum(revenue)::text AS revenue,
      -- A booking site's commission is spread over the stay; a travel agent's is its agreed share.
      sum(CASE
        WHEN commission_amount > 0 AND total_amount > 0
          THEN least(commission_amount, round(commission_amount::numeric * revenue / total_amount))
        WHEN company_kind = 'travel_agent' THEN round(revenue::numeric * commission_bp / 10000)
        ELSE 0 END)::text AS commission,
      avg(lead_days)::text AS lead_days, avg(los)::text AS los
    FROM per_booking
    GROUP BY coalesce(channel_code, source)
  `);
  const { rows: arrivals } = await db.execute<{
    key: string;
    is_channel: boolean;
    cancelled: number;
    total: number;
  }>(
    sql`
      SELECT coalesce(channel_code, source) AS key, bool_or(channel_code IS NOT NULL) AS is_channel,
        count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled, count(*)::int AS total
      FROM reservations
      WHERE property_id = ANY(${props}) AND check_in >= ${from}::date AND check_in < ${to}::date
        AND status <> 'tentative'
        -- A hold that lapsed before the guest paid was never a booking.
        AND (cancellation_reason IS NULL OR cancellation_reason NOT IN (${sql.join(
          SILENT_CANCELLATIONS.map((reason) => sql`${reason}`),
          sql`, `,
        )}))
      GROUP BY 1
    `,
  );
  const cancelled = new Map(arrivals.map((a) => [a.key, a]));
  const totalRevenue = stays.reduce((sum, s) => sum + Number(s.revenue), 0);
  const round1 = (value: string | null): number | null =>
    value === null ? null : Math.round(Number(value) * 10) / 10;

  const rows: ChannelMixRow[] = stays
    .map((s) => {
      const roomRevenue = Number(s.revenue);
      const commission = Number(s.commission);
      const arriving = cancelled.get(s.key);
      return {
        key: s.key,
        channelCode: s.channel_code,
        source: s.channel_code ? null : s.source,
        reservations: s.reservations,
        roomNights: s.nights,
        roomRevenue,
        commission,
        netRevenue: roomRevenue - commission,
        adr: ratio(roomRevenue, s.nights),
        revenueShareBp: shareBp(roomRevenue, totalRevenue),
        avgLeadDays: round1(s.lead_days),
        avgNights: round1(s.los),
        cancellationBp: arriving ? shareBp(arriving.cancelled, arriving.total) : null,
      };
    })
    .sort((a, b) => b.roomRevenue - a.roomRevenue || a.key.localeCompare(b.key));
  // A source whose every booking for these dates was cancelled sold nothing, but it is
  // where those cancellations came from: without its line the total could not be added up
  // from the lines, and the worst source of all would be the one not shown.
  const withStays = new Set(rows.map((r) => r.key));
  for (const arriving of arrivals) {
    if (withStays.has(arriving.key) || arriving.cancelled === 0) continue;
    rows.push({
      key: arriving.key,
      channelCode: arriving.is_channel ? arriving.key : null,
      source: arriving.is_channel ? null : (arriving.key as ReservationSource),
      reservations: 0,
      roomNights: 0,
      roomRevenue: 0,
      commission: 0,
      netRevenue: 0,
      adr: null,
      revenueShareBp: shareBp(0, totalRevenue),
      avgLeadDays: null,
      avgNights: null,
      cancellationBp: shareBp(arriving.cancelled, arriving.total),
    });
  }

  const reservationsTotal = rows.reduce((sum, r) => sum + r.reservations, 0);
  const nightsTotal = rows.reduce((sum, r) => sum + r.roomNights, 0);
  const commissionTotal = rows.reduce((sum, r) => sum + r.commission, 0);
  const weighted = (pick: (r: ChannelMixRow) => number | null): number | null => {
    const known = rows.filter((r) => pick(r) !== null);
    const weight = known.reduce((sum, r) => sum + r.reservations, 0);
    return weight > 0
      ? Math.round((known.reduce((sum, r) => sum + pick(r)! * r.reservations, 0) / weight) * 10) /
          10
      : null;
  };
  const allCancelled = arrivals.reduce((sum, a) => sum + a.cancelled, 0);
  const allArriving = arrivals.reduce((sum, a) => sum + a.total, 0);
  return {
    from,
    to,
    currency: scope.currency,
    rows,
    total: {
      reservations: reservationsTotal,
      roomNights: nightsTotal,
      roomRevenue: totalRevenue,
      commission: commissionTotal,
      netRevenue: totalRevenue - commissionTotal,
      adr: ratio(totalRevenue, nightsTotal),
      revenueShareBp: totalRevenue > 0 ? 10_000 : null,
      avgLeadDays: weighted((r) => r.avgLeadDays),
      avgNights: weighted((r) => r.avgNights),
      cancellationBp: shareBp(allCancelled, allArriving),
    },
  };
}

// ---------------------------------------------------------------------------
// Pace: how future dates are filling

export interface PaceRow {
  /** A stay date, or a month (YYYY-MM). */
  period: string;
  available: number;
  /** On the books now. */
  sold: number;
  roomRevenue: number;
  occupancyBp: number | null;
  adr: number | null;
  /** Room nights and revenue added, less cancelled, over the last 7 and the last 30 days. */
  pickup7: { roomNights: number; roomRevenue: number };
  pickup30: { roomNights: number; roomRevenue: number };
  /** The same dates a year earlier: what was on the books at this point, and how they ended. */
  lastYear: {
    soldThen: number;
    roomRevenueThen: number;
    soldFinal: number;
    roomRevenueFinal: number;
  };
}

export interface PaceReport {
  from: DateString;
  to: DateString;
  groupBy: 'day' | 'month';
  asOf: string;
  currency: string | null;
  rows: PaceRow[];
  total: Omit<PaceRow, 'period'>;
}

/** 52 weeks back: the same weekday a year earlier, which is what a hotel compares a date with. */
const YEAR_BACK_DAYS = 364;

/**
 * How the nights of a period are selling: what is on the books, how much of
 * it came in the last week and month, and where the same nights stood a year
 * ago today.
 */
export async function paceReport(
  db: DbOrTx,
  orgId: string,
  input: ReportWindow & { groupBy?: 'day' | 'month'; now?: Date },
): Promise<PaceReport> {
  const { from, to } = windowOf(input.from, input.to);
  if (diffDays(from, to) > 400) throw validationError('A pace report covers at most 400 days');
  const groupBy = input.groupBy ?? (diffDays(from, to) > 62 ? 'month' : 'day');
  const now = input.now ?? new Date();
  const scope = await scopeOf(db, orgId, input.propertyIds);
  const ago = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  const [current, weekAgo, monthAgo, yearAgoThen, yearAgoFinal] = await Promise.all([
    nightCells(db, scope, from, to),
    nightCells(db, scope, from, to, ago(7)),
    nightCells(db, scope, from, to, ago(30)),
    nightCells(
      db,
      scope,
      addDays(from, -YEAR_BACK_DAYS),
      addDays(to, -YEAR_BACK_DAYS),
      ago(YEAR_BACK_DAYS),
    ),
    nightCells(db, scope, addDays(from, -YEAR_BACK_DAYS), addDays(to, -YEAR_BACK_DAYS)),
  ]);

  const periodOf = (date: DateString): string => (groupBy === 'day' ? date : date.slice(0, 7));
  type Sum = { available: number; sold: number; revenue: number };
  const sums = (cells: NightCell[], shiftDays = 0): Map<string, Sum> => {
    const out = new Map<string, Sum>();
    for (const cell of cells) {
      const period = periodOf(shiftDays ? addDays(cell.date, shiftDays) : cell.date);
      const sum = out.get(period) ?? { available: 0, sold: 0, revenue: 0 };
      sum.available += cell.available;
      sum.sold += cell.sold;
      sum.revenue += cell.revenue;
      out.set(period, sum);
    }
    return out;
  };
  const zero: Sum = { available: 0, sold: 0, revenue: 0 };
  const nowBy = sums(current);
  const weekBy = sums(weekAgo);
  const monthBy = sums(monthAgo);
  const thenBy = sums(yearAgoThen, YEAR_BACK_DAYS);
  const finalBy = sums(yearAgoFinal, YEAR_BACK_DAYS);

  const row = (period: string, at: Sum, week: Sum, month: Sum, then: Sum, final: Sum): PaceRow => ({
    period,
    available: at.available,
    sold: at.sold,
    roomRevenue: at.revenue,
    occupancyBp: shareBp(at.sold, at.available),
    adr: ratio(at.revenue, at.sold),
    pickup7: { roomNights: at.sold - week.sold, roomRevenue: at.revenue - week.revenue },
    pickup30: { roomNights: at.sold - month.sold, roomRevenue: at.revenue - month.revenue },
    lastYear: {
      soldThen: then.sold,
      roomRevenueThen: then.revenue,
      soldFinal: final.sold,
      roomRevenueFinal: final.revenue,
    },
  });
  const periods = [...new Set([...nowBy.keys()])].sort();
  const rows = periods.map((period) =>
    row(
      period,
      nowBy.get(period) ?? zero,
      weekBy.get(period) ?? zero,
      monthBy.get(period) ?? zero,
      thenBy.get(period) ?? zero,
      finalBy.get(period) ?? zero,
    ),
  );
  const all = (by: Map<string, Sum>): Sum =>
    [...by.values()].reduce(
      (sum, s) => ({
        available: sum.available + s.available,
        sold: sum.sold + s.sold,
        revenue: sum.revenue + s.revenue,
      }),
      zero,
    );
  const { period: _period, ...total } = row(
    'total',
    all(nowBy),
    all(weekBy),
    all(monthBy),
    all(thenBy),
    all(finalBy),
  );
  return { from, to, groupBy, asOf: now.toISOString(), currency: scope.currency, rows, total };
}

// ---------------------------------------------------------------------------
// What was charged and what was taken, day by day

export interface RevenueDay {
  /** The hotel day. */
  date: DateString;
  room: number;
  food: number;
  service: number;
  /** Extras and fees. */
  other: number;
  /** Discounts given, as a negative amount. */
  discounts: number;
  tax: number;
  /** Charges less discounts, with tax. */
  total: number;
  /** Money taken, less refunds, by how it was paid. */
  payments: Partial<Record<PaymentMethod, number>>;
  paymentsTotal: number;
}

export interface RevenueReport {
  from: DateString;
  to: DateString;
  currency: string | null;
  days: RevenueDay[];
  total: Omit<RevenueDay, 'date'>;
}

/** Charges by kind, tax, and money received by method, for each hotel day. From the folios. */
export async function revenueReport(
  db: DbOrTx,
  orgId: string,
  input: ReportWindow,
): Promise<RevenueReport> {
  const { from, to } = windowOf(input.from, input.to);
  const scope = await scopeOf(db, orgId, input.propertyIds);
  const blank = (): Omit<RevenueDay, 'date'> => ({
    room: 0,
    food: 0,
    service: 0,
    other: 0,
    discounts: 0,
    tax: 0,
    total: 0,
    payments: {},
    paymentsTotal: 0,
  });
  if (scope.ids.length === 0) return { from, to, currency: null, days: [], total: blank() };
  const props = uuidArray(scope.ids);
  const { rows: charges } = await db.execute<{
    date: string;
    kind: string;
    amount: string;
    tax: string;
  }>(sql`
    SELECT business_date::text AS date, kind, sum(amount)::text AS amount, sum(tax_amount)::text AS tax
    FROM folio_lines
    WHERE property_id = ANY(${props}) AND business_date >= ${from}::date AND business_date < ${to}::date
      AND voided_at IS NULL AND kind IN ('room', 'food', 'service', 'extra', 'fee', 'discount')
    GROUP BY business_date, kind
  `);
  const { rows: taken } = await db.execute<{ date: string; method: PaymentMethod; amount: string }>(
    sql`
      SELECT l.business_date::text AS date, p.method, (-sum(l.amount))::text AS amount
      FROM folio_lines l JOIN payments p ON p.id = l.payment_id
      WHERE l.property_id = ANY(${props}) AND l.business_date >= ${from}::date AND l.business_date < ${to}::date
        AND l.voided_at IS NULL AND l.kind IN ('payment', 'refund')
      GROUP BY l.business_date, p.method
    `,
  );
  const days = new Map<string, RevenueDay>();
  const dayOf = (date: string): RevenueDay => {
    let day = days.get(date);
    if (!day) {
      day = { date, ...blank() };
      days.set(date, day);
    }
    return day;
  };
  for (const c of charges) {
    const day = dayOf(c.date);
    const amount = Number(c.amount);
    if (c.kind === 'room') day.room += amount;
    else if (c.kind === 'food') day.food += amount;
    else if (c.kind === 'service') day.service += amount;
    else if (c.kind === 'discount') day.discounts += amount;
    else day.other += amount;
    day.tax += Number(c.tax);
    day.total += amount + Number(c.tax);
  }
  for (const t of taken) {
    const day = dayOf(t.date);
    const amount = Number(t.amount);
    day.payments[t.method] = (day.payments[t.method] ?? 0) + amount;
    day.paymentsTotal += amount;
  }
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const total = blank();
  for (const day of list) {
    total.room += day.room;
    total.food += day.food;
    total.service += day.service;
    total.other += day.other;
    total.discounts += day.discounts;
    total.tax += day.tax;
    total.total += day.total;
    total.paymentsTotal += day.paymentsTotal;
    for (const [method, amount] of Object.entries(day.payments) as [PaymentMethod, number][]) {
      total.payments[method] = (total.payments[method] ?? 0) + amount;
    }
  }
  return { from, to, currency: scope.currency, days: list, total };
}

// ---------------------------------------------------------------------------
// Commission owed to travel agents

export interface AgentCommissionRow {
  companyId: string;
  name: string;
  /** In basis points of room revenue. */
  commissionBp: number;
  reservations: number;
  roomNights: number;
  roomRevenue: number;
  commission: number;
}

/** What each travel agent has earned on stays that took place in the period. */
export async function agentCommissionReport(
  db: DbOrTx,
  orgId: string,
  input: ReportWindow,
): Promise<{
  from: DateString;
  to: DateString;
  currency: string | null;
  rows: AgentCommissionRow[];
  total: { reservations: number; roomNights: number; roomRevenue: number; commission: number };
}> {
  const { from, to } = windowOf(input.from, input.to);
  const scope = await scopeOf(db, orgId, input.propertyIds);
  const total = { reservations: 0, roomNights: 0, roomRevenue: 0, commission: 0 };
  if (scope.ids.length === 0) return { from, to, currency: null, rows: [], total };
  const { rows } = await db.execute<{
    company_id: string;
    name: string;
    commission_bp: number;
    reservations: number;
    nights: number;
    revenue: string;
  }>(sql`
    SELECT c.id AS company_id, c.name, c.commission_bp,
      count(DISTINCT r.id)::int AS reservations, count(*)::int AS nights, sum(n.amount)::text AS revenue
    FROM reservation_nights n
    JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
    JOIN reservations r ON r.id = rr.reservation_id
    JOIN companies c ON c.id = r.company_id AND c.kind = 'travel_agent' AND c.org_id = ${orgId}
    -- Commission is earned on nights the guest stayed, not on bookings still to come.
    WHERE rr.property_id = ANY(${uuidArray(scope.ids)}) AND n.date >= ${from}::date AND n.date < ${to}::date
      AND rr.status IN ('in_house', 'checked_out')
    GROUP BY c.id, c.name, c.commission_bp
    ORDER BY c.name
  `);
  const list = rows.map((r) => {
    const roomRevenue = Number(r.revenue);
    return {
      companyId: r.company_id,
      name: r.name,
      commissionBp: r.commission_bp,
      reservations: r.reservations,
      roomNights: r.nights,
      roomRevenue,
      commission: Math.round((roomRevenue * r.commission_bp) / 10_000),
    };
  });
  for (const r of list) {
    total.reservations += r.reservations;
    total.roomNights += r.roomNights;
    total.roomRevenue += r.roomRevenue;
    total.commission += r.commission;
  }
  return { from, to, currency: scope.currency, rows: list, total };
}
