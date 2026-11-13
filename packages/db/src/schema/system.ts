import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, emptyJson, id, timestamptz } from './_shared';
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  JOB_STATUSES,
  sqlList,
  type AlertSeverity,
  type AlertStatus,
  type JobStatus,
} from './enums';

/**
 * Domain events written in the same transaction as the change they describe.
 * An insert trigger notifies listeners; the worker routes each row to the
 * channels and webhook endpoints that need it and deletes it.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    orgId: uuid('org_id').notNull(),
    propertyId: uuid('property_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_created_idx').on(t.createdAt)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    orgId: uuid('org_id').notNull(),
    propertyId: uuid('property_id'),
    kind: text('kind').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull(),
    title: text('title').notNull(),
    body: text('body'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** One open alert per key: a repeating condition updates it instead of piling up. */
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').$type<AlertStatus>().notNull().default('open'),
    occurrences: integer('occurrences').notNull().default(1),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: createdAt(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    notifiedAt: timestamptz('notified_at'),
    acknowledgedBy: uuid('acknowledged_by'),
    acknowledgedAt: timestamptz('acknowledged_at'),
    resolvedAt: timestamptz('resolved_at'),
  },
  (t) => [
    uniqueIndex('alerts_open_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`status <> 'resolved'`),
    index('alerts_org_status_idx').on(t.orgId, t.status, t.createdAt.desc()),
    check('alerts_severity_check', sql.raw(`severity IN (${sqlList(ALERT_SEVERITIES)})`)),
    check('alerts_status_check', sql.raw(`status IN (${sqlList(ALERT_STATUSES)})`)),
  ],
);

/** Background work that must survive restarts and run on exactly one worker at a time. */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(emptyJson),
    status: text('status').$type<JobStatus>().notNull().default('pending'),
    runAt: timestamptz('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /** Prevents two pending or running jobs for the same piece of work. */
    uniqueKey: text('unique_key'),
    lockedAt: timestamptz('locked_at'),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    index('jobs_due_idx')
      .on(t.runAt)
      .where(sql`status = 'pending'`),
    uniqueIndex('jobs_unique_key')
      .on(t.uniqueKey)
      .where(sql`unique_key IS NOT NULL AND status IN ('pending', 'running')`),
    index('jobs_kind_idx').on(t.kind, t.createdAt.desc()),
    check('jobs_status_check', sql.raw(`status IN (${sqlList(JOB_STATUSES)})`)),
  ],
);
