import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, emptyJson, id, money, timestamptz, updatedAt } from './_shared';
import {
  HOUSEKEEPING_STATUSES,
  MEAL_PLANS,
  PROPERTY_KINDS,
  UNIT_ASSIGNMENT_MODES,
  sqlList,
  type HousekeepingStatus,
  type MealPlan,
  type PropertyKind,
  type UnitAssignmentMode,
} from './enums';
import { organizations } from './identity';

export interface PropertySettings {
  /** Local hour (0-23) at which the night audit runs by itself. Absent: 3. Null turns the automatic run off. */
  nightAuditHour?: number | null;
  /** Guests who have not arrived by the night audit are marked no-show by it. Absent: false (they are only listed). */
  autoNoShow?: boolean;
  /** Up to four letters or digits that start every invoice number. Absent: taken from the property code. */
  invoicePrefix?: string;
  /** India GST: restaurant and room service are taxed at the higher rate at "specified premises". */
  specifiedPremises?: boolean;
  /** Minutes a website booking holds inventory while the guest pays. */
  bookingHoldMinutes?: number;
  bookingEngineEnabled?: boolean;
  /**
   * What a website booking pays when it is made: the whole stay, a deposit,
   * or nothing (pay at the property). Absent: the whole stay. A non-refundable
   * rate is always paid in full.
   */
  bookingPayment?: 'full' | 'deposit' | 'none';
  /** Share of the stay taken as a deposit, in percent. Absent: 30. */
  depositPercent?: number;
  /** House rules and terms a guest accepts when booking and at online check-in. */
  bookingTerms?: string;
  /** Sent to guests before arrival: directions, key collection, contact number. */
  arrivalInstructions?: string;
  /**
   * Room types whose suggested rates are applied without waiting for a
   * person. Only ever inside the rate plan's floor and ceiling, and only for
   * plans that have both.
   */
  pricingAutopilotRoomTypes?: string[];
  /** The most a suggested rate may differ from the plan's base rate, in percent. Absent: 40. */
  pricingMaxChangePercent?: number;
  /** Suggested rates are rounded to a multiple of this many minor units. Absent: 5000 (fifty rupees). */
  pricingRounding?: number;
  /** Dates that sell like weekends whatever the weekday: festivals, long weekends, local events. */
  pricingEvents?: { from: string; to: string; name: string; upliftPercent?: number }[];
  /** Facts the assistant may use when drafting replies to guests: parking, Wi-Fi, pets, distances. */
  knowledge?: string;
  /** Up to this age a guest is booked as a child. Told to guests when they say who is coming. */
  childMaxAge?: number;
  /** Minutes of housekeeping work for a departure clean and a stay-over service. */
  departureCleanMinutes?: number;
  stayoverCleanMinutes?: number;
  brandColor?: string;
  description?: string;
  amenities?: string[];
  photos?: string[];
}

export interface CancellationPolicy {
  nonRefundable?: boolean;
  /** Free cancellation until this many days before arrival. */
  freeCancelDays?: number;
  /** Charge applied after the free-cancellation window. */
  penalty?: 'first_night' | 'percent' | 'full';
  penaltyPercent?: number;
}

export const properties = pgTable(
  'properties',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<PropertyKind>().notNull(),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    currency: text('currency').notNull().default('INR'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    /** GST state code (two digits) of the place of supply. */
    stateCode: text('state_code'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('IN'),
    phone: text('phone'),
    email: citext('email'),
    legalName: text('legal_name'),
    gstin: text('gstin'),
    checkInTime: text('check_in_time').notNull().default('14:00'),
    checkOutTime: text('check_out_time').notNull().default('11:00'),
    /** How far ahead availability is kept and pushed to channels. */
    inventoryHorizonDays: integer('inventory_horizon_days').notNull().default(540),
    /**
     * The hotel day in progress: charges are dated to it, and the night audit
     * closes it and opens the next. Null until the first audit; today is used meanwhile.
     */
    businessDate: date('business_date', { mode: 'string' }),
    settings: jsonb('settings').$type<PropertySettings>().notNull().default(emptyJson),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('properties_org_code_key').on(t.orgId, t.code),
    check('properties_kind_check', sql.raw(`kind IN (${sqlList(PROPERTY_KINDS)})`)),
    check('properties_horizon_check', sql`inventory_horizon_days BETWEEN 30 AND 1095`),
  ],
);

export const roomTypes = pgTable(
  'room_types',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    baseOccupancy: integer('base_occupancy').notNull().default(2),
    maxAdults: integer('max_adults').notNull().default(2),
    maxChildren: integer('max_children').notNull().default(0),
    maxOccupancy: integer('max_occupancy').notNull().default(2),
    /**
     * `at_booking`: every reservation gets a physical unit immediately (villas,
     * linked inventory). `at_check_in`: sold by count, unit chosen later (hotels).
     */
    assignment: text('assignment').$type<UnitAssignmentMode>().notNull().default('at_check_in'),
    /**
     * For room types sold by count: give each new booking a free room straight
     * away when one fits the whole stay, so the calendar shows where guests will
     * be. The booking is still accepted, unassigned, when none does.
     */
    autoAssign: boolean('auto_assign').notNull().default(true),
    amenities: jsonb('amenities')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    photos: jsonb('photos')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('room_types_property_code_key').on(t.propertyId, t.code),
    check(
      'room_types_assignment_check',
      sql.raw(`assignment IN (${sqlList(UNIT_ASSIGNMENT_MODES)})`),
    ),
    check(
      'room_types_occupancy_check',
      sql`base_occupancy >= 1 AND max_adults >= 1 AND max_children >= 0 AND max_occupancy >= base_occupancy`,
    ),
  ],
);

export const units = pgTable(
  'units',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    floor: text('floor'),
    /**
     * Linked inventory: a unit with children is sold as a whole (the villa) and
     * its children are sold on their own (the bedrooms). Occupying either side
     * makes the other unavailable.
     */
    parentUnitId: uuid('parent_unit_id').references((): AnyPgColumn => units.id, {
      onDelete: 'restrict',
    }),
    housekeepingStatus: text('housekeeping_status')
      .$type<HousekeepingStatus>()
      .notNull()
      .default('clean'),
    sortOrder: integer('sort_order').notNull().default(0),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('units_property_name_key').on(t.propertyId, t.name),
    index('units_room_type_idx').on(t.roomTypeId),
    index('units_parent_idx').on(t.parentUnitId),
    check('units_not_own_parent', sql`parent_unit_id IS NULL OR parent_unit_id <> id`),
    check(
      'units_housekeeping_status_check',
      sql.raw(`housekeeping_status IN (${sqlList(HOUSEKEEPING_STATUSES)})`),
    ),
  ],
);

export const ratePlans = pgTable(
  'rate_plans',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    currency: text('currency').notNull(),
    /** Nightly rate when no per-day rate is set. Excludes tax. */
    baseRate: money('base_rate').notNull(),
    includedOccupancy: integer('included_occupancy').notNull().default(2),
    extraAdultRate: money('extra_adult_rate').notNull().default(0),
    extraChildRate: money('extra_child_rate').notNull().default(0),
    mealPlan: text('meal_plan').$type<MealPlan>().notNull().default('room_only'),
    cancellationPolicy: jsonb('cancellation_policy')
      .$type<CancellationPolicy>()
      .notNull()
      .default(emptyJson),
    minStay: integer('min_stay').notNull().default(1),
    maxStay: integer('max_stay'),
    /** A derived plan prices off its parent: parent rate adjusted by basis points, then by an amount. */
    parentRatePlanId: uuid('parent_rate_plan_id').references((): AnyPgColumn => ratePlans.id, {
      onDelete: 'restrict',
    }),
    derivedPercentBp: integer('derived_percent_bp').notNull().default(0),
    derivedAmount: money('derived_amount').notNull().default(0),
    /** Lower and upper bounds that pricing recommendations and autopilot must respect. */
    floorRate: money('floor_rate'),
    ceilingRate: money('ceiling_rate'),
    isDefault: boolean('is_default').notNull().default(false),
    /** Sold on the direct booking site. */
    publicBookable: boolean('public_bookable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rate_plans_property_code_key').on(t.propertyId, t.code),
    index('rate_plans_room_type_idx').on(t.roomTypeId),
    check('rate_plans_meal_plan_check', sql.raw(`meal_plan IN (${sqlList(MEAL_PLANS)})`)),
    check('rate_plans_base_rate_check', sql`base_rate >= 0`),
    check(
      'rate_plans_min_stay_check',
      sql`min_stay >= 1 AND (max_stay IS NULL OR max_stay >= min_stay)`,
    ),
    check(
      'rate_plans_floor_ceiling_check',
      sql`floor_rate IS NULL OR ceiling_rate IS NULL OR floor_rate <= ceiling_rate`,
    ),
  ],
);

/** Per-day overrides of a rate plan. Absent row or null column means "use the plan default". */
export const rateDays = pgTable(
  'rate_days',
  {
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    rate: money('rate'),
    minStayArrival: integer('min_stay_arrival'),
    minStayThrough: integer('min_stay_through'),
    maxStay: integer('max_stay'),
    closedToArrival: boolean('closed_to_arrival').notNull().default(false),
    closedToDeparture: boolean('closed_to_departure').notNull().default(false),
    stopSell: boolean('stop_sell').notNull().default(false),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ratePlanId, t.date] }),
    check('rate_days_rate_check', sql`rate IS NULL OR rate >= 0`),
    check(
      'rate_days_stay_check',
      sql`(min_stay_arrival IS NULL OR min_stay_arrival >= 1) AND (min_stay_through IS NULL OR min_stay_through >= 1) AND (max_stay IS NULL OR max_stay >= 1)`,
    ),
  ],
);

/**
 * The inventory ledger: one row per room type per night. Rows are rewritten
 * from reservations, blocks and unit occupancy inside the transaction that
 * changes them, under a row lock, so the counts never drift from their sources.
 */
export const inventoryDays = pgTable(
  'inventory_days',
  {
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    total: integer('total').notNull().default(0),
    sold: integer('sold').notNull().default(0),
    blocked: integer('blocked').notNull().default(0),
    outOfOrder: integer('out_of_order').notNull().default(0),
    /** Units unavailable because a linked unit (parent or child) is occupied. */
    linked: integer('linked').notNull().default(0),
    /** Reservations beyond capacity, which only a channel or a forced action can create. */
    overbooked: integer('overbooked').notNull().default(0),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roomTypeId, t.date] }),
    index('inventory_days_property_date_idx').on(t.propertyId, t.date),
    check(
      'inventory_days_non_negative',
      sql`total >= 0 AND sold >= 0 AND blocked >= 0 AND out_of_order >= 0 AND linked >= 0 AND overbooked >= 0`,
    ),
    check('not_oversold', sql`sold + blocked + out_of_order + linked <= total`),
  ],
);
