import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { rateDays, ratePlans, type DbOrTx } from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import {
  addDays,
  assertRange,
  datesToRanges,
  dayOfWeek,
  diffDays,
  eachDate,
  type DateRange,
  type DateString,
} from './dates';
import { DomainError, notFound, validationError } from './errors';
import { emit } from './outbox';
import { derivedRatePlanIds, requireProperty, type RatePlanRow } from './properties';
import { transact } from './sqlx';

export interface EffectiveRateDay {
  ratePlanId: string;
  date: DateString;
  /** Nightly rate in minor units for the plan's included occupancy, before tax. */
  rate: number;
  minStayArrival: number;
  minStayThrough: number;
  maxStay: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
  /** True when the day carries its own rate rather than the plan default. */
  rateOverridden: boolean;
}

type RateDayRow = typeof rateDays.$inferSelect;

function deriveRate(
  parentRate: number,
  plan: Pick<RatePlanRow, 'derivedPercentBp' | 'derivedAmount'>,
): number {
  return Math.max(
    0,
    Math.round((parentRate * (10_000 + plan.derivedPercentBp)) / 10_000) + plan.derivedAmount,
  );
}

/**
 * Resolves what a rate plan actually charges and enforces on each day: the
 * day's own override where there is one, else the plan default, with derived
 * plans following their parent's rate.
 */
export function resolveRateDays(
  plans: RatePlanRow[],
  rows: RateDayRow[],
  ratePlanIds: string[],
  dates: DateString[],
): EffectiveRateDay[] {
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const rowsByKey = new Map(rows.map((r) => [`${r.ratePlanId}|${r.date}`, r]));
  const rateCache = new Map<string, number>();

  const rateOf = (planId: string, date: DateString, depth = 0): number => {
    const cacheKey = `${planId}|${date}`;
    const cached = rateCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const plan = plansById.get(planId);
    if (!plan) throw notFound('Rate plan', planId);
    let rate: number;
    if (plan.parentRatePlanId && depth < 10 && plansById.has(plan.parentRatePlanId)) {
      rate = deriveRate(rateOf(plan.parentRatePlanId, date, depth + 1), plan);
    } else {
      rate = rowsByKey.get(cacheKey)?.rate ?? plan.baseRate;
    }
    rateCache.set(cacheKey, rate);
    return rate;
  };

  const out: EffectiveRateDay[] = [];
  for (const planId of ratePlanIds) {
    const plan = plansById.get(planId);
    if (!plan) throw notFound('Rate plan', planId);
    for (const date of dates) {
      const row = rowsByKey.get(`${planId}|${date}`);
      out.push({
        ratePlanId: planId,
        date,
        rate: rateOf(planId, date),
        minStayArrival: row?.minStayArrival ?? plan.minStay,
        minStayThrough: row?.minStayThrough ?? plan.minStay,
        maxStay: row?.maxStay ?? plan.maxStay,
        closedToArrival: row?.closedToArrival ?? false,
        closedToDeparture: row?.closedToDeparture ?? false,
        stopSell: (row?.stopSell ?? false) || !plan.active,
        rateOverridden:
          plan.parentRatePlanId === null && row?.rate !== null && row?.rate !== undefined,
      });
    }
  }
  return out;
}

/** Effective rates and restrictions for a property's rate plans over a date range. */
export async function getRateCalendar(
  db: DbOrTx,
  params: { propertyId: string; range: DateRange; ratePlanIds?: string[] },
): Promise<EffectiveRateDay[]> {
  const nights = diffDays(params.range.from, params.range.to);
  if (nights <= 0) throw validationError('The date range must end after it starts');
  if (nights > 1100) throw validationError('A rate calendar may span at most 1100 days');
  const plans = await db
    .select()
    .from(ratePlans)
    .where(eq(ratePlans.propertyId, params.propertyId));
  const wanted = params.ratePlanIds ?? plans.map((p) => p.id);
  if (wanted.length === 0) return [];
  const rows = await db
    .select()
    .from(rateDays)
    .where(
      and(
        inArray(
          rateDays.ratePlanId,
          plans.map((p) => p.id),
        ),
        gte(rateDays.date, params.range.from),
        lt(rateDays.date, params.range.to),
      ),
    );
  return resolveRateDays(plans, rows, wanted, eachDate(params.range.from, params.range.to));
}

export interface RateChange {
  /** Nightly rate in minor units; null removes the day's override. */
  rate?: number | null;
  minStayArrival?: number | null;
  minStayThrough?: number | null;
  maxStay?: number | null;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  stopSell?: boolean;
}

export interface SetRatesInput {
  propertyId: string;
  ratePlanId: string;
  range: DateRange;
  /** Limit the change to these weekdays (0 = Sunday). Omit for every day. */
  daysOfWeek?: number[];
  change: RateChange;
}

const COLUMN_OF: Record<keyof RateChange, string> = {
  rate: 'rate',
  minStayArrival: 'min_stay_arrival',
  minStayThrough: 'min_stay_through',
  maxStay: 'max_stay',
  closedToArrival: 'closed_to_arrival',
  closedToDeparture: 'closed_to_departure',
  stopSell: 'stop_sell',
};

function validateChange(change: RateChange): (keyof RateChange)[] {
  const fields = (Object.keys(COLUMN_OF) as (keyof RateChange)[]).filter(
    (f) => change[f] !== undefined,
  );
  if (fields.length === 0) throw validationError('Nothing to change');
  if (
    change.rate !== undefined &&
    change.rate !== null &&
    (!Number.isInteger(change.rate) || change.rate < 0)
  ) {
    throw validationError('Rate must be a non-negative whole amount in minor units');
  }
  for (const f of ['minStayArrival', 'minStayThrough', 'maxStay'] as const) {
    const v = change[f];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1 || v > 365)) {
      throw validationError('Stay lengths must be between 1 and 365 nights');
    }
  }
  return fields;
}

/**
 * Sets rates and restrictions for a rate plan across a date range, and queues
 * the affected days (for this plan and plans derived from it) for the channels
 * in the same transaction.
 */
export async function setRates(
  db: DbOrTx,
  actor: Actor,
  input: SetRatesInput,
): Promise<{ daysChanged: number }> {
  const range = assertRange(input.range.from, input.range.to);
  if (diffDays(range.from, range.to) > 1100)
    throw validationError('A rate update may span at most 1100 days');
  const fields = validateChange(input.change);
  if (input.daysOfWeek && input.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw validationError('Days of the week must be numbers from 0 (Sunday) to 6 (Saturday)');
  }
  const dates = eachDate(range.from, range.to).filter(
    (d) => !input.daysOfWeek || input.daysOfWeek.includes(dayOfWeek(d)),
  );
  if (dates.length === 0) return { daysChanged: 0 };

  return transact(db, async (tx) => {
    await requireProperty(tx, actor.orgId, input.propertyId);
    const [plan] = await tx
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.id, input.ratePlanId), eq(ratePlans.propertyId, input.propertyId)));
    if (!plan) throw notFound('Rate plan', input.ratePlanId);
    if (plan.parentRatePlanId && input.change.rate !== undefined) {
      throw validationError(
        'This rate plan takes its rate from its parent plan. Change the parent, or the derivation.',
      );
    }

    const values = fields.map((f) => {
      const v = input.change[f];
      return typeof v === 'boolean'
        ? sql`${v}::boolean`
        : v === null
          ? sql`NULL::bigint`
          : sql`${v}::bigint`;
    });
    const columns = sql.join(
      fields.map((f) => sql.raw(COLUMN_OF[f])),
      sql`, `,
    );
    const updates = sql.join(
      fields.map((f) => sql.raw(`${COLUMN_OF[f]} = EXCLUDED.${COLUMN_OF[f]}`)),
      sql`, `,
    );
    const distinct = sql.join(
      fields.map((f) =>
        sql.raw(`rate_days.${COLUMN_OF[f]} IS DISTINCT FROM EXCLUDED.${COLUMN_OF[f]}`),
      ),
      sql` OR `,
    );
    const result = await tx.execute<{ date: string }>(sql`
      INSERT INTO rate_days (rate_plan_id, date, ${columns}, updated_at)
      SELECT ${plan.id}::uuid, d::date, ${sql.join(values, sql`, `)}, now()
      FROM unnest(ARRAY[${sql.join(
        dates.map((d) => sql`${d}`),
        sql`, `,
      )}]::date[]) d
      ON CONFLICT (rate_plan_id, date) DO UPDATE SET ${updates}, updated_at = now()
      WHERE ${distinct}
      RETURNING date
    `);
    const changedDates = result.rows.map((r) => r.date);
    if (changedDates.length === 0) return { daysChanged: 0 };

    const affected = await tx
      .select({ id: ratePlans.id, roomTypeId: ratePlans.roomTypeId })
      .from(ratePlans)
      .where(inArray(ratePlans.id, [plan.id, ...(await derivedRatePlanIds(tx, plan.id))]));
    const ranges = datesToRanges(changedDates);
    await emit(
      tx,
      actor.orgId,
      affected.flatMap((p) =>
        ranges.map((r) => ({
          kind: 'ari.restrictions' as const,
          propertyId: input.propertyId,
          ratePlanId: p.id,
          roomTypeId: p.roomTypeId,
          range: r,
        })),
      ),
    );
    await emit(tx, actor.orgId, [
      {
        kind: 'rates.updated',
        propertyId: input.propertyId,
        payload: { ratePlanId: plan.id, from: range.from, to: range.to },
      },
    ]);
    await writeAudit(tx, actor, {
      action: 'rates.updated',
      entityType: 'rate_plan',
      entityId: plan.id,
      propertyId: input.propertyId,
      summary: `Changed ${fields.join(', ')} on ${changedDates.length} day(s) of ${plan.name} (${range.from} to ${addDays(range.to, -1)})`,
      changes: { range, daysOfWeek: input.daysOfWeek ?? null, change: input.change },
    });
    return { daysChanged: changedDates.length };
  });
}

// ---------------------------------------------------------------------------
// Quoting

export type RestrictionCode =
  'stop_sell' | 'closed_to_arrival' | 'closed_to_departure' | 'min_stay' | 'max_stay';

export interface RestrictionViolation {
  code: RestrictionCode;
  date: DateString;
  message: string;
}

/**
 * Checks a stay against the day-level restrictions. `days` must cover every
 * night of the stay and the departure date.
 */
export function restrictionViolations(
  days: EffectiveRateDay[],
  checkIn: DateString,
  checkOut: DateString,
): RestrictionViolation[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const nights = diffDays(checkIn, checkOut);
  const out: RestrictionViolation[] = [];
  const arrival = byDate.get(checkIn);
  if (arrival?.closedToArrival) {
    out.push({
      code: 'closed_to_arrival',
      date: checkIn,
      message: `Arrivals are closed on ${checkIn}`,
    });
  }
  if (arrival && nights < arrival.minStayArrival) {
    out.push({
      code: 'min_stay',
      date: checkIn,
      message: `Stays arriving on ${checkIn} must be at least ${arrival.minStayArrival} nights`,
    });
  }
  if (arrival?.maxStay && nights > arrival.maxStay) {
    out.push({
      code: 'max_stay',
      date: checkIn,
      message: `Stays arriving on ${checkIn} may be at most ${arrival.maxStay} nights`,
    });
  }
  for (const date of eachDate(checkIn, checkOut)) {
    const day = byDate.get(date);
    if (!day) continue;
    if (day.stopSell) out.push({ code: 'stop_sell', date, message: `Not on sale on ${date}` });
    if (date !== checkIn && nights < day.minStayThrough) {
      out.push({
        code: 'min_stay',
        date,
        message: `Stays including ${date} must be at least ${day.minStayThrough} nights`,
      });
    }
  }
  if (byDate.get(checkOut)?.closedToDeparture) {
    out.push({
      code: 'closed_to_departure',
      date: checkOut,
      message: `Departures are closed on ${checkOut}`,
    });
  }
  return out;
}

/** Nightly charge for a party: the day rate plus supplements for guests beyond the included occupancy. */
export function nightlyCharge(
  rate: number,
  plan: Pick<RatePlanRow, 'includedOccupancy' | 'extraAdultRate' | 'extraChildRate'>,
  adults: number,
  children: number,
): number {
  const extraAdults = Math.max(0, adults - plan.includedOccupancy);
  // Children first fill any included places the adults left empty.
  const freeChildPlaces = Math.max(0, plan.includedOccupancy - adults);
  const extraChildren = Math.max(0, children - freeChildPlaces);
  return rate + extraAdults * plan.extraAdultRate + extraChildren * plan.extraChildRate;
}

export interface StayQuote {
  ratePlanId: string;
  currency: string;
  nights: { date: DateString; amount: number }[];
  total: number;
  violations: RestrictionViolation[];
}

export async function quoteStay(
  db: DbOrTx,
  params: {
    propertyId: string;
    ratePlanId: string;
    checkIn: DateString;
    checkOut: DateString;
    adults: number;
    children?: number;
  },
): Promise<StayQuote> {
  assertRange(params.checkIn, params.checkOut, 'stay');
  const [plan] = await db
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.id, params.ratePlanId), eq(ratePlans.propertyId, params.propertyId)));
  if (!plan) throw notFound('Rate plan', params.ratePlanId);
  const days = await getRateCalendar(db, {
    propertyId: params.propertyId,
    range: { from: params.checkIn, to: addDays(params.checkOut, 1) },
    ratePlanIds: [plan.id],
  });
  const byDate = new Map(days.map((d) => [d.date, d]));
  const nights = eachDate(params.checkIn, params.checkOut).map((date) => ({
    date,
    amount: nightlyCharge(byDate.get(date)!.rate, plan, params.adults, params.children ?? 0),
  }));
  return {
    ratePlanId: plan.id,
    currency: plan.currency,
    nights,
    total: nights.reduce((sum, n) => sum + n.amount, 0),
    violations: restrictionViolations(days, params.checkIn, params.checkOut),
  };
}

export function assertNoViolations(violations: RestrictionViolation[]): void {
  if (violations.length > 0) {
    throw new DomainError('restriction_violated', violations[0]!.message, { violations });
  }
}
