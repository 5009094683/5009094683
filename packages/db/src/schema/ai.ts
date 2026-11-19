import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
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
import { channelConnections } from './channels';
import { createdAt, emptyJson, id, money, timestamptz, updatedAt } from './_shared';
import {
  AI_ACTION_STATUSES,
  RECOMMENDATION_STATUSES,
  REVIEW_REPLY_STATUSES,
  SENTIMENTS,
  sqlList,
  type AiActionStatus,
  type RecommendationStatus,
  type ReviewReplyStatus,
  type Sentiment,
} from './enums';
import { organizations, users } from './identity';
import { properties, ratePlans, roomTypes } from './inventory';
import { reservations } from './reservations';

/**
 * One call to a language model: who asked, for which feature, and what it
 * cost. Prompts and answers are not kept here; they can contain guest data.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    feature: text('feature').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    ok: boolean('ok').notNull().default(true),
    error: text('error'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [index('ai_runs_org_idx').on(t.orgId, t.createdAt)],
);

/**
 * A change the assistant has worked out from what a user asked. Nothing is
 * changed until that same user confirms it; then it runs with their own
 * permissions and is recorded in the audit log like any other change.
 */
export const aiActions = pgTable(
  'ai_actions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    /** What will happen, in a sentence the user reads before confirming. */
    summary: text('summary').notNull(),
    status: text('status').$type<AiActionStatus>().notNull().default('proposed'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    expiresAt: timestamptz('expires_at').notNull(),
    decidedAt: timestamptz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_actions_user_idx').on(t.userId, t.createdAt),
    check('ai_actions_status_check', sql.raw(`status IN (${sqlList(AI_ACTION_STATUSES)})`)),
  ],
);

export interface RecommendationDriver {
  /** Why, in words: "Booked ahead of the usual pace", "Long weekend". */
  label: string;
  /** What it does to the rate, in basis points: 1000 is +10%. */
  effectBp: number;
}

/** A suggested rate for one rate plan on one night, with the reasons. */
export const rateRecommendations = pgTable(
  'rate_recommendations',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    currentRate: money('current_rate').notNull(),
    recommendedRate: money('recommended_rate').notNull(),
    /** Share of rooms sold now, and the share expected by the night itself, in basis points. */
    occupancyBp: integer('occupancy_bp').notNull(),
    forecastBp: integer('forecast_bp').notNull(),
    drivers: jsonb('drivers').$type<RecommendationDriver[]>().notNull(),
    /** How much there was to go on: `low` means little history, so the rules did most of the work. */
    confidence: text('confidence').$type<'low' | 'medium' | 'high'>().notNull(),
    status: text('status').$type<RecommendationStatus>().notNull().default('pending'),
    /** `autopilot` when the system applied it under the room type's standing permission. */
    appliedVia: text('applied_via').$type<'manual' | 'autopilot'>(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamptz('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rate_recommendations_pending_key')
      .on(t.ratePlanId, t.date)
      .where(sql`status = 'pending'`),
    index('rate_recommendations_property_idx').on(t.propertyId, t.date),
    check(
      'rate_recommendations_status_check',
      sql.raw(`status IN (${sqlList(RECOMMENDATION_STATUSES)})`),
    ),
  ],
);

export interface ReviewTopic {
  topic: string;
  sentiment: Sentiment;
}

/** What a guest wrote about a stay on a booking site, with what was made of it. */
export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    externalId: text('external_id').notNull(),
    /** The booking site: BDC, ABB, EXP and so on. */
    channelCode: text('channel_code'),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    otaReservationCode: text('ota_reservation_code'),
    guestName: text('guest_name'),
    /** Out of 100: a review scored 8.5 out of 10 is 85. Null when the site gave no score. */
    overallScore: integer('overall_score'),
    scores: jsonb('scores')
      .$type<{ category: string; score: number }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    content: text('content'),
    receivedAt: timestamptz('received_at').notNull(),
    /** Airbnb shows a review only once the host has reviewed the guest. */
    hidden: boolean('hidden').notNull().default(false),
    reply: text('reply'),
    replyStatus: text('reply_status').$type<ReviewReplyStatus>().notNull().default('none'),
    replyError: text('reply_error'),
    repliedAt: timestamptz('replied_at'),
    repliedBy: uuid('replied_by').references(() => users.id, { onDelete: 'set null' }),
    sentiment: text('sentiment').$type<Sentiment>(),
    topics: jsonb('topics')
      .$type<ReviewTopic[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: text('summary'),
    language: text('language'),
    /** `rules` when no language model was available. */
    analysedBy: text('analysed_by').$type<'rules' | 'llm'>(),
    analysedAt: timestamptz('analysed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reviews_external_key').on(t.connectionId, t.externalId),
    index('reviews_property_idx').on(t.propertyId, t.receivedAt),
    check(
      'reviews_sentiment_check',
      sql.raw(`sentiment IS NULL OR sentiment IN (${sqlList(SENTIMENTS)})`),
    ),
    check(
      'reviews_reply_status_check',
      sql.raw(`reply_status IN (${sqlList(REVIEW_REPLY_STATUSES)})`),
    ),
  ],
);
