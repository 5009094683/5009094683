import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  properties,
  rateRecommendations,
  ratePlans,
  roomTypes,
  type Database,
  type DbOrTx,
  type RecommendationDriver,
  type RecommendationStatus,
} from '@pms/db';
import {
  addDays,
  dayOfWeek,
  diffDays,
  eachDate,
  getAvailability,
  getRateCalendar,
  notFound,
  setRates,
  systemActor,
  todayIn,
  validationError,
  writeAudit,
  type Actor,
  type DateString,
} from '@pms/domain';

export type RecommendationRow = typeof rateRecommendations.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;
type RatePlanRow = typeof ratePlans.$inferSelect;

const DEFAULT_HORIZON_DAYS = 120;
const DEFAULT_MAX_CHANGE_PERCENT = 40;
const DEFAULT_ROUNDING = 5_000;
/** A suggestion closer than this to the current rate is not worth anyone's attention. */
const MIN_CHANGE_BP = 300;
/** Room nights of history from which the property's own booking pattern is trusted over the built-in one. */
const ENOUGH_HISTORY_NIGHTS = 200;

/**
 * Share of a night's final bookings that is usually already made a given
 * number of days ahead. The built-in curve stands in until the property has
 * enough history of its own.
 */
const DEFAULT_PICKUP: [lead: number, share: number][] = [
  [0, 1],
  [1, 0.92],
  [3, 0.85],
  [7, 0.72],
  [14, 0.58],
  [21, 0.48],
  [30, 0.38],
  [45, 0.28],
  [60, 0.2],
  [90, 0.12],
  [120, 0.08],
  [180, 0.05],
];

function interpolate(points: [number, number][], x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1]![1];
}

/** How demand translates into price: the expected share of rooms sold, and what that does to the rate. */
const OCCUPANCY_EFFECT: [occupancy: number, effectBp: number][] = [
  [0, -1500],
  [0.3, -1500],
  [0.5, -500],
  [0.7, 500],
  [0.85, 1500],
  [0.95, 2500],
  [1, 3000],
];

export interface DemandInput {
  /** Rooms that can be sold that night (not blocked, not out of order). */
  capacity: number;
  sold: number;
  /** Days from today to the night. */
  lead: number;
  /** Share of rooms usually sold on a night like this one, 0 to 1. */
  baseline: number;
  /** Share of final bookings usually made by this lead time, 0 to 1. */
  pickupShare: number;
  event?: { name: string; upliftPercent: number } | null;
}

export interface DemandOutput {
  occupancy: number;
  forecast: number;
  drivers: RecommendationDriver[];
  /** Sum of the drivers, before any limit. */
  effectBp: number;
}

/**
 * The demand model, as a pure function of what is known about one night.
 *
 * Expected final sales are what is sold now plus what usually still comes in
 * from this lead time on, scaled by how today's bookings compare with the
 * usual pace. The rate then moves with the expected occupancy, with a few
 * plain rules on top (an event, unsold rooms at the last minute, the last
 * room).
 */
export function assessDemand(input: DemandInput): DemandOutput {
  const capacity = Math.max(0, input.capacity);
  if (capacity === 0) return { occupancy: 1, forecast: 1, drivers: [], effectBp: 0 };
  const sold = Math.min(input.sold, capacity);
  const occupancy = sold / capacity;
  const share = Math.min(1, Math.max(0.03, input.pickupShare));
  const baseline = Math.min(1, Math.max(0.05, input.baseline + (input.event ? 0.2 : 0)));
  const usualNow = baseline * capacity * share;
  // One booking more or less should not swing the pace of a small property, hence the +1 on both sides.
  const pace = Math.min(2, Math.max(0.5, (sold + 1) / (usualNow + 1)));
  const stillToCome = baseline * capacity * (1 - share) * pace;
  const forecast = Math.min(1, (sold + stillToCome) / capacity);

  const drivers: RecommendationDriver[] = [];
  const demand = Math.round(interpolate(OCCUPANCY_EFFECT, forecast));
  if (demand !== 0) {
    drivers.push({
      label:
        demand > 0
          ? `Expected to be ${Math.round(forecast * 100)}% full`
          : `Expected to be only ${Math.round(forecast * 100)}% full`,
      effectBp: demand,
    });
  }
  if (pace >= 1.5 && input.lead >= 3) {
    drivers.push({ label: 'Booking faster than usual for this far ahead', effectBp: 500 });
  } else if (pace <= 0.6 && input.lead <= 30 && input.lead >= 3) {
    drivers.push({ label: 'Booking slower than usual', effectBp: -500 });
  }
  if (input.event) {
    drivers.push({
      label: input.event.name,
      effectBp: Math.round(input.event.upliftPercent * 100),
    });
  }
  if (input.lead <= 2 && occupancy < 0.5) {
    drivers.push({
      label:
        input.lead === 0 ? 'Rooms still unsold for tonight' : 'Rooms still unsold at short notice',
      effectBp: -1000,
    });
  }
  if (capacity >= 3 && capacity - sold === 1 && input.lead > 7) {
    drivers.push({ label: 'Last room of this kind', effectBp: 500 });
  }
  return {
    occupancy,
    forecast,
    drivers,
    effectBp: drivers.reduce((sum, d) => sum + d.effectBp, 0),
  };
}

export interface RateLimits {
  baseRate: number;
  floorRate: number | null;
  ceilingRate: number | null;
  maxChangePercent: number;
  rounding: number;
}

/** Turns an effect into a rate: bounded around the base rate, kept inside floor and ceiling, rounded. */
export function recommendRate(effectBp: number, limits: RateLimits): number {
  const maxBp = limits.maxChangePercent * 100;
  const bounded = Math.min(maxBp, Math.max(-maxBp, effectBp));
  let rate = Math.round((limits.baseRate * (10_000 + bounded)) / 10_000);
  const step = Math.max(1, limits.rounding);
  rate = Math.max(step, Math.round(rate / step) * step);
  // The floor and ceiling are the owner's word and win over rounding.
  if (limits.floorRate !== null) rate = Math.max(rate, limits.floorRate);
  if (limits.ceilingRate !== null) rate = Math.min(rate, limits.ceilingRate);
  return rate;
}

interface History {
  /** Room nights sold in the past year for this room type. */
  nights: number;
  /** Days of the past year with at least one room sold anywhere in the property (how long it has been trading). */
  tradingDays: number;
  /** Mean share of rooms sold on weekend nights (Friday, Saturday) and on the others. */
  weekend: number | null;
  weekday: number | null;
  pickup: [number, number][] | null;
}

async function historyOf(
  db: DbOrTx,
  property: PropertyRow,
  roomTypeId: string,
  units: number,
  today: DateString,
): Promise<History> {
  const from = addDays(today, -365);
  const { rows } = await db.execute<{ date: string; sold: number }>(sql`
    SELECT n.date::text AS date, count(*)::int AS sold
    FROM reservation_nights n JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
    WHERE rr.room_type_id = ${roomTypeId} AND rr.status IN ('confirmed', 'in_house', 'checked_out')
      AND n.date >= ${from}::date AND n.date < ${today}::date
    GROUP BY n.date
  `);
  const nights = rows.reduce((sum, r) => sum + r.sold, 0);
  const { rows: trading } = await db.execute<{ first: string | null }>(sql`
    SELECT min(n.date)::text AS first
    FROM reservation_nights n JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
    WHERE rr.property_id = ${property.id} AND rr.status IN ('confirmed', 'in_house', 'checked_out')
      AND n.date >= ${from}::date AND n.date < ${today}::date
  `);
  const first = trading[0]?.first ?? null;
  const tradingDays = first ? diffDays(first, today) : 0;
  const mean = (weekend: boolean): number | null => {
    if (!first || units === 0) return null;
    const dates = eachDate(first, today).filter((d) => [5, 6].includes(dayOfWeek(d)) === weekend);
    if (dates.length < 8) return null;
    const sold = new Map(rows.map((r) => [r.date, r.sold]));
    return (
      dates.reduce((sum, d) => sum + Math.min(1, (sold.get(d) ?? 0) / units), 0) / dates.length
    );
  };
  let pickup: [number, number][] | null = null;
  if (nights >= ENOUGH_HISTORY_NIGHTS) {
    // For each lead time on the built-in curve: the share of past room nights already booked that far ahead.
    const { rows: leads } = await db.execute<{ lead: number; share: number }>(sql`
      WITH booked AS (
        SELECT (n.date - (r.created_at AT TIME ZONE ${property.timezone})::date) AS lead
        FROM reservation_nights n
        JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
        JOIN reservations r ON r.id = rr.reservation_id
        WHERE rr.room_type_id = ${roomTypeId} AND rr.status IN ('confirmed', 'in_house', 'checked_out')
          AND n.date >= ${from}::date AND n.date < ${today}::date
      )
      SELECT p.lead::int AS lead, (count(*) FILTER (WHERE b.lead >= p.lead))::float / count(*) AS share
      FROM booked b CROSS JOIN unnest(${sql.raw(`ARRAY[${DEFAULT_PICKUP.map(([lead]) => lead).join(',')}]`)}) AS p(lead)
      GROUP BY p.lead ORDER BY p.lead
    `);
    pickup = leads.map((l) => [l.lead, Math.min(1, Math.max(0.03, Number(l.share)))]);
  }
  return { nights, tradingDays, weekend: mean(true), weekday: mean(false), pickup };
}

export interface PricingRun {
  propertyId: string;
  created: number;
  /** Applied straight away under a room type's standing permission. */
  autoApplied: number;
  /** Suggestions withdrawn because the picture changed. */
  superseded: number;
}

/**
 * Works out rate suggestions for a property: for every main rate plan and
 * every night of the horizon, what the rate should be given how the night is
 * selling. Suggestions wait for approval, except for room types on
 * autopilot, where they are applied at once inside the plan's floor and
 * ceiling. Safe to run as often as wanted: it replaces its own earlier
 * suggestions and never touches a rate by itself outside autopilot.
 */
export async function generateRecommendations(
  db: Database,
  propertyId: string,
  options: { now?: Date; horizonDays?: number } = {},
): Promise<PricingRun> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) throw notFound('Property', propertyId);
  const run: PricingRun = { propertyId, created: 0, autoApplied: 0, superseded: 0 };
  if (!property.active) return run;
  const now = options.now ?? new Date();
  const today = todayIn(property.timezone, now);
  const horizon = Math.min(
    options.horizonDays ?? DEFAULT_HORIZON_DAYS,
    Math.max(1, property.inventoryHorizonDays),
  );
  const range = { from: today, to: addDays(today, horizon) };
  const settings = property.settings;
  const events = settings.pricingEvents ?? [];
  const autopilot = new Set(settings.pricingAutopilotRoomTypes ?? []);

  const types = await db
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, propertyId), eq(roomTypes.active, true)));
  const plans = await db
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.active, true)));
  // Plans that follow another move with it; only the plans that carry their own rate are priced.
  const priced = plans.filter((p) => !p.parentRatePlanId && p.baseRate > 0);
  if (priced.length === 0) return run;

  const availability = await getAvailability(db, { propertyId, range });
  const calendar = await getRateCalendar(db, {
    propertyId,
    range,
    ratePlanIds: priced.map((p) => p.id),
  });
  const pending = await db
    .select()
    .from(rateRecommendations)
    .where(
      and(
        eq(rateRecommendations.propertyId, propertyId),
        eq(rateRecommendations.status, 'pending'),
      ),
    );
  const pendingByKey = new Map(pending.map((r) => [`${r.ratePlanId}|${r.date}`, r]));
  const seen = new Set<string>();
  const toApply: { plan: RatePlanRow; date: DateString; rate: number; id: string }[] = [];

  for (const type of types) {
    const typePlans = priced.filter((p) => p.roomTypeId === type.id);
    if (typePlans.length === 0) continue;
    const days = availability.filter((d) => d.roomTypeId === type.id);
    const units = Math.max(...days.map((d) => d.total), 0);
    const history = await historyOf(db, property, type.id, units, today);
    const confidence: RecommendationRow['confidence'] =
      history.nights >= ENOUGH_HISTORY_NIGHTS && history.tradingDays >= 180
        ? 'high'
        : history.tradingDays >= 60
          ? 'medium'
          : 'low';

    for (const day of days) {
      const capacity = day.total - day.blocked - day.outOfOrder;
      if (capacity <= 0) continue;
      const lead = diffDays(today, day.date);
      const weekend = [5, 6].includes(dayOfWeek(day.date));
      const event = events.find((e) => day.date >= e.from && day.date <= e.to);
      const demand = assessDemand({
        capacity,
        sold: day.sold,
        lead,
        baseline: (weekend ? history.weekend : history.weekday) ?? (weekend ? 0.65 : 0.5),
        pickupShare: interpolate(history.pickup ?? DEFAULT_PICKUP, lead),
        event: event ? { name: event.name, upliftPercent: event.upliftPercent ?? 15 } : null,
      });
      for (const plan of typePlans) {
        const current = calendar.find((c) => c.ratePlanId === plan.id && c.date === day.date);
        if (!current || current.stopSell || current.rate <= 0) continue;
        const recommended = recommendRate(demand.effectBp, {
          baseRate: plan.baseRate,
          floorRate: plan.floorRate,
          ceilingRate: plan.ceilingRate,
          maxChangePercent: settings.pricingMaxChangePercent ?? DEFAULT_MAX_CHANGE_PERCENT,
          rounding: settings.pricingRounding ?? DEFAULT_ROUNDING,
        });
        const key = `${plan.id}|${day.date}`;
        const differenceBp = Math.abs(((recommended - current.rate) * 10_000) / current.rate);
        if (differenceBp < MIN_CHANGE_BP) continue;
        seen.add(key);
        const existing = pendingByKey.get(key);
        if (existing && existing.recommendedRate === recommended) continue;
        if (existing) {
          await db
            .update(rateRecommendations)
            .set({ status: 'superseded' })
            .where(eq(rateRecommendations.id, existing.id));
          run.superseded++;
        }
        const [row] = await db
          .insert(rateRecommendations)
          .values({
            propertyId,
            roomTypeId: type.id,
            ratePlanId: plan.id,
            date: day.date,
            currentRate: current.rate,
            recommendedRate: recommended,
            occupancyBp: Math.round(demand.occupancy * 10_000),
            forecastBp: Math.round(demand.forecast * 10_000),
            drivers: demand.drivers,
            confidence,
          })
          .returning();
        run.created++;
        // Autopilot only where the owner has fenced it in on both sides.
        if (autopilot.has(type.id) && plan.floorRate !== null && plan.ceilingRate !== null) {
          toApply.push({ plan, date: day.date, rate: recommended, id: row!.id });
        }
      }
    }
  }

  // A pending suggestion for a night that no longer calls for one (or that has passed) is withdrawn.
  for (const [key, row] of pendingByKey) {
    if (seen.has(key)) continue;
    await db
      .update(rateRecommendations)
      .set({ status: 'superseded' })
      .where(and(eq(rateRecommendations.id, row.id), eq(rateRecommendations.status, 'pending')));
    run.superseded++;
  }

  if (toApply.length > 0) {
    const actor = systemActor(property.orgId, 'pricing-autopilot');
    run.autoApplied = await applyRows(db, actor, property, toApply, 'autopilot');
  }
  return run;
}

/** Sets the rates, one call per run of consecutive nights with the same rate, and marks the suggestions applied. */
async function applyRows(
  db: Database,
  actor: Actor,
  property: PropertyRow,
  rows: { plan: Pick<RatePlanRow, 'id'>; date: DateString; rate: number; id: string }[],
  via: 'manual' | 'autopilot',
): Promise<number> {
  const byPlan = new Map<string, typeof rows>();
  for (const row of rows) {
    byPlan.set(row.plan.id, [...(byPlan.get(row.plan.id) ?? []), row]);
  }
  let applied = 0;
  for (const [planId, list] of byPlan) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let start = 0;
    while (start < list.length) {
      let end = start;
      while (
        end + 1 < list.length &&
        list[end + 1]!.rate === list[start]!.rate &&
        list[end + 1]!.date === addDays(list[end]!.date, 1)
      ) {
        end++;
      }
      await setRates(db, actor, {
        propertyId: property.id,
        ratePlanId: planId,
        range: { from: list[start]!.date, to: addDays(list[end]!.date, 1) },
        change: { rate: list[start]!.rate },
      });
      const ids = list.slice(start, end + 1).map((r) => r.id);
      const updated = await db
        .update(rateRecommendations)
        .set({
          status: 'applied',
          appliedVia: via,
          decidedBy: actor.userId ?? null,
          decidedAt: new Date(),
        })
        .where(and(inArray(rateRecommendations.id, ids), eq(rateRecommendations.status, 'pending')))
        .returning({ id: rateRecommendations.id });
      applied += updated.length;
      start = end + 1;
    }
  }
  return applied;
}

export interface RecommendationView extends RecommendationRow {
  roomTypeName: string;
  ratePlanName: string;
  currency: string;
}

export async function listRecommendations(
  db: DbOrTx,
  orgId: string,
  filter: {
    propertyId: string;
    from?: DateString;
    to?: DateString;
    status?: RecommendationStatus;
    limit?: number;
  },
): Promise<RecommendationView[]> {
  const rows = await db
    .select({
      recommendation: rateRecommendations,
      roomTypeName: roomTypes.name,
      ratePlanName: ratePlans.name,
      currency: ratePlans.currency,
    })
    .from(rateRecommendations)
    .innerJoin(properties, eq(properties.id, rateRecommendations.propertyId))
    .innerJoin(roomTypes, eq(roomTypes.id, rateRecommendations.roomTypeId))
    .innerJoin(ratePlans, eq(ratePlans.id, rateRecommendations.ratePlanId))
    .where(
      and(
        eq(properties.orgId, orgId),
        eq(rateRecommendations.propertyId, filter.propertyId),
        eq(rateRecommendations.status, filter.status ?? 'pending'),
        filter.from ? gte(rateRecommendations.date, filter.from) : undefined,
        filter.to ? lt(rateRecommendations.date, filter.to) : undefined,
      ),
    )
    .orderBy(asc(rateRecommendations.date), asc(roomTypes.name), asc(ratePlans.name))
    .limit(Math.min(filter.limit ?? 500, 2000));
  return rows.map((r) => ({
    ...r.recommendation,
    roomTypeName: r.roomTypeName,
    ratePlanName: r.ratePlanName,
    currency: r.currency,
  }));
}

async function ownPending(
  db: DbOrTx,
  orgId: string,
  ids: string[],
): Promise<{ rows: RecommendationRow[]; property: PropertyRow }> {
  if (ids.length === 0) throw validationError('Choose at least one suggestion');
  const rows = await db
    .select({ recommendation: rateRecommendations, property: properties })
    .from(rateRecommendations)
    .innerJoin(properties, eq(properties.id, rateRecommendations.propertyId))
    .where(and(inArray(rateRecommendations.id, ids), eq(properties.orgId, orgId)));
  if (rows.length !== new Set(ids).size) throw notFound('Rate suggestion');
  const propertyIds = new Set(rows.map((r) => r.property.id));
  if (propertyIds.size > 1)
    throw validationError('Apply the suggestions of one property at a time');
  return { rows: rows.map((r) => r.recommendation), property: rows[0]!.property };
}

/** The property the suggestions belong to, so the caller can check the user's permission there. */
export async function recommendationsProperty(
  db: DbOrTx,
  orgId: string,
  ids: string[],
): Promise<string> {
  return (await ownPending(db, orgId, ids)).property.id;
}

/** Applies suggestions a person approved. Ones already decided are skipped. Returns how many were applied. */
export async function applyRecommendations(
  db: Database,
  actor: Actor,
  ids: string[],
): Promise<number> {
  const { rows, property } = await ownPending(db, actor.orgId, ids);
  const pending = rows.filter((r) => r.status === 'pending');
  const applied = await applyRows(
    db,
    actor,
    property,
    pending.map((r) => ({
      plan: { id: r.ratePlanId },
      date: r.date,
      rate: r.recommendedRate,
      id: r.id,
    })),
    'manual',
  );
  if (applied > 0) {
    await writeAudit(db, actor, {
      action: 'pricing.recommendations_applied',
      entityType: 'property',
      entityId: property.id,
      propertyId: property.id,
      summary: `Applied ${applied} suggested rate${applied === 1 ? '' : 's'}`,
    });
  }
  return applied;
}

export async function dismissRecommendations(
  db: Database,
  actor: Actor,
  ids: string[],
): Promise<number> {
  await ownPending(db, actor.orgId, ids);
  const updated = await db
    .update(rateRecommendations)
    .set({ status: 'dismissed', decidedBy: actor.userId ?? null, decidedAt: new Date() })
    .where(and(inArray(rateRecommendations.id, ids), eq(rateRecommendations.status, 'pending')))
    .returning({ id: rateRecommendations.id });
  return updated.length;
}

/** Runs the suggestions for every active property. For the worker, once a night. */
export async function generateAllRecommendations(
  db: Database,
  now: Date = new Date(),
): Promise<PricingRun[]> {
  const all = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.active, true));
  const runs: PricingRun[] = [];
  for (const { id } of all) runs.push(await generateRecommendations(db, id, { now }));
  return runs;
}
