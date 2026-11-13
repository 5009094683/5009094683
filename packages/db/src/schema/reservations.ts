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
} from 'drizzle-orm/pg-core';
import { citext, createdAt, daterange, id, money, timestamptz, updatedAt } from './_shared';
import {
  BLOCK_KINDS,
  BLOCK_SOURCES,
  GROUP_STATUSES,
  PAYMENT_COLLECT,
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
  sqlList,
  type BlockKind,
  type BlockSource,
  type GroupStatus,
  type PaymentCollect,
  type ReservationSource,
  type ReservationStatus,
} from './enums';
import { channelConnections } from './channels';
import { organizations, users } from './identity';
import { properties, ratePlans, roomTypes, units } from './inventory';

export const guests = pgTable(
  'guests',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull().default(''),
    email: citext('email'),
    phone: text('phone'),
    language: text('language'),
    nationality: text('nationality'),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    company: text('company'),
    gstin: text('gstin'),
    idType: text('id_type'),
    /** Encrypted at rest; erased by the retention job after check-out. */
    idNumberEnc: text('id_number_enc'),
    idExpiry: date('id_expiry', { mode: 'string' }),
    notes: text('notes'),
    preferences: jsonb('preferences')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    vip: boolean('vip').notNull().default(false),
    blacklisted: boolean('blacklisted').notNull().default(false),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    /** Set when retention rules have scrubbed the personal data from this profile. */
    anonymizedAt: timestamptz('anonymized_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('guests_org_email_idx').on(t.orgId, t.email),
    index('guests_org_phone_idx').on(t.orgId, t.phone),
    index('guests_org_name_idx').on(t.orgId, t.lastName, t.firstName),
  ],
);

export const reservationGroups = pgTable(
  'reservation_groups',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    contactEmail: citext('contact_email'),
    contactPhone: text('contact_phone'),
    /** Held rooms not picked up by this date are released back to general sale. */
    cutoffDate: date('cutoff_date', { mode: 'string' }),
    status: text('status').$type<GroupStatus>().notNull().default('open'),
    /** The company or travel agent the group's bookings are made for, unless a booking says otherwise. */
    companyId: uuid('company_id'),
    notes: text('notes'),
    /** When the rooms nobody had booked went back on general sale. */
    releasedAt: timestamptz('released_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reservation_groups_property_code_key').on(t.propertyId, t.code),
    index('reservation_groups_property_status_idx').on(t.propertyId, t.status),
    check('reservation_groups_status_check', sql.raw(`status IN (${sqlList(GROUP_STATUSES)})`)),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    /** Confirmation code shown to staff and guests. */
    code: text('code').notNull(),
    status: text('status').$type<ReservationStatus>().notNull(),
    source: text('source').$type<ReservationSource>().notNull(),
    /** Selling channel, e.g. BDC, ABB, EXP, AGO, MMT. Null for direct business. */
    channelCode: text('channel_code'),
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    /** Booking identifier at the connection (aggregator booking id, iCal UID, email reference). */
    externalId: text('external_id'),
    /** The channel's own confirmation number, as the guest knows it. */
    channelReservationCode: text('channel_reservation_code'),
    /** Timestamp of the newest channel revision applied; older revisions are ignored. */
    externalRevisionAt: timestamptz('external_revision_at'),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    guestName: text('guest_name').notNull(),
    checkIn: date('check_in', { mode: 'string' }).notNull(),
    checkOut: date('check_out', { mode: 'string' }).notNull(),
    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),
    currency: text('currency').notNull(),
    /** Accommodation charge before tax across all rooms and nights. */
    totalAmount: money('total_amount').notNull().default(0),
    commissionAmount: money('commission_amount').notNull().default(0),
    paymentCollect: text('payment_collect').$type<PaymentCollect>().notNull().default('property'),
    arrivalTime: text('arrival_time'),
    specialRequests: text('special_requests'),
    notes: text('notes'),
    /** Tentative reservations release their inventory when this passes. */
    holdExpiresAt: timestamptz('hold_expires_at'),
    groupId: uuid('group_id').references(() => reservationGroups.id, { onDelete: 'set null' }),
    companyId: uuid('company_id'),
    /** The promotional code the booking was made with, and what it took off the room charges before tax. */
    promoCodeId: uuid('promo_code_id'),
    promoCode: text('promo_code'),
    discountAmount: money('discount_amount').notNull().default(0),
    /** Raising this makes every link sent to the guest for this booking stop working. */
    guestTokenVersion: integer('guest_token_version').notNull().default(1),
    /** When the guest completed online check-in. */
    onlineCheckinAt: timestamptz('online_checkin_at'),
    /** Arrived over capacity (two channels sold the last room). Staff must resolve. */
    overbooked: boolean('overbooked').notNull().default(false),
    /** Created from incomplete data (calendar feed, parsed email) and awaiting staff confirmation. */
    needsReview: boolean('needs_review').notNull().default(false),
    reviewReason: text('review_reason'),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    cancelledAt: timestamptz('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
  },
  (t) => [
    uniqueIndex('reservations_code_key').on(t.code),
    uniqueIndex('reservations_connection_external_key')
      .on(t.connectionId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index('reservations_property_checkin_idx').on(t.propertyId, t.checkIn),
    index('reservations_property_checkout_idx').on(t.propertyId, t.checkOut),
    index('reservations_property_status_idx').on(t.propertyId, t.status),
    index('reservations_guest_idx').on(t.guestId),
    index('reservations_hold_idx')
      .on(t.holdExpiresAt)
      .where(sql`status = 'tentative'`),
    index('reservations_promo_idx')
      .on(t.promoCodeId)
      .where(sql`promo_code_id IS NOT NULL`),
    index('reservations_group_idx')
      .on(t.groupId)
      .where(sql`group_id IS NOT NULL`),
    check('reservations_dates_check', sql`check_out > check_in`),
    check('reservations_status_check', sql.raw(`status IN (${sqlList(RESERVATION_STATUSES)})`)),
    check('reservations_source_check', sql.raw(`source IN (${sqlList(RESERVATION_SOURCES)})`)),
    check(
      'reservations_payment_collect_check',
      sql.raw(`payment_collect IN (${sqlList(PAYMENT_COLLECT)})`),
    ),
  ],
);

export const reservationRooms = pgTable(
  'reservation_rooms',
  {
    id: id(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    ratePlanId: uuid('rate_plan_id').references(() => ratePlans.id, { onDelete: 'set null' }),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    /** Order of the room within its reservation, as entered or as the channel listed it. */
    position: integer('position').notNull().default(0),
    checkIn: date('check_in', { mode: 'string' }).notNull(),
    checkOut: date('check_out', { mode: 'string' }).notNull(),
    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),
    status: text('status').$type<ReservationStatus>().notNull(),
    guestName: text('guest_name'),
    amount: money('amount').notNull().default(0),
    externalRoomRef: text('external_room_ref'),
    checkedInAt: timestamptz('checked_in_at'),
    checkedOutAt: timestamptz('checked_out_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('reservation_rooms_reservation_idx').on(t.reservationId),
    index('reservation_rooms_type_dates_idx').on(t.roomTypeId, t.checkIn, t.checkOut),
    index('reservation_rooms_unit_idx').on(t.unitId),
    index('reservation_rooms_property_dates_idx').on(t.propertyId, t.checkIn, t.checkOut),
    check('reservation_rooms_dates_check', sql`check_out > check_in`),
    check(
      'reservation_rooms_status_check',
      sql.raw(`status IN (${sqlList(RESERVATION_STATUSES)})`),
    ),
    check('reservation_rooms_occupancy_check', sql`adults >= 1 AND children >= 0`),
  ],
);

/** Accommodation charge per room per night, before tax. Drives ADR and revenue reports. */
export const reservationNights = pgTable(
  'reservation_nights',
  {
    reservationRoomId: uuid('reservation_room_id')
      .notNull()
      .references(() => reservationRooms.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reservationRoomId, t.date] }),
    index('reservation_nights_date_idx').on(t.date),
  ],
);

/** Dates taken out of sale without a guest reservation. */
export const inventoryBlocks = pgTable(
  'inventory_blocks',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    /** Set for a block on one physical unit; null for a count taken off the room type. */
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<BlockKind>().notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    /** Exclusive: the first night back on sale. */
    endDate: date('end_date', { mode: 'string' }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    reason: text('reason'),
    notes: text('notes'),
    source: text('source').$type<BlockSource>().notNull().default('manual'),
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    /** Identifier at the source (iCal UID) so repeated imports update rather than duplicate. */
    externalRef: text('external_ref'),
    ownerId: uuid('owner_id'),
    groupId: uuid('group_id').references(() => reservationGroups.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    releasedAt: timestamptz('released_at'),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('inventory_blocks_type_dates_idx').on(t.roomTypeId, t.startDate, t.endDate),
    index('inventory_blocks_property_dates_idx').on(t.propertyId, t.startDate, t.endDate),
    index('inventory_blocks_unit_idx').on(t.unitId),
    index('inventory_blocks_group_idx')
      .on(t.groupId)
      .where(sql`group_id IS NOT NULL AND released_at IS NULL`),
    uniqueIndex('inventory_blocks_external_key')
      .on(t.connectionId, t.externalRef)
      .where(sql`external_ref IS NOT NULL AND released_at IS NULL`),
    check('inventory_blocks_dates_check', sql`end_date > start_date`),
    check('inventory_blocks_kind_check', sql.raw(`kind IN (${sqlList(BLOCK_KINDS)})`)),
    check('inventory_blocks_source_check', sql.raw(`source IN (${sqlList(BLOCK_SOURCES)})`)),
    check(
      'inventory_blocks_quantity_check',
      sql`quantity >= 1 AND (unit_id IS NULL OR quantity = 1)`,
    ),
  ],
);

/**
 * Which physical unit is taken on which nights. A database exclusion
 * constraint (added in a hand-written migration) forbids two overlapping rows
 * for the same unit, so a double booking of a physical unit cannot be stored.
 *
 * `unit_id` is always an atomic unit: booking a unit that has children writes
 * one row per child, which is what makes linked inventory conflict correctly.
 */
export const unitOccupancy = pgTable(
  'unit_occupancy',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    /** The unit that was actually sold or blocked (a parent unit, or the same as unit_id). */
    sourceUnitId: uuid('source_unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    stay: daterange('stay').notNull(),
    reservationRoomId: uuid('reservation_room_id').references(() => reservationRooms.id, {
      onDelete: 'cascade',
    }),
    blockId: uuid('block_id').references(() => inventoryBlocks.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('unit_occupancy_reservation_room_idx').on(t.reservationRoomId),
    index('unit_occupancy_block_idx').on(t.blockId),
    index('unit_occupancy_source_unit_idx').on(t.sourceUnitId),
    check('unit_occupancy_stay_check', sql`NOT isempty(stay)`),
    check(
      'unit_occupancy_one_source',
      sql`(reservation_room_id IS NOT NULL) <> (block_id IS NOT NULL)`,
    ),
  ],
);
