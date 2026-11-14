import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conversations, jobs, messages, reservations } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  addDays,
  deliverMessage,
  getConversation,
  listConversations,
  MemoryMailer,
  openConversation,
  sendMessage,
  todayIn,
  type DateString,
} from '@pms/domain';
import { createTestHotel, createTestOrg, type TestOrg } from '@pms/domain/testing';
import { ChannelError } from '../adapter';
import { handleChannexWebhook } from '../channex/webhook';
import { CHANNEL_JOBS } from '../jobs';
import { registerMessageTransports } from '../register';
import { bookingEvent, type FakeChannel, fakeChannelFor, useFakeChannels } from '../testing';
import {
  createConnection,
  saveMappings,
  updateConnection,
  type ConnectionRow,
} from './connections';
import { ingestBookingEvent } from './inbound';
import { pullThread, queueStaleThreads } from './messages';

let t: TestDatabase;
let org: TestOrg;
let connection: ConnectionRow;
let channel: FakeChannel;

const day = (offset: number): DateString => addDays(todayIn('Asia/Kolkata'), offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  useFakeChannels();
  const hotel = await createTestHotel(t.db, org);
  const created = await createConnection(t.db, org.admin, {
    propertyId: hotel.property.id,
    adapter: 'channex',
    config: { externalPropertyId: 'ext-property' },
  });
  await saveMappings(t.db, org.admin, created.id, {
    roomTypes: [{ roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' }],
    ratePlans: [{ ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' }],
  });
  connection = await updateConnection(t.db, org.admin, created.id, { status: 'active' });
  channel = fakeChannelFor(connection.id);
  channel.capabilities = { ari: true, bookings: 'webhook', messaging: true };
  registerMessageTransports(
    t.db,
    {
      INBOX_REPLY_ADDRESS: undefined,
      WHATSAPP_ACCESS_TOKEN: undefined,
      WHATSAPP_PHONE_NUMBER_ID: undefined,
      WHATSAPP_API_VERSION: 'v27.0',
    },
    new MemoryMailer(),
  );
});
afterAll(async () => {
  await t.drop();
});

let seq = 0;
/** A booking from a booking site, recorded as a reservation. */
async function otaBooking(): Promise<{ bookingId: string; reservationId: string }> {
  const bookingId = `ext-booking-${++seq}`;
  const result = await ingestBookingEvent(
    t.db,
    connection,
    bookingEvent({
      bookingId,
      revisionId: `ext-rev-${seq}`,
      guest: { firstName: 'Lena', lastName: `Fischer${seq}` },
      rooms: [
        {
          externalRoomTypeId: 'ext-std',
          externalRatePlanId: 'ext-std-bar',
          checkIn: day(10 + seq),
          checkOut: day(11 + seq),
        },
      ],
    }),
    'webhook',
  );
  return { bookingId, reservationId: result.reservationId! };
}

const jobsFor = async (threadId: string) =>
  t.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, CHANNEL_JOBS.pullMessages),
        eq(jobs.uniqueKey, `${CHANNEL_JOBS.pullMessages}:${connection.id}:${threadId}`),
      ),
    );

describe('messages from booking sites', () => {
  it('reads a conversation into the inbox under its reservation, once', async () => {
    const { bookingId, reservationId } = await otaBooking();
    const thread = channel.openThread(bookingId, 'Fischer Lena');
    channel.guestWrites(thread.threadId, 'Do you have a cot for a baby?');

    const first = await pullThread(t.db, connection.id, thread.threadId);
    expect(first).toEqual({ outcome: 'ok', fresh: 1 });
    const {
      conversations: [conversation],
    } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      reservationId,
    });
    expect(conversation).toMatchObject({
      channel: 'ota',
      externalThreadId: thread.threadId,
      connectionId: connection.id,
      propertyId: connection.propertyId,
      unreadCount: 1,
      lastMessagePreview: 'Do you have a cot for a baby?',
    });
    expect(conversation!.contactName).toMatch(/^Lena Fischer/);
    expect(conversation!.meta).toMatchObject({ provider: 'Booking.com', bookingId });

    // Reading it again, as a repeated announcement causes, adds nothing.
    expect(await pullThread(t.db, connection.id, thread.threadId)).toEqual({
      outcome: 'ok',
      fresh: 0,
    });
    expect(await pullThread(t.db, connection.id, 'no-such-thread')).toEqual({
      outcome: 'gone',
      fresh: 0,
    });
  });

  it('sends the reply through the booking site and shows what was written there directly', async () => {
    const { bookingId, reservationId } = await otaBooking();
    const thread = channel.openThread(bookingId);
    channel.guestWrites(thread.threadId, 'Is breakfast included?');
    await pullThread(t.db, connection.id, thread.threadId);
    const {
      conversations: [conversation],
    } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      reservationId,
    });
    const detail = await getConversation(t.db, org.orgId, conversation!.id);
    expect(detail).toMatchObject({ canWriteFreely: true, sendingUnavailable: null });

    const reply = await sendMessage(t.db, org.admin, conversation!.id, {
      body: 'Yes, breakfast is included.',
    });
    expect(await deliverMessage(t.db, reply.id)).toEqual({ status: 'sent' });
    expect(channel.sentMessages).toContainEqual({
      threadId: thread.threadId,
      bookingId: null,
      text: 'Yes, breakfast is included.',
    });

    // The manager answers again from the booking site's own extranet, and the guest writes back.
    thread.messages.push({
      id: 'extranet-1',
      sender: 'property',
      text: 'We also have a kettle in the room.',
      attachments: [],
      at: new Date(),
    });
    channel.guestWrites(thread.threadId, 'Perfect, thank you.');
    expect(await pullThread(t.db, connection.id, thread.threadId)).toEqual({
      outcome: 'ok',
      fresh: 2,
    });
    const after = await getConversation(t.db, org.orgId, conversation!.id);
    // Our own reply is not stored a second time when it comes back in the thread.
    expect(after.messages.map((m) => [m.direction, m.body])).toEqual([
      ['in', 'Is breakfast included?'],
      ['out', 'Yes, breakfast is included.'],
      ['out', 'We also have a kettle in the room.'],
      ['in', 'Perfect, thank you.'],
    ]);
    expect(after.conversation).toMatchObject({ status: 'open', unreadCount: 1 });
  });

  it('lets the property write first on a booking, and joins the thread the site then opens', async () => {
    const { bookingId, reservationId } = await otaBooking();
    const conversation = await openConversation(t.db, org.orgId, {
      channel: 'ota',
      reservationId,
    });
    expect(conversation.externalThreadId).toBe(`booking:${bookingId}`);
    const hello = await sendMessage(t.db, org.admin, conversation.id, {
      body: 'Welcome! Tell us your arrival time.',
    });
    await deliverMessage(t.db, hello.id);
    expect(channel.sentMessages).toContainEqual({
      threadId: null,
      bookingId,
      text: 'Welcome! Tell us your arrival time.',
    });
    const [moved] = await t.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    const threadId = moved!.externalThreadId;
    expect(threadId).toMatch(/^thread-/);

    channel.guestWrites(threadId, 'Around 3 pm.');
    await pullThread(t.db, connection.id, threadId);
    const { conversations: all } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      reservationId,
    });
    expect(all).toHaveLength(1);
    expect((await getConversation(t.db, org.orgId, conversation.id)).messages).toHaveLength(2);

    // A reservation that did not come from a booking site has no message box there.
    await t.db
      .update(reservations)
      .set({ connectionId: null })
      .where(eq(reservations.id, reservationId));
    await expect(
      openConversation(t.db, org.orgId, { channel: 'ota', reservationId }),
    ).rejects.toThrow(/came from a booking site/);
  });

  it('marks a reply failed with a plain reason when the site cannot take it', async () => {
    const { bookingId, reservationId } = await otaBooking();
    const thread = channel.openThread(bookingId);
    channel.guestWrites(thread.threadId, 'Hello');
    await pullThread(t.db, connection.id, thread.threadId);
    const {
      conversations: [conversation],
    } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      reservationId,
    });
    const reply = await sendMessage(t.db, org.admin, conversation!.id, { body: 'Hi' });
    channel.failSend = new ChannelError('forbidden', { retryable: false, status: 403 });
    expect(await deliverMessage(t.db, reply.id)).toEqual({
      status: 'failed',
      error: 'The channel manager\u2019s messages add-on is not switched on for this property.',
    });
    // An outage is retried by the job queue instead.
    const second = await sendMessage(t.db, org.admin, conversation!.id, { body: 'Hi again' });
    channel.failSend = new ChannelError('down', { retryable: true, status: 503 });
    await expect(deliverMessage(t.db, second.id)).rejects.toThrow('down');
    channel.failSend = null;
    expect(await deliverMessage(t.db, second.id)).toEqual({ status: 'sent' });
    const [row] = await t.db.select().from(messages).where(eq(messages.id, second.id));
    expect(row).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('queues a read when the channel manager announces a message, and catches up on ones it did not', async () => {
    const { bookingId } = await otaBooking();
    const announced = channel.openThread(bookingId);
    channel.guestWrites(announced.threadId, 'Announced');
    const outcome = await handleChannexWebhook(t.db, {
      event: 'message',
      property_id: 'ext-property',
      payload: {
        message: 'This text is never trusted',
        message_thread_id: announced.threadId,
        booking_id: bookingId,
      },
    });
    expect(outcome).toMatchObject({ action: 'messages_queued', connectionId: connection.id });
    expect(await jobsFor(announced.threadId)).toHaveLength(1);
    // Announced twice while the first read is still waiting: still one job.
    await handleChannexWebhook(t.db, {
      event: 'message',
      property_id: 'ext-property',
      payload: { message_thread_id: announced.threadId },
    });
    expect(await jobsFor(announced.threadId)).toHaveLength(1);
    // Nothing from the webhook body was stored as a message.
    const stored = await t.db.select().from(messages);
    expect(stored.some((m) => m.body === 'This text is never trusted')).toBe(false);

    // A thread nobody announced is found by the regular check.
    const { bookingId: quiet } = await otaBooking();
    const silent = channel.openThread(quiet);
    channel.guestWrites(silent.threadId, 'Nobody told you about me');
    const caught = await queueStaleThreads(t.db, connection.id);
    expect(caught.outcome).toBe('ok');
    expect(await jobsFor(silent.threadId)).toHaveLength(1);
    // Once read, it is not queued again until something new is said.
    await t.db.delete(jobs).where(eq(jobs.kind, CHANNEL_JOBS.pullMessages));
    for (const thread of channel.threads.values()) {
      await pullThread(t.db, connection.id, thread.threadId);
    }
    expect((await queueStaleThreads(t.db, connection.id)).queued).toBe(0);
    channel.guestWrites(silent.threadId, 'One more thing', new Date(Date.now() + 1000));
    expect((await queueStaleThreads(t.db, connection.id)).queued).toBe(1);
  });
});
