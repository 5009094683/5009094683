import { and, asc, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  conversations,
  guests,
  messages,
  properties,
  reservations,
  users,
  type ConversationChannel,
  type ConversationStatus,
  type DbOrTx,
  type MessageAttachment,
  type MessageKind,
  type Transaction,
} from '@pms/db';
import { raiseAlert } from './alerts';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { DomainError, invalidState, notFound, validationError } from './errors';
import { fullName, normalizePhone } from './guests';
import { enqueueJob } from './jobs';
import { emit } from './outbox';
import { transact } from './sqlx';

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export const MESSAGE_JOBS = { send: 'message.send' } as const;

/** How many times a message is tried before it is marked failed and staff are told. */
const MAX_SEND_ATTEMPTS = 5;
/** WhatsApp lets a business write freely only this long after the guest last wrote. */
export const WHATSAPP_WINDOW_MS = 24 * 3_600_000;

const preview = (body: string): string => body.replace(/\s+/g, ' ').trim().slice(0, 160);

/** The form in which a thread is identified on its channel. */
export function threadKey(channel: ConversationChannel, address: string): string {
  if (channel === 'email') return address.trim().toLowerCase();
  if (channel === 'whatsapp') return address.replace(/\D/g, '');
  return address.trim();
}

// ---------------------------------------------------------------------------
// Messages coming in

export interface InboundMessage {
  orgId: string;
  channel: ConversationChannel;
  /** What identifies the thread on the channel: thread id, phone number, email address. */
  externalThreadId: string;
  /** The channel's id for this message. A message seen before is not stored again. */
  externalId?: string | null;
  contactName?: string | null;
  contactAddress?: string | null;
  subject?: string | null;
  body: string;
  attachments?: MessageAttachment[];
  receivedAt?: Date;
  /** Known links, when the channel says which booking the thread is about. */
  propertyId?: string | null;
  connectionId?: string | null;
  reservationId?: string | null;
  guestId?: string | null;
  meta?: Record<string, unknown>;
  /** Set for a message the property sent from somewhere else (the booking site's own inbox). */
  fromProperty?: boolean;
}

export interface Received {
  conversation: ConversationRow;
  message: MessageRow | null;
  /** True when this message had been stored before. */
  duplicate: boolean;
}

/** The guest an address belongs to and their most relevant reservation: in house, else next to arrive, else last. */
async function whoIs(
  tx: DbOrTx,
  orgId: string,
  channel: ConversationChannel,
  address: string | null | undefined,
): Promise<{
  guestId: string | null;
  reservationId: string | null;
  propertyId: string | null;
  name: string | null;
}> {
  const none = { guestId: null, reservationId: null, propertyId: null, name: null };
  if (!address || channel === 'ota') return none;
  const phone = channel === 'whatsapp' ? normalizePhone(address) : null;
  const digits = phone?.replace(/^\+/, '');
  const matches = await tx
    .select()
    .from(guests)
    .where(
      and(
        eq(guests.orgId, orgId),
        sql`${guests.anonymizedAt} IS NULL`,
        channel === 'email'
          ? eq(guests.email, address.trim().toLowerCase())
          : // Stored numbers may or may not carry the plus sign or the country code.
            sql`regexp_replace(${guests.phone}, '\\D', '', 'g') <> '' AND (
                regexp_replace(${guests.phone}, '\\D', '', 'g') = ${digits ?? ''}
                OR ${digits ?? ''} LIKE '%' || regexp_replace(${guests.phone}, '\\D', '', 'g'))
                AND length(regexp_replace(${guests.phone}, '\\D', '', 'g')) >= 8`,
      ),
    )
    .orderBy(desc(guests.updatedAt))
    .limit(5);
  if (matches.length === 0) return none;
  const ids = matches.map((g) => g.id);
  const [stay] = await tx
    .select({
      id: reservations.id,
      propertyId: reservations.propertyId,
      guestId: reservations.guestId,
    })
    .from(reservations)
    .where(and(eq(reservations.orgId, orgId), inArray(reservations.guestId, ids)))
    .orderBy(
      sql`CASE ${reservations.status} WHEN 'in_house' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'tentative' THEN 2 ELSE 3 END`,
      sql`abs(${reservations.checkIn} - current_date)`,
    )
    .limit(1);
  const guest = matches.find((g) => g.id === stay?.guestId) ?? matches[0]!;
  return {
    guestId: guest.id,
    reservationId: stay?.id ?? null,
    propertyId: stay?.propertyId ?? null,
    name: fullName(guest),
  };
}

async function findConversation(
  tx: DbOrTx,
  orgId: string,
  channel: ConversationChannel,
  externalThreadId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.channel, channel),
        eq(conversations.externalThreadId, externalThreadId),
      ),
    )
    .for('update');
  return row;
}

/**
 * Stores a message that arrived on a channel, in the conversation it belongs
 * to (created if this is the first). The same message delivered twice is
 * stored once.
 */
export async function receiveMessage(db: DbOrTx, input: InboundMessage): Promise<Received> {
  const externalThreadId = threadKey(input.channel, input.externalThreadId);
  if (!externalThreadId) throw validationError('A message needs a thread to belong to');
  const body = input.body.trim().slice(0, 20_000);
  const attachments = (input.attachments ?? []).slice(0, 20);
  if (!body && attachments.length === 0) throw validationError('The message is empty');
  const at = input.receivedAt ?? new Date();

  return transact(db, async (tx) => {
    let conversation = await findConversation(tx, input.orgId, input.channel, externalThreadId);
    if (!conversation) {
      const who = await whoIs(tx, input.orgId, input.channel, input.contactAddress);
      const [created] = await tx
        .insert(conversations)
        .values({
          orgId: input.orgId,
          channel: input.channel,
          externalThreadId,
          connectionId: input.connectionId ?? null,
          propertyId: input.propertyId ?? who.propertyId,
          guestId: input.guestId ?? who.guestId,
          reservationId: input.reservationId ?? who.reservationId,
          contactName: (
            input.contactName?.trim() ||
            who.name ||
            input.contactAddress ||
            'Guest'
          ).slice(0, 200),
          contactAddress: input.contactAddress ?? null,
          subject: input.subject?.trim().slice(0, 300) || null,
          meta: input.meta ?? {},
        })
        .onConflictDoNothing()
        .returning();
      // Lost a race with another delivery for the same new thread: use the row that won.
      conversation =
        created ?? (await findConversation(tx, input.orgId, input.channel, externalThreadId));
      if (!conversation) throw new Error('Could not open the conversation');
    }

    const [message] = await tx
      .insert(messages)
      .values({
        orgId: input.orgId,
        conversationId: conversation.id,
        direction: input.fromProperty ? 'out' : 'in',
        body: body || `[${attachments.length === 1 ? 'Attachment' : 'Attachments'}]`,
        subject: input.subject?.trim().slice(0, 300) || null,
        attachments,
        externalId: input.externalId ?? null,
        status: input.fromProperty ? 'sent' : 'received',
        senderName: input.fromProperty ? 'Sent from the channel' : conversation.contactName,
        meta: input.meta ?? {},
        createdAt: at,
        sentAt: input.fromProperty ? at : null,
      })
      .onConflictDoNothing()
      .returning();
    if (!message) return { conversation, message: null, duplicate: true };

    const newer = !conversation.lastMessageAt || at >= conversation.lastMessageAt;
    const [updated] = await tx
      .update(conversations)
      .set({
        ...(newer ? { lastMessageAt: at, lastMessagePreview: preview(message.body) } : {}),
        ...(input.fromProperty
          ? {}
          : {
              unreadCount: sql`${conversations.unreadCount} + 1`,
              // GREATEST skips a null, so this also sets the first one.
              lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${at.toISOString()}::timestamptz)`,
              // A guest writing again reopens a thread that was answered or closed.
              status: 'open' as const,
            }),
        // Links the channel supplies later (a thread that got its booking) fill in what was missing.
        reservationId: conversation.reservationId ?? input.reservationId ?? null,
        propertyId: conversation.propertyId ?? input.propertyId ?? null,
        connectionId: conversation.connectionId ?? input.connectionId ?? null,
        guestId: conversation.guestId ?? input.guestId ?? null,
      })
      .where(eq(conversations.id, conversation.id))
      .returning();
    if (!input.fromProperty) {
      await emit(tx, input.orgId, [
        {
          kind: 'message.received',
          propertyId: updated!.propertyId,
          payload: { conversationId: conversation.id, channel: input.channel },
        },
      ]);
    }
    return { conversation: updated!, message, duplicate: false };
  });
}

// ---------------------------------------------------------------------------
// Messages going out

export interface OutgoingMessage {
  body: string;
  subject?: string | null;
  /** `note`: for staff only, never sent. */
  kind?: MessageKind;
  aiDrafted?: boolean;
  templateKey?: string | null;
  automationRuleId?: string | null;
  meta?: Record<string, unknown>;
}

/** Whether free text may be sent on WhatsApp right now, or only an approved template. */
export function whatsappWindowOpen(
  conversation: Pick<ConversationRow, 'lastInboundAt'>,
  now: Date = new Date(),
): boolean {
  return (
    conversation.lastInboundAt !== null &&
    now.getTime() - conversation.lastInboundAt.getTime() < WHATSAPP_WINDOW_MS
  );
}

async function conversationForUpdate(
  tx: Transaction,
  orgId: string,
  conversationId: string,
): Promise<ConversationRow> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)))
    .for('update');
  if (!row) throw notFound('Conversation', conversationId);
  return row;
}

/**
 * Adds a message from the property to a conversation and queues it for
 * sending. The worker delivers it; the message shows as queued, then sent,
 * or failed with the reason.
 */
export async function sendMessage(
  db: DbOrTx,
  actor: Actor,
  conversationId: string,
  input: OutgoingMessage,
): Promise<MessageRow> {
  const body = input.body.trim();
  if (!body) throw validationError('Write a message first');
  if (body.length > 10_000) throw validationError('A message can be at most 10,000 characters');
  const kind = input.kind ?? 'text';
  return transact(db, async (tx) => {
    const conversation = await conversationForUpdate(tx, actor.orgId, conversationId);
    if (
      kind === 'text' &&
      conversation.channel === 'whatsapp' &&
      !input.meta?.whatsappTemplate &&
      !whatsappWindowOpen(conversation)
    ) {
      throw invalidState(
        'WhatsApp only allows free text within 24 hours of the guest\u2019s last message. Send one of the approved templates instead.',
        { reason: 'whatsapp_window_closed' },
      );
    }
    const now = new Date();
    const [message] = await tx
      .insert(messages)
      .values({
        orgId: actor.orgId,
        conversationId,
        direction: 'out',
        kind,
        body,
        subject: input.subject?.trim().slice(0, 300) || null,
        status: kind === 'note' ? 'sent' : 'queued',
        sentBy: actor.userId ?? null,
        senderName: actor.type === 'user' ? actor.label : 'Automatic message',
        aiDrafted: input.aiDrafted ?? false,
        templateKey: input.templateKey ?? null,
        automationRuleId: input.automationRuleId ?? null,
        meta: input.meta ?? {},
        createdAt: now,
        sentAt: kind === 'note' ? now : null,
      })
      .returning();
    if (kind === 'text') {
      await tx
        .update(conversations)
        .set({
          lastMessageAt: now,
          lastMessagePreview: preview(body),
          // Answered: nothing for staff to do until the guest writes again.
          status: conversation.status === 'closed' ? 'closed' : 'waiting',
          unreadCount: 0,
        })
        .where(eq(conversations.id, conversationId));
      await enqueueJob(
        tx,
        MESSAGE_JOBS.send,
        { messageId: message!.id },
        { uniqueKey: `${MESSAGE_JOBS.send}:${message!.id}`, maxAttempts: MAX_SEND_ATTEMPTS },
      );
    }
    await emit(tx, actor.orgId, [
      {
        kind: 'message.received',
        propertyId: conversation.propertyId,
        payload: { conversationId, channel: conversation.channel, direction: 'out' },
      },
    ]);
    return message!;
  });
}

export interface NewConversation {
  channel: ConversationChannel;
  /** Email address or phone number. Not needed for `ota` when `reservationId` is given. */
  address?: string | null;
  contactName?: string | null;
  reservationId?: string | null;
  guestId?: string | null;
  propertyId?: string | null;
  subject?: string | null;
}

/**
 * The conversation with a guest on a channel, created if there is none yet,
 * so the property can write first (a confirmation, a pre-arrival note).
 */
export async function openConversation(
  db: DbOrTx,
  orgId: string,
  input: NewConversation,
): Promise<ConversationRow> {
  return transact(db, async (tx) => {
    const [reservation] = input.reservationId
      ? await tx
          .select()
          .from(reservations)
          .where(and(eq(reservations.id, input.reservationId), eq(reservations.orgId, orgId)))
      : [];
    if (input.reservationId && !reservation) throw notFound('Reservation', input.reservationId);
    const guestId = input.guestId ?? reservation?.guestId ?? null;
    const [guest] = guestId
      ? await tx
          .select()
          .from(guests)
          .where(and(eq(guests.id, guestId), eq(guests.orgId, orgId)))
      : [];

    let address = input.address?.trim() || null;
    let thread: string;
    if (input.channel === 'ota') {
      if (!reservation?.connectionId || !reservation.externalId) {
        throw invalidState('Only a booking that came from a booking site can be written to there');
      }
      // Until the booking site assigns a thread, the booking itself stands in for it.
      thread = `booking:${reservation.externalId}`;
      const [existing] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.orgId, orgId),
            eq(conversations.channel, 'ota'),
            eq(conversations.reservationId, reservation.id),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1);
      if (existing) return existing;
      address = null;
    } else {
      address ??= (input.channel === 'email' ? guest?.email : guest?.phone) ?? null;
      if (!address) {
        throw validationError(
          input.channel === 'email'
            ? 'There is no email address for this guest'
            : 'There is no phone number for this guest',
        );
      }
      thread = threadKey(input.channel, address);
      if (input.channel === 'whatsapp' && thread.length < 8) {
        throw validationError('That phone number is too short to be a WhatsApp number');
      }
    }
    const existing = await findConversation(tx, orgId, input.channel, thread);
    if (existing) {
      // Writing about a newer booking moves the thread to it.
      if (reservation && existing.reservationId !== reservation.id) {
        const [moved] = await tx
          .update(conversations)
          .set({ reservationId: reservation.id, propertyId: reservation.propertyId })
          .where(eq(conversations.id, existing.id))
          .returning();
        return moved!;
      }
      return existing;
    }
    const [created] = await tx
      .insert(conversations)
      .values({
        orgId,
        channel: input.channel,
        externalThreadId: thread,
        connectionId: input.channel === 'ota' ? reservation!.connectionId : null,
        propertyId: input.propertyId ?? reservation?.propertyId ?? null,
        guestId,
        reservationId: reservation?.id ?? null,
        contactName: (
          input.contactName?.trim() ||
          reservation?.guestName ||
          (guest ? fullName(guest) : null) ||
          address ||
          'Guest'
        ).slice(0, 200),
        contactAddress: address,
        subject: input.subject?.trim().slice(0, 300) || null,
        status: 'waiting',
      })
      .returning();
    return created!;
  });
}

// ---------------------------------------------------------------------------
// Delivery

export interface TransportResult {
  /** The channel's id for the message, for matching delivery receipts. */
  externalId?: string | null;
  /** The thread the channel put it in, when that was not known before. */
  externalThreadId?: string | null;
}

export interface MessageTransport {
  readonly channel: ConversationChannel;
  /** Null when messages can be sent; otherwise why not, in words for staff. */
  unavailable(target: Pick<ConversationRow, 'contactAddress' | 'connectionId'>): string | null;
  send(conversation: ConversationRow, message: MessageRow): Promise<TransportResult>;
}

const transports = new Map<ConversationChannel, MessageTransport>();

export function registerTransport(transport: MessageTransport): void {
  transports.set(transport.channel, transport);
}

export function transportFor(channel: ConversationChannel): MessageTransport | undefined {
  return transports.get(channel);
}

/** A failure the transport knows will not go away by trying again (a bad address, a closed window). */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

export interface DeliveryOutcome {
  status: 'sent' | 'failed' | 'retry' | 'skipped';
  error?: string;
}

/**
 * Sends one queued message through its channel. Run by the worker. A failure
 * that may pass is thrown again so the job queue retries it; the last attempt,
 * or a failure that cannot pass, marks the message failed and alerts staff.
 */
export async function deliverMessage(
  db: DbOrTx,
  messageId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<DeliveryOutcome> {
  const [row] = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId));
  if (!row) return { status: 'skipped', error: 'The message no longer exists' };
  const { message, conversation } = row;
  if (message.status !== 'queued' || message.kind !== 'text' || message.direction !== 'out') {
    return { status: 'skipped' };
  }

  const fail = async (error: string): Promise<DeliveryOutcome> => {
    await db
      .update(messages)
      .set({ status: 'failed', error: error.slice(0, 1000), attempts: message.attempts + 1 })
      .where(eq(messages.id, message.id));
    await raiseAlert(db, {
      orgId: message.orgId,
      propertyId: conversation.propertyId,
      kind: 'message_failed',
      severity: 'warning',
      title: `A message to ${conversation.contactName} could not be sent`,
      body: `${error} Open the conversation in the inbox to send it again or reach the guest another way.`,
      entityType: 'conversation',
      entityId: conversation.id,
      dedupeKey: `message_failed:${conversation.id}`,
    });
    await emit(db, message.orgId, [
      {
        kind: 'message.received',
        propertyId: conversation.propertyId,
        payload: { conversationId: conversation.id, channel: conversation.channel, failed: true },
      },
    ]);
    return { status: 'failed', error };
  };

  const transport = transports.get(conversation.channel);
  if (!transport) return fail(`Sending by ${conversation.channel} is not set up.`);
  const reason = transport.unavailable(conversation);
  if (reason) return fail(reason);

  let result: TransportResult;
  try {
    result = await transport.send(conversation, message);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentSendError || options.finalAttempt) return fail(text);
    await db
      .update(messages)
      .set({ attempts: message.attempts + 1, error: text.slice(0, 1000) })
      .where(eq(messages.id, message.id));
    throw err;
  }
  await db
    .update(messages)
    .set({
      status: 'sent',
      sentAt: new Date(),
      error: null,
      attempts: message.attempts + 1,
      externalId: result.externalId ?? null,
    })
    .where(eq(messages.id, message.id));
  if (result.externalThreadId && result.externalThreadId !== conversation.externalThreadId) {
    // Ignore a clash: the thread already has its own conversation, and the next inbound message lands there.
    await db
      .update(conversations)
      .set({ externalThreadId: result.externalThreadId })
      .where(
        and(
          eq(conversations.id, conversation.id),
          sql`NOT EXISTS (SELECT 1 FROM conversations c WHERE c.org_id = ${conversation.orgId}
              AND c.channel = ${conversation.channel} AND c.external_thread_id = ${result.externalThreadId})`,
        ),
      );
  }
  await emit(db, message.orgId, [
    {
      kind: 'message.received',
      propertyId: conversation.propertyId,
      payload: { conversationId: conversation.id, channel: conversation.channel, sent: true },
    },
  ]);
  return { status: 'sent' };
}

/** Queues a failed message again, as staff ask for from the inbox. */
export async function retryMessage(
  db: DbOrTx,
  actor: Actor,
  messageId: string,
): Promise<MessageRow> {
  return transact(db, async (tx) => {
    const [message] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.orgId, actor.orgId)))
      .for('update');
    if (!message) throw notFound('Message', messageId);
    if (message.status !== 'failed')
      throw invalidState('Only a message that failed can be sent again');
    const [updated] = await tx
      .update(messages)
      .set({ status: 'queued', error: null })
      .where(eq(messages.id, messageId))
      .returning();
    await enqueueJob(
      tx,
      MESSAGE_JOBS.send,
      { messageId },
      { uniqueKey: `${MESSAGE_JOBS.send}:${messageId}`, maxAttempts: MAX_SEND_ATTEMPTS },
    );
    return updated!;
  });
}

const RECEIPT_ORDER = ['queued', 'sent', 'delivered', 'read'] as const;

/** Applies a delivery receipt from a channel. Receipts can arrive out of order; a message never goes backwards. */
export async function recordDeliveryReceipt(
  db: DbOrTx,
  input: {
    orgId?: string;
    externalId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    at?: Date;
    error?: string | null;
  },
): Promise<boolean> {
  const [message] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.externalId, input.externalId),
        eq(messages.direction, 'out'),
        input.orgId ? eq(messages.orgId, input.orgId) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!message) return false;
  const at = input.at ?? new Date();
  if (input.status === 'failed') {
    if (message.status === 'delivered' || message.status === 'read') return false;
    await db
      .update(messages)
      .set({
        status: 'failed',
        error: input.error?.slice(0, 1000) ?? 'The channel could not deliver it',
      })
      .where(eq(messages.id, message.id));
    return true;
  }
  const current = RECEIPT_ORDER.indexOf(message.status as (typeof RECEIPT_ORDER)[number]);
  const next = RECEIPT_ORDER.indexOf(input.status);
  if (current === -1 || next <= current) return false;
  await db
    .update(messages)
    .set({
      status: input.status,
      ...(input.status === 'delivered' || input.status === 'read'
        ? { deliveredAt: message.deliveredAt ?? at }
        : {}),
      ...(input.status === 'read' ? { readAt: at } : {}),
    })
    .where(eq(messages.id, message.id));
  return true;
}

// ---------------------------------------------------------------------------
// The inbox

export interface ConversationSummary extends ConversationRow {
  propertyName: string | null;
  assignedToName: string | null;
  reservationCode: string | null;
}

export interface InboxFilter {
  /** Properties the viewer may see. Conversations not yet tied to a property are shown to everyone with inbox access. */
  propertyIds: 'all' | string[];
  status?: ConversationStatus | 'active';
  channel?: ConversationChannel;
  assignedTo?: string | 'none';
  reservationId?: string;
  guestId?: string;
  search?: string;
  /** For paging: conversations whose last message is older than this. */
  before?: Date;
  limit?: number;
}

function visibleTo(propertyIds: 'all' | string[]): SQL | undefined {
  if (propertyIds === 'all') return undefined;
  if (propertyIds.length === 0) return sql`${conversations.propertyId} IS NULL`;
  return or(
    sql`${conversations.propertyId} IS NULL`,
    inArray(conversations.propertyId, propertyIds),
  );
}

export async function listConversations(
  db: DbOrTx,
  orgId: string,
  filter: InboxFilter,
): Promise<ConversationSummary[]> {
  const q = filter.search?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db
    .select({
      conversation: conversations,
      propertyName: properties.name,
      assignedToName: users.name,
      reservationCode: reservations.code,
    })
    .from(conversations)
    .leftJoin(properties, eq(properties.id, conversations.propertyId))
    .leftJoin(users, eq(users.id, conversations.assignedTo))
    .leftJoin(reservations, eq(reservations.id, conversations.reservationId))
    .where(
      and(
        eq(conversations.orgId, orgId),
        visibleTo(filter.propertyIds),
        filter.status === 'active'
          ? inArray(conversations.status, ['open', 'waiting'])
          : filter.status
            ? eq(conversations.status, filter.status)
            : undefined,
        filter.channel ? eq(conversations.channel, filter.channel) : undefined,
        filter.assignedTo === 'none'
          ? sql`${conversations.assignedTo} IS NULL`
          : filter.assignedTo
            ? eq(conversations.assignedTo, filter.assignedTo)
            : undefined,
        filter.reservationId ? eq(conversations.reservationId, filter.reservationId) : undefined,
        filter.guestId ? eq(conversations.guestId, filter.guestId) : undefined,
        filter.before ? lt(conversations.lastMessageAt, filter.before) : undefined,
        like
          ? or(
              ilike(conversations.contactName, like),
              ilike(conversations.contactAddress, like),
              ilike(conversations.lastMessagePreview, like),
              ilike(reservations.code, like),
            )
          : undefined,
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, desc(conversations.createdAt))
    .limit(Math.min(filter.limit ?? 50, 200));
  return rows.map((r) => ({
    ...r.conversation,
    propertyName: r.propertyName,
    assignedToName: r.assignedToName,
    reservationCode: r.reservationCode,
  }));
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: MessageRow[];
  /** Whether free text can be sent now (always true except on WhatsApp outside its 24 hours). */
  canWriteFreely: boolean;
  /** Why nothing can be sent on this channel at the moment, or null. */
  sendingUnavailable: string | null;
}

export async function getConversation(
  db: DbOrTx,
  orgId: string,
  conversationId: string,
  propertyIds: 'all' | string[] = 'all',
): Promise<ConversationDetail> {
  const [summary] = (
    await db
      .select({
        conversation: conversations,
        propertyName: properties.name,
        assignedToName: users.name,
        reservationCode: reservations.code,
      })
      .from(conversations)
      .leftJoin(properties, eq(properties.id, conversations.propertyId))
      .leftJoin(users, eq(users.id, conversations.assignedTo))
      .leftJoin(reservations, eq(reservations.id, conversations.reservationId))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
          visibleTo(propertyIds),
        ),
      )
  ).map((r) => ({
    ...r.conversation,
    propertyName: r.propertyName,
    assignedToName: r.assignedToName,
    reservationCode: r.reservationCode,
  }));
  if (!summary) throw notFound('Conversation', conversationId);
  const thread = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.seq))
    .limit(1000);
  const transport = transports.get(summary.channel);
  return {
    conversation: summary,
    messages: thread,
    canWriteFreely: summary.channel !== 'whatsapp' || whatsappWindowOpen(summary),
    sendingUnavailable: transport
      ? transport.unavailable(summary)
      : `Sending by ${summary.channel} is not set up.`,
  };
}

export interface ConversationPatch {
  status?: ConversationStatus;
  /** A user id, or null to unassign. */
  assignedTo?: string | null;
  reservationId?: string | null;
  propertyId?: string | null;
}

export async function updateConversation(
  db: DbOrTx,
  actor: Actor,
  conversationId: string,
  patch: ConversationPatch,
): Promise<ConversationRow> {
  return transact(db, async (tx) => {
    const before = await conversationForUpdate(tx, actor.orgId, conversationId);
    const set: Partial<typeof conversations.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.assignedTo !== undefined) {
      if (patch.assignedTo) {
        const [user] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, patch.assignedTo), eq(users.orgId, actor.orgId)));
        if (!user) throw notFound('User', patch.assignedTo);
      }
      set.assignedTo = patch.assignedTo;
    }
    if (patch.reservationId !== undefined) {
      if (patch.reservationId) {
        const [reservation] = await tx
          .select()
          .from(reservations)
          .where(
            and(eq(reservations.id, patch.reservationId), eq(reservations.orgId, actor.orgId)),
          );
        if (!reservation) throw notFound('Reservation', patch.reservationId);
        set.reservationId = reservation.id;
        set.propertyId = reservation.propertyId;
        set.guestId = before.guestId ?? reservation.guestId;
      } else {
        set.reservationId = null;
      }
    }
    if (patch.propertyId !== undefined && patch.reservationId === undefined) {
      if (patch.propertyId) {
        const [property] = await tx
          .select({ id: properties.id })
          .from(properties)
          .where(and(eq(properties.id, patch.propertyId), eq(properties.orgId, actor.orgId)));
        if (!property) throw notFound('Property', patch.propertyId);
      }
      set.propertyId = patch.propertyId;
    }
    if (Object.keys(set).length === 0) return before;
    const [after] = await tx
      .update(conversations)
      .set(set)
      .where(eq(conversations.id, conversationId))
      .returning();
    if (patch.status === 'closed' && before.status !== 'closed') {
      await writeAudit(tx, actor, {
        action: 'conversation.closed',
        entityType: 'conversation',
        entityId: conversationId,
        propertyId: after!.propertyId,
        summary: `Closed the conversation with ${before.contactName}`,
      });
    }
    await emit(tx, actor.orgId, [
      {
        kind: 'message.received',
        propertyId: after!.propertyId,
        payload: { conversationId, channel: before.channel, updated: true },
      },
    ]);
    return after!;
  });
}

export async function markConversationRead(
  db: DbOrTx,
  orgId: string,
  conversationId: string,
): Promise<void> {
  const result = await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.orgId, orgId),
        sql`${conversations.unreadCount} > 0`,
      ),
    )
    .returning({ propertyId: conversations.propertyId });
  if (result.length > 0) {
    await emit(db, orgId, [
      {
        kind: 'message.received',
        propertyId: result[0]!.propertyId,
        payload: { conversationId, read: true },
      },
    ]);
  }
}

/** Conversations with something unread, for the badge on the inbox. */
export async function unreadConversations(
  db: DbOrTx,
  orgId: string,
  propertyIds: 'all' | string[],
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        visibleTo(propertyIds),
        sql`${conversations.unreadCount} > 0`,
        inArray(conversations.status, ['open', 'waiting']),
      ),
    );
  return row?.count ?? 0;
}

/** Guards a transport against a conversation it cannot serve. */
export function requireAddress(conversation: ConversationRow): string {
  if (!conversation.contactAddress) {
    throw new DomainError('invalid_state', 'This conversation has no address to send to');
  }
  return conversation.contactAddress;
}

/**
 * The organisation a message from outside belongs to. With one organisation
 * there is nothing to decide; with several, the one that knows the sender (as
 * a guest, or from an earlier conversation), provided only one does.
 */
export async function organizationForSender(
  db: DbOrTx,
  channel: ConversationChannel,
  address: string,
): Promise<string | null> {
  const { rows: orgs } = await db.execute<{ id: string }>(
    sql`SELECT id FROM organizations LIMIT 2`,
  );
  if (orgs.length === 1) return orgs[0]!.id;
  const key = threadKey(channel, address);
  const { rows } = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id FROM conversations
    WHERE channel = ${channel} AND external_thread_id = ${key}
    UNION
    SELECT DISTINCT org_id FROM guests
    WHERE anonymized_at IS NULL AND ${
      channel === 'email'
        ? sql`email = ${key}`
        : sql`regexp_replace(phone, '\\D', '', 'g') = ${key}`
    }
    LIMIT 2
  `);
  return rows.length === 1 ? rows[0]!.org_id : null;
}
