import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, emptyJson, id, timestamptz, updatedAt } from './_shared';
import {
  CHANNEL_ADAPTERS,
  CONNECTION_STATUSES,
  REVISION_STATUSES,
  SYNC_KINDS,
  sqlList,
  type ChannelAdapterKind,
  type ConnectionStatus,
  type RevisionStatus,
  type SyncKind,
} from './enums';
import { organizations } from './identity';
import { properties, ratePlans, roomTypes } from './inventory';
import { reservations } from './reservations';

export interface ConnectionConfig {
  /** Property identifier at the aggregator. */
  externalPropertyId?: string;
  /** Overrides the aggregator base URL (used to point a connection at the simulator). */
  baseUrl?: string;
  [key: string]: unknown;
}

/** One route from a property to the outside world: the aggregator, calendar feeds, or the mailbox. */
export const channelConnections = pgTable(
  'channel_connections',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    adapter: text('adapter').$type<ChannelAdapterKind>().notNull(),
    name: text('name').notNull(),
    status: text('status').$type<ConnectionStatus>().notNull().default('pending'),
    config: jsonb('config').$type<ConnectionConfig>().notNull().default(emptyJson),
    secretsEnc: text('secrets_enc'),
    /** The adapter's own notes between runs: feed snapshots, mailbox positions. Not settings. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default(emptyJson),
    lastPushAt: timestamptz('last_push_at'),
    lastPullAt: timestamptz('last_pull_at'),
    lastSuccessAt: timestamptz('last_success_at'),
    lastError: text('last_error'),
    lastErrorAt: timestamptz('last_error_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Pushes are withheld until this time after a failure or a rate-limit response. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    fullSyncRequestedAt: timestamptz('full_sync_requested_at'),
    lastFullSyncAt: timestamptz('last_full_sync_at'),
    lastDriftCheckAt: timestamptz('last_drift_check_at'),
    lastDriftCount: integer('last_drift_count'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('channel_connections_property_adapter_key').on(t.propertyId, t.adapter),
    check(
      'channel_connections_adapter_check',
      sql.raw(`adapter IN (${sqlList(CHANNEL_ADAPTERS)})`),
    ),
    check(
      'channel_connections_status_check',
      sql.raw(`status IN (${sqlList(CONNECTION_STATUSES)})`),
    ),
  ],
);

export const channelRoomMappings = pgTable(
  'channel_room_mappings',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    externalRoomTypeId: text('external_room_type_id').notNull(),
    externalName: text('external_name'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channel_room_mappings_room_key').on(t.connectionId, t.roomTypeId),
    uniqueIndex('channel_room_mappings_external_key').on(t.connectionId, t.externalRoomTypeId),
  ],
);

export const channelRateMappings = pgTable(
  'channel_rate_mappings',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    externalRatePlanId: text('external_rate_plan_id').notNull(),
    externalName: text('external_name'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channel_rate_mappings_rate_key').on(t.connectionId, t.ratePlanId),
    uniqueIndex('channel_rate_mappings_external_key').on(t.connectionId, t.externalRatePlanId),
  ],
);

/**
 * Per-connection work list of date ranges whose values changed. It records
 * what to re-send, not the values: the dispatcher reads current values when it
 * sends, so retries and reordering are harmless.
 */
export const syncQueue = pgTable(
  'sync_queue',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SyncKind>().notNull(),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id').references(() => ratePlans.id, { onDelete: 'cascade' }),
    dateFrom: date('date_from', { mode: 'string' }).notNull(),
    /** Exclusive. */
    dateTo: date('date_to', { mode: 'string' }).notNull(),
    /** When the underlying change was committed; the monitor reports lag from this. */
    changedAt: timestamptz('changed_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('sync_queue_connection_idx').on(t.connectionId, t.id),
    check('sync_queue_kind_check', sql.raw(`kind IN (${sqlList(SYNC_KINDS)})`)),
    check('sync_queue_dates_check', sql`date_to > date_from`),
  ],
);

export const syncLog = pgTable(
  'sync_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').notNull(),
    direction: text('direction').$type<'out' | 'in'>().notNull(),
    operation: text('operation').notNull(),
    status: text('status').$type<'ok' | 'error' | 'retry'>().notNull(),
    itemCount: integer('item_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    /** Milliseconds between the change being committed and the channel accepting it. */
    lagMs: integer('lag_ms'),
    error: text('error'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('sync_log_connection_idx').on(t.connectionId, t.createdAt.desc())],
);

/**
 * Every booking message from a channel, stored before anything is done with
 * it. The unique key makes repeated deliveries of one revision a no-op.
 */
export const bookingRevisions = pgTable(
  'booking_revisions',
  {
    id: id(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => channelConnections.id, { onDelete: 'cascade' }),
    externalRevisionId: text('external_revision_id').notNull(),
    externalBookingId: text('external_booking_id').notNull(),
    channelCode: text('channel_code'),
    receivedVia: text('received_via').$type<'webhook' | 'poll' | 'import'>().notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    /** When the channel produced the revision; decides which of two revisions is newer. */
    revisionAt: timestamptz('revision_at').notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    /** The message in the PMS's own terms, as the adapter read it. What gets applied, and re-applied on a retry. */
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<RevisionStatus>().notNull().default('received'),
    appliedAt: timestamptz('applied_at'),
    ackedAt: timestamptz('acked_at'),
    ackAttempts: integer('ack_attempts').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    /** When a failed revision is tried again. Null once it is settled or retries are exhausted. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    error: text('error'),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('booking_revisions_external_key').on(t.connectionId, t.externalRevisionId),
    index('booking_revisions_booking_idx').on(t.connectionId, t.externalBookingId),
    index('booking_revisions_pending_idx')
      .on(t.status, t.receivedAt)
      .where(sql`status IN ('received', 'failed') OR acked_at IS NULL`),
    check('booking_revisions_status_check', sql.raw(`status IN (${sqlList(REVISION_STATUSES)})`)),
  ],
);

/** Raw webhook deliveries, kept for diagnosis. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    eventType: text('event_type'),
    connectionId: uuid('connection_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    processedAt: timestamptz('processed_at'),
    error: text('error'),
  },
  (t) => [index('webhook_events_source_idx').on(t.source, t.receivedAt.desc())],
);
