import { and, eq, inArray, sql } from 'drizzle-orm';
import { channelConnections, conversations, reservations, type DbOrTx } from '@pms/db';
import { enqueueJob, PermanentSendError, receiveMessage, type MessageTransport } from '@pms/domain';
import { ChannelError, type ChannelThreadSummary } from '../adapter';
import { CHANNEL_JOBS } from '../jobs';
import { adapterFor, type ConnectionRow } from './connections';

const PROVIDER_NAMES: Record<string, string> = {
  bookingcom: 'Booking.com',
  airbnb: 'Airbnb',
  expedia: 'Expedia',
  agoda: 'Agoda',
};

export function providerName(provider: string | null): string | null {
  if (!provider) return null;
  return PROVIDER_NAMES[provider.toLowerCase()] ?? provider;
}

async function connectionById(
  db: DbOrTx,
  connectionId: string,
): Promise<ConnectionRow | undefined> {
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId));
  return connection;
}

export interface ThreadPull {
  outcome: 'ok' | 'gone' | 'unsupported';
  /** Messages that were not in the inbox before. */
  fresh: number;
}

/**
 * Reads one conversation from the channel and files what is new in the inbox.
 * Run when a webhook announces a message, and for threads the regular check
 * finds have moved on. The webhook is only a nudge: every message is read
 * from the channel with our own key.
 */
export async function pullThread(
  db: DbOrTx,
  connectionId: string,
  threadId: string,
): Promise<ThreadPull> {
  const connection = await connectionById(db, connectionId);
  if (!connection) return { outcome: 'gone', fresh: 0 };
  const adapter = adapterFor(connection);
  if (!adapter.fetchThread) return { outcome: 'unsupported', fresh: 0 };
  const thread = await adapter.fetchThread(threadId);
  if (!thread) return { outcome: 'gone', fresh: 0 };

  const [reservation] = thread.bookingId
    ? await db
        .select({
          id: reservations.id,
          guestId: reservations.guestId,
          guestName: reservations.guestName,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.connectionId, connection.id),
            eq(reservations.externalId, thread.bookingId),
          ),
        )
    : [];
  // A conversation the property started on the booking, before the channel gave it a thread, becomes this thread.
  if (thread.bookingId) {
    await db
      .update(conversations)
      .set({ externalThreadId: thread.threadId })
      .where(
        and(
          eq(conversations.orgId, connection.orgId),
          eq(conversations.channel, 'ota'),
          eq(conversations.externalThreadId, `booking:${thread.bookingId}`),
          sql`NOT EXISTS (SELECT 1 FROM conversations c WHERE c.org_id = ${connection.orgId}
              AND c.channel = 'ota' AND c.external_thread_id = ${thread.threadId})`,
        ),
      );
  }

  let fresh = 0;
  for (const message of thread.messages) {
    if (message.sender === 'system' && !message.text.trim()) continue;
    const result = await receiveMessage(db, {
      orgId: connection.orgId,
      channel: 'ota',
      externalThreadId: thread.threadId,
      externalId: message.id,
      connectionId: connection.id,
      propertyId: connection.propertyId,
      reservationId: reservation?.id ?? null,
      guestId: reservation?.guestId ?? null,
      contactName: reservation?.guestName ?? thread.title ?? 'Guest',
      body: message.text,
      attachments: message.attachments.map((url, i) => ({ name: `Attachment ${i + 1}`, url })),
      receivedAt: message.at,
      // What the property wrote on the booking site itself is shown too, so the thread reads whole.
      fromProperty: message.sender !== 'guest',
      meta: {
        provider: providerName(thread.provider),
        bookingId: thread.bookingId,
        ...(message.sender === 'system' ? { system: true } : {}),
      },
    });
    if (!result.duplicate) fresh++;
  }
  // The channel's clock, not ours, decides whether a thread has moved on since it was last read.
  const latest = thread.messages.reduce<Date | null>(
    (max, m) => (!max || m.at.getTime() > max.getTime() ? m.at : max),
    null,
  );
  if (latest) {
    await db
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${latest.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(conversations.orgId, connection.orgId),
          eq(conversations.channel, 'ota'),
          eq(conversations.externalThreadId, thread.threadId),
        ),
      );
  }
  return { outcome: 'ok', fresh };
}

/**
 * Looks for conversations that have moved on without a webhook saying so and
 * queues each for reading. The safety net under the `message` webhook, run
 * with the regular booking check.
 */
export async function queueStaleThreads(
  db: DbOrTx,
  connectionId: string,
): Promise<{ outcome: 'ok' | 'unsupported' | 'unavailable'; queued: number }> {
  const connection = await connectionById(db, connectionId);
  if (!connection) return { outcome: 'unsupported', queued: 0 };
  const adapter = adapterFor(connection);
  if (!adapter.capabilities.messaging || !adapter.listThreads) {
    return { outcome: 'unsupported', queued: 0 };
  }
  let threads: ChannelThreadSummary[];
  try {
    threads = await adapter.listThreads();
  } catch (err) {
    // The message box is an add-on: a property without it answers "forbidden", which is not a fault.
    if (err instanceof ChannelError && !err.retryable) return { outcome: 'unavailable', queued: 0 };
    throw err;
  }
  if (threads.length === 0) return { outcome: 'ok', queued: 0 };
  const known = await db
    .select({ thread: conversations.externalThreadId, lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, connection.orgId),
        eq(conversations.channel, 'ota'),
        inArray(
          conversations.externalThreadId,
          threads.map((t) => t.threadId),
        ),
      ),
    );
  const seen = new Map(known.map((k) => [k.thread, k.lastMessageAt]));
  let queued = 0;
  for (const thread of threads) {
    const last = seen.get(thread.threadId);
    const moved =
      last === undefined ||
      (thread.lastMessageAt !== null && (!last || thread.lastMessageAt.getTime() > last.getTime()));
    if (!moved) continue;
    await queueThreadPull(db, connection.id, thread.threadId);
    queued++;
  }
  return { outcome: 'ok', queued };
}

export async function queueThreadPull(
  db: DbOrTx,
  connectionId: string,
  threadId: string,
): Promise<void> {
  await enqueueJob(
    db,
    CHANNEL_JOBS.pullMessages,
    { connectionId, threadId },
    { uniqueKey: `${CHANNEL_JOBS.pullMessages}:${connectionId}:${threadId}`, maxAttempts: 6 },
  );
}

/** Sends inbox replies through the booking site's own message box. */
export function otaTransport(db: DbOrTx): MessageTransport {
  return {
    channel: 'ota',
    unavailable(target) {
      return target.connectionId
        ? null
        : 'This conversation is not tied to a booking site connection.';
    },
    async send(conversation, message) {
      const connection = conversation.connectionId
        ? await connectionById(db, conversation.connectionId)
        : undefined;
      if (!connection)
        throw new PermanentSendError('The booking site connection no longer exists.');
      const adapter = adapterFor(connection);
      if (!adapter.sendMessage) {
        throw new PermanentSendError('This kind of connection has no message box.');
      }
      const onBooking = conversation.externalThreadId.startsWith('booking:');
      try {
        const sent = await adapter.sendMessage(
          onBooking
            ? { bookingId: conversation.externalThreadId.slice('booking:'.length) }
            : { threadId: conversation.externalThreadId },
          message.body,
        );
        return { externalId: sent.messageId, externalThreadId: sent.threadId };
      } catch (err) {
        if (err instanceof ChannelError && !err.retryable) {
          throw new PermanentSendError(
            err.status === 403
              ? 'The channel manager\u2019s messages add-on is not switched on for this property.'
              : err.status === 422
                ? 'This booking site does not take messages through the channel manager.'
                : err.message,
          );
        }
        throw err;
      }
    },
  };
}
