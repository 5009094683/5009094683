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
import { citext, createdAt, emptyJson, id, money, timestamptz, updatedAt } from './_shared';
import {
  AUTOMATION_TRIGGERS,
  CONVERSATION_CHANNELS,
  CONVERSATION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
  ONLINE_CHECKIN_STATUSES,
  PAYMENT_ORDER_PURPOSES,
  PAYMENT_ORDER_STATUSES,
  PROMO_KINDS,
  STORED_FILE_KINDS,
  sqlList,
  type AutomationTrigger,
  type ConversationChannel,
  type ConversationStatus,
  type MessageDirection,
  type MessageKind,
  type MessageStatus,
  type OnlineCheckinStatus,
  type PaymentOrderPurpose,
  type PaymentOrderStatus,
  type PromoKind,
  type ReservationSource,
  type StoredFileKind,
} from './enums';
import { organizations, users } from './identity';
import { properties } from './inventory';
import { folios, payments } from './operations';
import { guests, reservations } from './reservations';

/** A code a guest types on the booking site for a lower price. */
export const promoCodes = pgTable(
  'promo_codes',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null: valid at every property. */
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    code: citext('code').notNull(),
    description: text('description'),
    kind: text('kind').$type<PromoKind>().notNull(),
    /** Basis points off each night for `percent`; minor units off the stay for `amount`. */
    value: integer('value').notNull(),
    /** Currency of an `amount` code; it only applies to stays priced in it. */
    currency: text('currency'),
    /** The code can be used for bookings made in this window. Null: no limit on that side. */
    bookFrom: timestamptz('book_from'),
    bookTo: timestamptz('book_to'),
    /** Every night of the stay must fall in this window. */
    stayFrom: date('stay_from', { mode: 'string' }),
    stayTo: date('stay_to', { mode: 'string' }),
    minNights: integer('min_nights').notNull().default(1),
    /** Null: unlimited. */
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    /** Null: any rate plan sold on the website. */
    ratePlanIds: jsonb('rate_plan_ids').$type<string[]>(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('promo_codes_org_code_key').on(t.orgId, t.code),
    check('promo_codes_kind_check', sql.raw(`kind IN (${sqlList(PROMO_KINDS)})`)),
    check('promo_codes_value_check', sql`value > 0`),
    check('promo_codes_uses_check', sql`max_uses IS NULL OR max_uses > 0`),
  ],
);

/**
 * Something a guest has been asked to pay through the payment gateway: the
 * amount due on a website booking, or a payment link sent by staff. Card
 * details never reach this system; the gateway's hosted page takes them.
 */
export const paymentOrders = pgTable(
  'payment_orders',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'restrict' }),
    folioId: uuid('folio_id').references(() => folios.id, { onDelete: 'set null' }),
    purpose: text('purpose').$type<PaymentOrderPurpose>().notNull(),
    provider: text('provider').notNull(),
    /** The gateway's identifier for what is to be paid (payment link, checkout session). */
    providerOrderId: text('provider_order_id').notNull(),
    /** Where the guest pays. */
    checkoutUrl: text('checkout_url').notNull(),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    description: text('description'),
    status: text('status').$type<PaymentOrderStatus>().notNull().default('created'),
    providerPaymentId: text('provider_payment_id'),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    failureReason: text('failure_reason'),
    /** After this the guest can no longer pay it, and a booking hold it belongs to is released. */
    expiresAt: timestamptz('expires_at').notNull(),
    paidAt: timestamptz('paid_at'),
    /** When the gateway was last asked about it. */
    checkedAt: timestamptz('checked_at'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(emptyJson),
    /** Null when the guest started it on the booking site. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_orders_provider_key').on(t.provider, t.providerOrderId),
    index('payment_orders_reservation_idx').on(t.reservationId),
    index('payment_orders_open_idx')
      .on(t.expiresAt)
      .where(sql`status = 'created'`),
    check('payment_orders_status_check', sql.raw(`status IN (${sqlList(PAYMENT_ORDER_STATUSES)})`)),
    check(
      'payment_orders_purpose_check',
      sql.raw(`purpose IN (${sqlList(PAYMENT_ORDER_PURPOSES)})`),
    ),
    check('payment_orders_amount_check', sql`amount > 0`),
  ],
);

/** One thread with one guest on one channel: an email exchange, a WhatsApp chat, a booking site's message box. */
export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').$type<ConversationChannel>().notNull(),
    /** For `ota`: the connection the thread arrives through. */
    connectionId: uuid('connection_id').references(() => channelConnections.id, {
      onDelete: 'set null',
    }),
    /**
     * What identifies the thread on its channel: the booking site's thread
     * id, the guest's WhatsApp number, the guest's email address.
     */
    externalThreadId: text('external_thread_id').notNull(),
    contactName: text('contact_name').notNull(),
    /** Email address or phone number replies go to. Null for a booking site's message box. */
    contactAddress: text('contact_address'),
    subject: text('subject'),
    status: text('status').$type<ConversationStatus>().notNull().default('open'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamptz('last_message_at'),
    lastMessagePreview: text('last_message_preview'),
    /** WhatsApp only lets a business write freely for 24 hours after the guest last wrote. */
    lastInboundAt: timestamptz('last_inbound_at'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(emptyJson),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('conversations_thread_key').on(t.orgId, t.channel, t.externalThreadId),
    index('conversations_inbox_idx').on(t.orgId, t.status, t.lastMessageAt),
    index('conversations_reservation_idx').on(t.reservationId),
    index('conversations_guest_idx').on(t.guestId),
    check('conversations_channel_check', sql.raw(`channel IN (${sqlList(CONVERSATION_CHANNELS)})`)),
    check('conversations_status_check', sql.raw(`status IN (${sqlList(CONVERSATION_STATUSES)})`)),
  ],
);

export interface MessageAttachment {
  name: string;
  contentType?: string | null;
  size?: number | null;
  /** A stored file of ours, or a link the channel gave. */
  fileId?: string | null;
  url?: string | null;
}

export const messages = pgTable(
  'messages',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<MessageDirection>().notNull(),
    kind: text('kind').$type<MessageKind>().notNull().default('text'),
    body: text('body').notNull(),
    subject: text('subject'),
    attachments: jsonb('attachments')
      .$type<MessageAttachment[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The channel's id for the message: makes a repeated delivery harmless, and matches delivery receipts. */
    externalId: text('external_id'),
    status: text('status').$type<MessageStatus>().notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    /** Staff member who wrote it. Null for the guest, and for messages sent by an automatic rule. */
    sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
    senderName: text('sender_name'),
    templateKey: text('template_key'),
    automationRuleId: uuid('automation_rule_id'),
    /** Drafted by the assistant and sent after a person approved it. */
    aiDrafted: boolean('ai_drafted').notNull().default(false),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(emptyJson),
    /** Order of arrival, to keep two messages with the same timestamp in the order they came. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
    sentAt: timestamptz('sent_at'),
    deliveredAt: timestamptz('delivered_at'),
    readAt: timestamptz('read_at'),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_external_key')
      .on(t.conversationId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index('messages_queue_idx')
      .on(t.createdAt)
      .where(sql`status = 'queued'`),
    check('messages_direction_check', sql.raw(`direction IN (${sqlList(MESSAGE_DIRECTIONS)})`)),
    check('messages_kind_check', sql.raw(`kind IN (${sqlList(MESSAGE_KINDS)})`)),
    check('messages_status_check', sql.raw(`status IN (${sqlList(MESSAGE_STATUSES)})`)),
  ],
);

/**
 * Wording for a message, with `{{placeholders}}` filled in from the
 * reservation. A property's own template wins over the organisation's.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull().default('en'),
    subject: text('subject'),
    body: text('body').notNull(),
    /**
     * Name of the template approved in WhatsApp Business Manager, used when
     * the guest has not written in the last 24 hours and free text is not
     * allowed. Its variables are filled from `whatsappParams`, in order.
     */
    whatsappTemplate: text('whatsapp_template'),
    whatsappParams: jsonb('whatsapp_params')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('message_templates_key')
      .on(t.orgId, t.key, t.language)
      .where(sql`property_id IS NULL`),
    uniqueIndex('message_templates_property_key')
      .on(t.propertyId, t.key, t.language)
      .where(sql`property_id IS NOT NULL`),
  ],
);

/** Sends a template by itself at a moment in the stay. */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null: every property. */
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trigger: text('trigger').$type<AutomationTrigger>().notNull(),
    /** Days before arrival for `pre_arrival`, days after departure for `post_stay`. */
    offsetDays: integer('offset_days').notNull().default(0),
    /** Hour of the day, property time, from which a dated rule sends. */
    sendHour: integer('send_hour').notNull().default(10),
    templateKey: text('template_key').notNull(),
    /** Channels to try, in order of preference; the first the guest can be reached on is used. */
    channels: jsonb('channels').$type<ConversationChannel[]>().notNull(),
    /** Only for reservations from these sources. Null: all. */
    sources: jsonb('sources').$type<ReservationSource[]>(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('automation_rules_org_idx').on(t.orgId, t.trigger),
    check(
      'automation_rules_trigger_check',
      sql.raw(`trigger IN (${sqlList(AUTOMATION_TRIGGERS)})`),
    ),
    check('automation_rules_hour_check', sql`send_hour BETWEEN 0 AND 23`),
    check('automation_rules_offset_check', sql`offset_days BETWEEN 0 AND 365`),
  ],
);

/** One row per rule and reservation, so a rule never writes to the same guest twice. */
export const automationSends = pgTable(
  'automation_sends',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => automationRules.id, { onDelete: 'cascade' }),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    /** `skipped`: nothing was sent, and `reason` says why (no way to reach the guest, template missing). */
    status: text('status').$type<'sent' | 'skipped'>().notNull(),
    reason: text('reason'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('automation_sends_key').on(t.ruleId, t.reservationId),
    check('automation_sends_status_check', sql`status IN ('sent', 'skipped')`),
  ],
);

/**
 * What a guest filled in before arriving. The identity details are kept
 * encrypted in `dataEnc` and erased by the retention job with the rest of the
 * guest's identity data.
 */
export const onlineCheckins = pgTable(
  'online_checkins',
  {
    id: id(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    status: text('status').$type<OnlineCheckinStatus>().notNull().default('started'),
    arrivalTime: text('arrival_time'),
    guestCount: integer('guest_count').notNull().default(0),
    dataEnc: text('data_enc'),
    /** The name the guest typed to accept the house rules. */
    signatureName: text('signature_name'),
    termsAcceptedAt: timestamptz('terms_accepted_at'),
    submittedAt: timestamptz('submitted_at'),
    verifiedAt: timestamptz('verified_at'),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('online_checkins_reservation_key').on(t.reservationId),
    check(
      'online_checkins_status_check',
      sql.raw(`status IN (${sqlList(ONLINE_CHECKIN_STATUSES)})`),
    ),
  ],
);

/** A file kept in the file store: an identity document photo, a message attachment. */
export const storedFiles = pgTable(
  'stored_files',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').references(() => properties.id, { onDelete: 'set null' }),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    kind: text('kind').$type<StoredFileKind>().notNull(),
    storageKey: text('storage_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Encrypted with the application key before it was written to the store. */
    encrypted: boolean('encrypted').notNull().default(true),
    /** Null when the guest uploaded it. */
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** The retention job removes the file after this. */
    deleteAfter: timestamptz('delete_after'),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    uniqueIndex('stored_files_key').on(t.storageKey),
    index('stored_files_reservation_idx').on(t.reservationId),
    index('stored_files_retention_idx')
      .on(t.deleteAfter)
      .where(sql`deleted_at IS NULL AND delete_after IS NOT NULL`),
    check('stored_files_kind_check', sql.raw(`kind IN (${sqlList(STORED_FILE_KINDS)})`)),
  ],
);
