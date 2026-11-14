import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, timestamptz, updatedAt } from './_shared';
import { WEBHOOK_DELIVERY_STATUSES, sqlList, type Role, type WebhookDeliveryStatus } from './enums';
import { organizations, users } from './identity';

/** A credential another system uses to call the API. Only a hash of the key is kept. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The first characters of the key, so a key can be told apart from the others in a list. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    /** What the key may do, in the same terms as a user's roles. */
    grants: jsonb('grants').$type<{ role: Role; propertyId: string | null }[]>().notNull(),
    expiresAt: timestamptz('expires_at'),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_key').on(t.keyHash), index('api_keys_org_idx').on(t.orgId)],
);

/** An address of another system that is told when something changes. */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description'),
    /** Signs every delivery. Encrypted at rest; shown once when created or replaced. */
    secretEnc: text('secret_enc').notNull(),
    /** Event kinds to send: exact kinds, `reservation.*`, or `*` for all. */
    events: jsonb('events').$type<string[]>().notNull(),
    /** Only events of these properties. Null: every property. */
    propertyIds: jsonb('property_ids').$type<string[]>(),
    active: boolean('active').notNull().default(true),
    /** Attempts that failed since the last one that worked. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamptz('last_success_at'),
    lastFailureAt: timestamptz('last_failure_at'),
    /** Set when the endpoint was switched off after failing for too long. */
    disabledReason: text('disabled_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_endpoints_org_idx').on(t.orgId)],
);

/** One event to be told to one endpoint, with how the telling went. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    /** The same for every attempt, so the receiver can recognise a repeat. */
    eventId: uuid('event_id').notNull().defaultRandom(),
    eventKind: text('event_kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: timestamptz('delivered_at'),
  },
  (t) => [
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.id.desc()),
    check(
      'webhook_deliveries_status_check',
      sql.raw(`status IN (${sqlList(WEBHOOK_DELIVERY_STATUSES)})`),
    ),
  ],
);
