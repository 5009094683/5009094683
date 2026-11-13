import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  alerts,
  auditLog,
  automationRules,
  automationSends,
  conversations,
  guests,
  jobs,
  messages,
  onlineCheckins,
  organizations,
  outbox,
  reservations,
  storedFiles,
  users,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createBooking, type BookingRequest } from './booking-engine';
import { decryptBytes, encryptBytes } from './crypto';
import { addDays, todayIn } from './dates';
import { checkIn, checkOut } from './frontdesk';
import { guestToken } from './guest-links';
import {
  deliverMessage,
  getConversation,
  listAssignees,
  listConversations,
  markConversationRead,
  openConversation,
  PermanentSendError,
  receiveMessage,
  recordDeliveryReceipt,
  registerTransport,
  retryMessage,
  sendMessage,
  unreadConversations,
  updateConversation,
  type MessageTransport,
} from './inbox';
import { MemoryMailer } from './mailer';
import { ATTACHMENT_KEEP_DAYS, fetchWhatsAppMedia, readAttachment } from './message-attachments';
import {
  conversationTemplates,
  deleteAutomationRule,
  deleteTemplate,
  listAutomationRules,
  listTemplates,
  renderTemplate,
  reservationTemplates,
  runAutomations,
  saveAutomationRule,
  saveTemplate,
  sendTemplate,
  sendTemplateInConversation,
} from './messaging';
import {
  addCheckinDocument,
  getGuestCheckin,
  getStaffCheckin,
  readCheckinDocument,
  removeCheckinDocument,
  submitGuestCheckin,
  verifyOnlineCheckin,
} from './online-checkin';
import { MockGateway } from './payments/mock';
import { updateProperty } from './properties';
import { cancelReservation, createReservation, expireHolds } from './reservations';
import { deleteStoredFile, MemoryFileStore, purgeExpiredFiles, sniffContentType } from './storage';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
  type TestOrg,
} from './testing';
import { emailTransport, receiveGuestEmail, stripQuotedReply } from './transports/email';
import {
  readWhatsAppWebhook,
  verifyWhatsAppSignature,
  WhatsAppClient,
  whatsappTransport,
} from './transports/whatsapp';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;
let mailer: MemoryMailer;

const today = todayIn('Asia/Kolkata');
const day = (offset: number) => addDays(today, offset);
/** A moment on the given day at the given hour, India time. */
const at = (offset: number, hour = 12) =>
  new Date(`${day(offset)}T${String(hour).padStart(2, '0')}:00:00+05:30`);

let externalSeq = 0;

/** A transport that records what it was asked to send and can be told to fail. */
function recorder(channel: 'whatsapp' | 'ota') {
  const sent: { to: string; body: string }[] = [];
  let failWith: Error | null = null;
  const transport: MessageTransport = {
    channel,
    unavailable: () => null,
    async send(conversation, message) {
      if (failWith) throw failWith;
      sent.push({ to: conversation.externalThreadId, body: message.body });
      return { externalId: `ext-${++externalSeq}` };
    },
  };
  return { transport, sent, fail: (err: Error | null) => (failWith = err) };
}

let whatsapp: ReturnType<typeof recorder>;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 8 });
  await updateProperty(t.db, org.admin, hotel.property.id, {
    phone: '+91 832 000 0000',
    email: 'stay@seabreeze.example',
    settings: {
      bookingEngineEnabled: true,
      bookingPayment: 'none',
      bookingTerms: 'No smoking in the rooms.',
      arrivalInstructions: 'Ring the bell at the blue gate.',
    },
  });
});
afterAll(async () => {
  await t.drop();
});
beforeEach(() => {
  mailer = new MemoryMailer();
  whatsapp = recorder('whatsapp');
  registerTransport(emailTransport(t.db, mailer, { replyAddress: 'inbox@seabreeze.example' }));
  registerTransport(whatsapp.transport);
});

let guestSeq = 0;
const reserve = async (
  from: number,
  to: number,
  guest: { email?: string | null; phone?: string | null; firstName?: string } = {},
  source: 'phone' | 'ota' | 'direct' = 'phone',
) =>
  createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source,
    guest: {
      firstName: guest.firstName ?? 'Asha',
      lastName: `Rao${++guestSeq}`,
      email: guest.email === undefined ? `asha${guestSeq}@example.com` : guest.email,
      phone: guest.phone ?? null,
    },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(from),
        checkOut: day(to),
        adults: 2,
      },
    ],
  });

const pendingSends = async (messageId: string) =>
  t.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'message.send'), eq(jobs.uniqueKey, `message.send:${messageId}`)));

describe('the inbox', () => {
  it('files a guest message under the guest and their stay, once however often it is delivered', async () => {
    const reservation = await reserve(5, 7, { email: 'priya@example.com', firstName: 'Priya' });
    const incoming = {
      orgId: org.orgId,
      channel: 'email' as const,
      externalThreadId: 'Priya@Example.com',
      externalId: '<m1@mail.example>',
      contactAddress: 'priya@example.com',
      subject: 'Late arrival',
      body: 'We will arrive around 11 pm. Is that all right?',
    };
    const first = await receiveMessage(t.db, incoming);
    expect(first.duplicate).toBe(false);
    expect(first.conversation).toMatchObject({
      channel: 'email',
      externalThreadId: 'priya@example.com',
      reservationId: reservation.id,
      propertyId: hotel.property.id,
      guestId: reservation.guestId,
      status: 'open',
      unreadCount: 1,
      lastMessagePreview: 'We will arrive around 11 pm. Is that all right?',
    });
    expect(first.conversation.contactName).toMatch(/^Priya Rao/);

    const again = await receiveMessage(t.db, incoming);
    expect(again).toMatchObject({ duplicate: true, message: null });
    expect((await getConversation(t.db, org.orgId, first.conversation.id)).messages).toHaveLength(
      1,
    );

    await receiveMessage(t.db, { ...incoming, externalId: '<m2@mail.example>', body: 'Hello?' });
    expect(await unreadConversations(t.db, org.orgId, 'all')).toBeGreaterThanOrEqual(1);
    const { conversations: listed } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      search: 'priya',
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      unreadCount: 2,
      reservationCode: reservation.code,
      propertyName: hotel.property.name,
      lastReplyFailed: false,
    });
    await markConversationRead(t.db, org.orgId, first.conversation.id);
    expect(
      (await getConversation(t.db, org.orgId, first.conversation.id)).conversation.unreadCount,
    ).toBe(0);
  });

  it('shows a conversation only to people who may see its property', async () => {
    const other = await createTestHotel(t.db, org);
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '+91 98000 11111',
      contactName: 'Unknown caller',
      contactAddress: '+919800011111',
      body: 'Do you have a room tonight?',
    });
    // Nobody knows yet which property this is about: everyone with inbox access sees it.
    expect(conversation.propertyId).toBeNull();
    const scoped = { propertyIds: [other.property.id] };
    const idsSeen = async () =>
      (await listConversations(t.db, org.orgId, scoped)).conversations.map((c) => c.id);
    expect(await idsSeen()).toContain(conversation.id);
    await updateConversation(t.db, org.admin, conversation.id, {
      propertyId: hotel.property.id,
    });
    expect(await idsSeen()).not.toContain(conversation.id);
    await expect(
      getConversation(t.db, org.orgId, conversation.id, [other.property.id]),
    ).rejects.toMatchObject({ code: 'not_found' });
    // Another organisation never sees it.
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(getConversation(t.db, rival.orgId, conversation.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('queues a reply, sends it by email in the same thread, and marks the conversation answered', async () => {
    await reserve(8, 9, { email: 'vikram@example.com', firstName: 'Vikram' });
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'email',
      externalThreadId: 'vikram@example.com',
      externalId: '<q1@mail.example>',
      contactAddress: 'vikram@example.com',
      subject: 'Parking',
      body: 'Is there parking?',
      meta: { messageId: '<q1@mail.example>' },
    });
    const reply = await sendMessage(t.db, org.admin, conversation.id, {
      body: 'Yes, free parking behind the building.',
    });
    // Shown under the person's name, not their sign-in address.
    const [sender] = await t.db.select().from(users).where(eq(users.id, org.adminUserId));
    expect(reply).toMatchObject({ status: 'queued', direction: 'out', senderName: sender!.name });
    expect(reply.senderName).not.toContain('@');
    expect(await pendingSends(reply.id)).toHaveLength(1);
    const after = await getConversation(t.db, org.orgId, conversation.id);
    expect(after.conversation).toMatchObject({ status: 'waiting', unreadCount: 0 });

    expect(await deliverMessage(t.db, reply.id)).toEqual({ status: 'sent' });
    expect(mailer.last()).toMatchObject({
      to: 'vikram@example.com',
      subject: 'Re: Parking',
      text: 'Yes, free parking behind the building.',
      replyTo: 'inbox@seabreeze.example',
      inReplyTo: '<q1@mail.example>',
    });
    // Delivering again does nothing: the job may run twice.
    expect(await deliverMessage(t.db, reply.id)).toEqual({ status: 'skipped' });
    expect(mailer.sent).toHaveLength(1);

    // A note is for staff only and is never sent.
    const note = await sendMessage(t.db, org.admin, conversation.id, {
      body: 'Guest has a large SUV.',
      kind: 'note',
    });
    expect(note).toMatchObject({ kind: 'note', status: 'sent' });
    expect(await pendingSends(note.id)).toHaveLength(0);

    // The guest writing again reopens it.
    await updateConversation(t.db, org.admin, conversation.id, { status: 'closed' });
    const reopened = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'email',
      externalThreadId: 'vikram@example.com',
      externalId: '<q2@mail.example>',
      body: 'Thanks!',
    });
    expect(reopened.conversation).toMatchObject({ status: 'open', unreadCount: 1 });
  });

  it('retries a failed send, then marks the message failed and tells staff', async () => {
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800022222',
      contactAddress: '+919800022222',
      body: 'Hi',
    });
    const reply = await sendMessage(t.db, org.admin, conversation.id, { body: 'Hello!' });
    whatsapp.fail(new Error('WhatsApp could not be reached'));
    await expect(deliverMessage(t.db, reply.id)).rejects.toThrow(/could not be reached/);
    let [row] = await t.db.select().from(messages).where(eq(messages.id, reply.id));
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });

    expect(await deliverMessage(t.db, reply.id, { finalAttempt: true })).toMatchObject({
      status: 'failed',
    });
    [row] = await t.db.select().from(messages).where(eq(messages.id, reply.id));
    expect(row).toMatchObject({ status: 'failed', error: 'WhatsApp could not be reached' });
    const raised = await t.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.kind, 'message_failed'), eq(alerts.entityId, conversation.id)));
    expect(raised).toHaveLength(1);

    // Staff press "send again" once the trouble has passed.
    whatsapp.fail(null);
    await retryMessage(t.db, org.admin, reply.id);
    expect(await deliverMessage(t.db, reply.id)).toEqual({ status: 'sent' });
    expect(whatsapp.sent).toEqual([{ to: '919800022222', body: 'Hello!' }]);

    // A failure that cannot pass is not retried at all.
    const second = await sendMessage(t.db, org.admin, conversation.id, { body: 'Second' });
    whatsapp.fail(new PermanentSendError('This number is not on WhatsApp'));
    expect(await deliverMessage(t.db, second.id)).toEqual({
      status: 'failed',
      error: 'This number is not on WhatsApp',
    });
  });

  it('only lets free text go out on WhatsApp within 24 hours of the guest writing', async () => {
    const reservation = await reserve(3, 4, { phone: '+91 98000 33333' });
    const conversation = await openConversation(t.db, org.orgId, {
      channel: 'whatsapp',
      reservationId: reservation.id,
    });
    expect(conversation).toMatchObject({
      externalThreadId: '919800033333',
      reservationId: reservation.id,
    });
    await expect(
      sendMessage(t.db, org.admin, conversation.id, { body: 'Welcome!' }),
    ).rejects.toMatchObject({ details: { reason: 'whatsapp_window_closed' } });
    expect((await getConversation(t.db, org.orgId, conversation.id)).canWriteFreely).toBe(false);

    // An approved template may open the conversation.
    const opened = await sendMessage(t.db, org.admin, conversation.id, {
      body: 'Your stay begins soon.',
      meta: { whatsappTemplate: 'pre_arrival_v1', whatsappParams: ['Asha'] },
    });
    expect(opened.status).toBe('queued');

    // Once the guest answers, staff can write freely for a day.
    const answer = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800033333',
      externalId: 'wamid.1',
      body: 'Thank you',
    });
    expect(answer.conversation.id).toBe(conversation.id);
    expect((await sendMessage(t.db, org.admin, conversation.id, { body: 'See you!' })).status).toBe(
      'queued',
    );
    await t.db
      .update(conversations)
      .set({ lastInboundAt: new Date(Date.now() - 25 * 3_600_000) })
      .where(eq(conversations.id, conversation.id));
    await expect(
      sendMessage(t.db, org.admin, conversation.id, { body: 'Too late' }),
    ).rejects.toThrow(/24 hours/);
  });

  it('applies delivery receipts in any order without going backwards', async () => {
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800044444',
      contactAddress: '+919800044444',
      body: 'Hi',
    });
    const reply = await sendMessage(t.db, org.admin, conversation.id, { body: 'Hello' });
    await deliverMessage(t.db, reply.id);
    const [sent] = await t.db.select().from(messages).where(eq(messages.id, reply.id));
    const externalId = sent!.externalId!;
    expect(await recordDeliveryReceipt(t.db, { externalId, status: 'read' })).toBe(true);
    // "delivered" arriving after "read" changes nothing.
    expect(await recordDeliveryReceipt(t.db, { externalId, status: 'delivered' })).toBe(false);
    expect(await recordDeliveryReceipt(t.db, { externalId, status: 'failed' })).toBe(false);
    const [final] = await t.db.select().from(messages).where(eq(messages.id, reply.id));
    expect(final).toMatchObject({ status: 'read' });
    expect(final!.deliveredAt).not.toBeNull();
    expect(await recordDeliveryReceipt(t.db, { externalId: 'unknown', status: 'read' })).toBe(
      false,
    );
  });

  it('pages through the inbox without skipping or repeating a conversation', async () => {
    // An organisation of its own, so that nothing else is in the list.
    const quiet = await createTestOrg(t.db, 'Paging Hotels');
    const when = new Date('2026-03-01T10:00:00Z');
    const ids: string[] = [];
    // Three conversations whose last message is at the very same moment, two at other times.
    for (const [i, receivedAt] of [when, when, when, at(-3), at(-9)].entries()) {
      const { conversation } = await receiveMessage(t.db, {
        orgId: quiet.orgId,
        channel: 'whatsapp',
        externalThreadId: `9198111000${i}`,
        contactAddress: `+9198111000${i}`,
        body: `Message ${i}`,
        receivedAt,
      });
      ids.push(conversation.id);
    }
    // And two the property started, with nothing in them yet.
    for (const i of [5, 6]) {
      ids.push(
        (
          await openConversation(t.db, quiet.orgId, {
            channel: 'whatsapp',
            address: `+9198111000${i}`,
          })
        ).id,
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listConversations(t.db, quiet.orgId, {
        propertyIds: 'all',
        limit: 2,
        cursor,
      });
      expect(page.conversations.length).toBeLessThanOrEqual(2);
      seen.push(...page.conversations.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
    // The ones just started come first: they are the latest thing that happened.
    expect(new Set(seen.slice(0, 2))).toEqual(new Set(ids.slice(5)));

    await expect(
      listConversations(t.db, quiet.orgId, { propertyIds: 'all', cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('flags a conversation whose latest reply did not go out, until it does', async () => {
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800077777',
      contactAddress: '+919800077777',
      body: 'Can we check in early?',
    });
    const flagged = async () =>
      (await getConversation(t.db, org.orgId, conversation.id)).conversation.lastReplyFailed;
    const reply = await sendMessage(t.db, org.admin, conversation.id, { body: 'From noon.' });
    expect(await flagged()).toBe(false);
    whatsapp.fail(new PermanentSendError('The number is not on WhatsApp.'));
    await deliverMessage(t.db, reply.id);
    expect(await flagged()).toBe(true);
    const { conversations: listed } = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      search: '919800077777',
    });
    expect(listed[0]).toMatchObject({ id: conversation.id, lastReplyFailed: true });

    whatsapp.fail(null);
    const before = await t.db.select().from(outbox).where(eq(outbox.kind, 'message.received'));
    await retryMessage(t.db, org.admin, reply.id);
    // Sending it again is announced, so every open inbox shows it on its way.
    const after = await t.db.select().from(outbox).where(eq(outbox.kind, 'message.received'));
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)!.payload).toMatchObject({ conversationId: conversation.id, retried: true });
    await deliverMessage(t.db, reply.id);
    expect(await flagged()).toBe(false);
  });

  it('tells staff when a channel gives up on a message it had accepted', async () => {
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800088888',
      contactName: 'Meera Pillai',
      contactAddress: '+919800088888',
      body: 'Hello',
    });
    const reply = await sendMessage(t.db, org.admin, conversation.id, { body: 'Welcome' });
    await deliverMessage(t.db, reply.id);
    const [sent] = await t.db.select().from(messages).where(eq(messages.id, reply.id));
    expect(
      await recordDeliveryReceipt(t.db, {
        externalId: sent!.externalId!,
        status: 'failed',
        error: 'The phone has been unreachable for too long.',
      }),
    ).toBe(true);
    const [alert] = await t.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.kind, 'message_failed'), eq(alerts.entityId, conversation.id)));
    expect(alert).toMatchObject({ title: 'A message to Meera Pillai could not be sent' });
    expect(alert!.body).toContain('unreachable');
    expect(
      (await getConversation(t.db, org.orgId, conversation.id)).conversation.lastReplyFailed,
    ).toBe(true);
    // The same receipt again changes nothing.
    expect(
      await recordDeliveryReceipt(t.db, { externalId: sent!.externalId!, status: 'failed' }),
    ).toBe(false);
  });

  it('offers a conversation to the people who may answer guests at its property', async () => {
    const other = await createTestHotel(t.db, org);
    const desk = await createTestUser(t.db, org.orgId, {
      name: 'Deepa at the desk',
      role: 'front_desk',
      propertyId: hotel.property.id,
    });
    const elsewhere = await createTestUser(t.db, org.orgId, {
      name: 'Farid elsewhere',
      role: 'front_desk',
      propertyId: other.property.id,
    });
    const cleaner = await createTestUser(t.db, org.orgId, {
      name: 'Gita housekeeping',
      role: 'housekeeping',
      propertyId: hotel.property.id,
    });
    const here = (await listAssignees(t.db, org.orgId, hotel.property.id)).map((p) => p.id);
    expect(here).toContain(desk.id);
    expect(here).toContain(org.adminUserId);
    expect(here).not.toContain(elsewhere.id);
    expect(here).not.toContain(cleaner.id);
    // A conversation nobody has tied to a property yet can go to anyone who answers guests.
    const anywhere = (await listAssignees(t.db, org.orgId, null)).map((p) => p.id);
    expect(anywhere).toEqual(expect.arrayContaining([desk.id, elsewhere.id]));
    expect(anywhere).not.toContain(cleaner.id);
  });

  it('takes email only from guests and from people answering the inbox', async () => {
    await reserve(10, 11, { email: 'known@example.com' });
    const stranger = await receiveGuestEmail(t.db, org.orgId, {
      from: 'spam@elsewhere.example',
      subject: 'Cheap SEO',
      text: 'Buy now',
      messageId: '<spam1@x>',
    });
    expect(stranger).toBeNull();

    const fromGuest = await receiveGuestEmail(t.db, org.orgId, {
      from: 'Known@Example.com',
      fromName: 'A Known Guest',
      subject: 'Airport pickup',
      text: 'Can you arrange a pickup?\n\nOn Mon, 9 Nov 2026 at 10:00, Sea Breeze <stay@x> wrote:\n> Your booking is confirmed',
      messageId: '<g1@mail.example>',
    });
    expect(fromGuest!.message).toMatchObject({ body: 'Can you arrange a pickup?' });
    expect(fromGuest!.message!.meta).toEqual({ messageId: '<g1@mail.example>' });

    // Someone answering from another address than the one on file is still let in by the thread.
    const conversation = await openConversation(t.db, org.orgId, {
      channel: 'email',
      address: 'work@corp.example',
      contactName: 'Booker at work',
    });
    const out = await sendMessage(t.db, org.admin, conversation.id, { body: 'Your quote' });
    await deliverMessage(t.db, out.id);
    const [sent] = await t.db.select().from(messages).where(eq(messages.id, out.id));
    const viaThread = await receiveGuestEmail(t.db, org.orgId, {
      from: 'assistant@corp.example',
      text: 'Booking for my manager, please confirm.',
      messageId: '<a1@corp.example>',
      inReplyTo: sent!.externalId,
    });
    expect(viaThread).not.toBeNull();

    expect(stripQuotedReply('Yes please.\n\n-----Original Message-----\nFrom: x\nold text')).toBe(
      'Yes please.',
    );
    expect(stripQuotedReply('From: the airport we take a taxi.\nSee you.')).toBe(
      'From: the airport we take a taxi.\nSee you.',
    );
    expect(stripQuotedReply('> only a quote')).toBe('> only a quote');
  });
});

describe('templates and automatic messages', () => {
  it('fills placeholders and closes the gaps left by empty ones', () => {
    expect(
      renderTemplate(
        'Dear {{ guest_name }},\n\n{{arrival_instructions}}\n\n\nSee you on {{CHECK_IN}}.',
        {
          guest_name: 'Asha Rao',
          check_in: 'Monday',
        },
      ),
    ).toBe('Dear Asha Rao,\n\nSee you on Monday.');
  });

  it('gives an organisation the standard templates and rules once', async () => {
    const templates = await listTemplates(t.db, org.orgId);
    expect(templates.map((x) => x.key).sort()).toEqual([
      'booking_cancelled',
      'booking_confirmation',
      'check_in_day',
      'payment_request',
      'post_stay',
      'pre_arrival',
    ]);
    const rules = await listAutomationRules(t.db, org.orgId);
    expect(rules).toHaveLength(5);
    // Only what a guest who just booked expects is on from the start.
    expect(
      rules
        .filter((r) => r.active)
        .map((r) => r.trigger)
        .sort(),
    ).toEqual(['booking_cancelled', 'booking_confirmed']);
    expect(await listTemplates(t.db, org.orgId)).toHaveLength(6);

    await expect(
      saveTemplate(t.db, org.admin, {
        key: 'welcome',
        name: 'Welcome',
        body: 'Hello {{guest_nmae}}',
      }),
    ).rejects.toThrow(/Unknown placeholder: \{\{guest_nmae\}\}/);
    // A placeholder with a brace missing would reach the guest exactly as typed.
    for (const body of ['Hello {{guest_name},', 'Hello {guest_name}}', 'Hello {{ }} there']) {
      await expect(
        saveTemplate(t.db, org.admin, { key: 'welcome', name: 'Welcome', body }),
      ).rejects.toThrow(/stray \{\{ or \}\}/);
    }
    await expect(
      saveTemplate(t.db, org.admin, {
        key: 'welcome',
        name: 'Welcome',
        subject: 'Hello {{guest_name}',
        body: 'Fine {{ guest_name }}, and a single { brace } is nobody\u2019s business.',
      }),
    ).rejects.toThrow(/stray/);
  });

  it('keeps a template that an automatic message needs, switched on or not', async () => {
    const template = await saveTemplate(t.db, org.admin, {
      key: 'late_checkout',
      name: 'Late check-out',
      body: 'Dear {{guest_first_name}}, you may stay until 2 pm.',
    });
    const rule = await saveAutomationRule(t.db, org.admin, {
      name: 'Offer a late check-out',
      trigger: 'pre_arrival',
      offsetDays: 1,
      templateKey: 'late_checkout',
      channels: ['email'],
      active: false,
    });
    // Without its template the rule could never be saved again, not even to rename it.
    await expect(deleteTemplate(t.db, org.admin, template.id)).rejects.toThrow(
      /"Offer a late check-out" uses this template/,
    );
    await deleteAutomationRule(t.db, org.admin, rule.id);
    await deleteTemplate(t.db, org.admin, template.id);
    expect((await listTemplates(t.db, org.orgId)).map((x) => x.key)).not.toContain('late_checkout');
  });

  it('shows the templates for a reservation as they would be sent, with the ways each could go', async () => {
    const reservation = await reserve(30, 33, {
      email: 'tanvi@example.com',
      phone: null,
      firstName: 'Tanvi',
    });
    const { templates, values } = await reservationTemplates(t.db, org.orgId, reservation.id);
    expect(values).toMatchObject({ guest_first_name: 'Tanvi', booking_code: reservation.code });
    const confirmation = templates.find((x) => x.key === 'booking_confirmation')!;
    expect(confirmation.subject).toBe(
      `Your booking at ${hotel.property.name} is confirmed (${reservation.code})`,
    );
    expect(confirmation.body).toContain('Stay: 3 nights, 1 x Standard Room, 2 adults');
    expect(confirmation.body).not.toContain('{{');
    expect(confirmation.bodyText).toContain('{{booking_code}}');
    // The test hotel has no address on file, and the answer says so rather than leaving a hole unnoticed.
    expect(confirmation.unfilled).toEqual(['property_address']);
    // What is sent is exactly what was shown.
    const sent = await sendTemplate(t.db, org.admin, reservation.id, {
      templateKey: 'booking_confirmation',
      channels: ['email'],
    });
    expect(sent.sent!.message).toMatchObject({
      body: confirmation.body,
      subject: confirmation.subject,
    });
    // A booking made by phone has no booking site to write through, and this guest has no number.
    expect(confirmation.ways).toEqual([
      { channel: 'email', problem: null },
      { channel: 'whatsapp', problem: 'The guest has no phone number' },
    ]);
    // A payment request has nothing to ask for until a link is made.
    expect(templates.find((x) => x.key === 'payment_request')!.unfilled).toEqual(
      expect.arrayContaining(['amount', 'pay_link']),
    );
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(reservationTemplates(t.db, rival.orgId, reservation.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('confirms a website booking by email once, and a cancellation once, but not an expired hold', async () => {
    const gateway = new MockGateway(t.db, 'http://localhost:3000/api');
    const request: BookingRequest = {
      propertyCode: hotel.property.code,
      checkIn: day(20),
      checkOut: day(22),
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          adults: 2,
        },
      ],
      guest: { firstName: 'Meera', lastName: 'Nair', email: 'meera@example.com' },
      acceptTerms: true,
    };
    const booked = await createBooking(t.db, gateway, org.orgId, request);
    expect(booked.status).toBe('confirmed');

    const first = await runAutomations(t.db);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const confirmation = await t.db
      .select()
      .from(messages)
      .where(eq(messages.templateKey, 'booking_confirmation'));
    const mine = confirmation.filter((m) => m.body.includes(booked.code));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain('Dear Meera Nair,');
    expect(mine[0]!.body).toContain('Total with tax: ₹9,450');
    expect(mine[0]!.body).toContain(`/booking/${booked.token}`);
    expect(mine[0]!.subject).toBe(
      `Your booking at ${hotel.property.name} is confirmed (${booked.code})`,
    );
    await deliverMessage(t.db, mine[0]!.id);
    expect(mailer.last()).toMatchObject({ to: 'meera@example.com' });

    // Running again, even from two workers at once, sends nothing more.
    const [a, b] = await Promise.all([runAutomations(t.db), runAutomations(t.db)]);
    expect(a.sent + b.sent).toBe(0);

    const [reservation] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.code, booked.code));
    await cancelReservation(t.db, org.admin, reservation!.id, { reason: 'Guest asked' });
    await runAutomations(t.db);
    const cancelled = (
      await t.db.select().from(messages).where(eq(messages.templateKey, 'booking_cancelled'))
    ).filter((m) => m.body.includes(booked.code));
    expect(cancelled).toHaveLength(1);

    // A hold that lapses unpaid was never a booking: the guest hears nothing.
    await updateProperty(t.db, org.admin, hotel.property.id, {
      settings: { bookingEngineEnabled: true, bookingPayment: 'full' },
    });
    const held = await createBooking(t.db, gateway, org.orgId, {
      ...request,
      checkIn: day(30),
      checkOut: day(31),
      guest: { firstName: 'No', lastName: 'Show', email: 'noshow@example.com' },
    });
    await expireHolds(t.db, org.admin, new Date(Date.now() + 20 * 60_000));
    await runAutomations(t.db);
    const all = await t.db.select().from(messages);
    expect(all.filter((m) => m.body.includes(held.code))).toEqual([]);
    await updateProperty(t.db, org.admin, hotel.property.id, {
      settings: { bookingEngineEnabled: true, bookingPayment: 'none' },
    });
  });

  it('sends the pre-arrival and post-stay messages on their day, from their hour, to whoever can be reached', async () => {
    const rules = await listAutomationRules(t.db, org.orgId);
    const preArrival = rules.find((r) => r.trigger === 'pre_arrival')!;
    const postStay = rules.find((r) => r.trigger === 'post_stay')!;
    for (const rule of [preArrival, postStay]) {
      await t.db
        .update(automationRules)
        .set({ active: true })
        .where(eq(automationRules.id, rule.id));
    }
    const reachable = await reserve(40, 42, { email: 'early@example.com' });
    const noContact = await reserve(40, 42, { email: null });
    const sendsFor = async (ruleId: string, reservationId: string) =>
      t.db
        .select()
        .from(automationSends)
        .where(
          and(eq(automationSends.ruleId, ruleId), eq(automationSends.reservationId, reservationId)),
        );

    // Three days ahead: too early. Two days ahead before 10:00: not yet. From 10:00: sent.
    await runAutomations(t.db, at(37, 12));
    expect(await sendsFor(preArrival.id, reachable.id)).toEqual([]);
    await runAutomations(t.db, at(38, 9));
    expect(await sendsFor(preArrival.id, reachable.id)).toEqual([]);
    await runAutomations(t.db, at(38, 10));
    expect(await sendsFor(preArrival.id, reachable.id)).toMatchObject([{ status: 'sent' }]);
    expect(await sendsFor(preArrival.id, noContact.id)).toMatchObject([
      { status: 'skipped', reason: expect.stringMatching(/no email address/) },
    ]);
    const [message] = await t.db
      .select()
      .from(messages)
      .where(eq(messages.automationRuleId, preArrival.id));
    expect(message!.body).toContain('Ring the bell at the blue gate.');
    expect(message!.body).toMatch(/\/booking\/[\w-]+\.[\w-]+\/check-in/);

    // After the stay: the day after departure, from 11:00.
    await t.db
      .update(reservations)
      .set({ status: 'checked_out' })
      .where(eq(reservations.id, reachable.id));
    await runAutomations(t.db, at(43, 10));
    expect(await sendsFor(postStay.id, reachable.id)).toEqual([]);
    await runAutomations(t.db, at(43, 11));
    expect(await sendsFor(postStay.id, reachable.id)).toMatchObject([{ status: 'sent' }]);

    for (const rule of [preArrival, postStay]) {
      await t.db
        .update(automationRules)
        .set({ active: false })
        .where(eq(automationRules.id, rule.id));
    }
  });

  it('shows the templates of an open conversation filled in, and sends one to the address it is with', async () => {
    // The guest writes from a number that is not the one on their profile.
    const reservation = await reserve(40, 42, {
      email: 'nisha@example.com',
      phone: '+91 98000 66661',
      firstName: 'Nisha',
    });
    const { conversation } = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'whatsapp',
      externalThreadId: '919800066662',
      contactName: 'Nisha',
      contactAddress: '+919800066662',
      body: 'Hi, this is my other phone.',
      reservationId: reservation.id,
    });

    const offered = await conversationTemplates(t.db, org.orgId, conversation.id);
    const preArrival = offered.find((x) => x.key === 'pre_arrival')!;
    expect(preArrival.preferred).toBe(true);
    expect(preArrival.body).toContain('Nisha');
    expect(preArrival.body).not.toContain('{{');
    expect(preArrival.unfilled).toEqual([]);
    // Not an email: no subject line.
    expect(preArrival.subject).toBeNull();
    // A payment request has no amount or link until one is made for it.
    expect(offered.find((x) => x.key === 'payment_request')!.unfilled).toEqual(
      expect.arrayContaining(['amount', 'pay_link']),
    );

    const result = await sendTemplateInConversation(t.db, org.admin, conversation.id, {
      templateKey: 'pre_arrival',
    });
    expect(result.problems).toEqual([]);
    expect(result.sent).toMatchObject({ channel: 'whatsapp' });
    expect(result.sent!.conversation.id).toBe(conversation.id);
    expect(result.sent!.message.body).toBe(preArrival.body);
    await deliverMessage(t.db, result.sent!.message.id);
    expect(whatsapp.sent.at(-1)).toMatchObject({ to: '919800066662' });

    // Without a booking there is less to fill in, and nothing to send a template about.
    const stranger = await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'email',
      externalThreadId: 'stranger@example.org',
      contactAddress: 'stranger@example.org',
      body: 'Do you take dogs?',
      propertyId: hotel.property.id,
    });
    const loose = await conversationTemplates(t.db, org.orgId, stranger.conversation.id);
    const confirmation = loose.find((x) => x.key === 'booking_confirmation')!;
    expect(confirmation.unfilled).toEqual(expect.arrayContaining(['guest_name', 'booking_code']));
    expect(confirmation.unfilled).not.toContain('property_name');
    expect(confirmation.subject).not.toBeNull();
    const refused = await sendTemplateInConversation(t.db, org.admin, stranger.conversation.id, {
      templateKey: 'booking_confirmation',
    });
    expect(refused.sent).toBeNull();
    expect(refused.problems[0]).toContain('not linked to');
  });

  it('uses WhatsApp first when there is an approved template, otherwise falls back to email', async () => {
    const reservation = await reserve(50, 51, {
      email: 'both@example.com',
      phone: '+91 98000 55555',
    });
    const viaEmail = await sendTemplate(t.db, org.admin, reservation.id, {
      templateKey: 'pre_arrival',
      channels: ['whatsapp', 'email'],
    });
    expect(viaEmail.sent).toMatchObject({ channel: 'email' });

    await saveTemplate(
      t.db,
      org.admin,
      {
        key: 'pre_arrival',
        name: 'Before arrival',
        subject: 'Your stay',
        body: 'Dear {{guest_first_name}}, see you on {{check_in}}.',
        whatsappTemplate: 'pre_arrival_v2',
        whatsappParams: ['guest_first_name', 'check_in'],
      },
      (await listTemplates(t.db, org.orgId)).find((x) => x.key === 'pre_arrival')!.id,
    );
    const viaWhatsApp = await sendTemplate(t.db, org.admin, reservation.id, {
      templateKey: 'pre_arrival',
      channels: ['whatsapp', 'email'],
    });
    expect(viaWhatsApp.sent).toMatchObject({ channel: 'whatsapp' });
    expect(viaWhatsApp.sent!.message.meta).toMatchObject({
      whatsappTemplate: 'pre_arrival_v2',
      whatsappParams: ['Asha', expect.stringMatching(/\d{4}$/)],
    });

    const nobody = await reserve(50, 51, { email: null });
    const none = await sendTemplate(t.db, org.admin, nobody.id, {
      templateKey: 'pre_arrival',
      channels: ['whatsapp', 'email'],
    });
    expect(none.sent).toBeNull();
    expect(none.problems).toEqual([
      'The guest has no phone number',
      'The guest has no email address',
    ]);

    await expect(
      saveAutomationRule(t.db, org.admin, {
        name: 'Bad',
        trigger: 'pre_arrival',
        offsetDays: 0,
        templateKey: 'pre_arrival',
        channels: ['email'],
      }),
    ).rejects.toThrow(/at least one day ahead/);
  });
});

describe('online check-in', () => {
  const form = {
    arrivalTime: '15:30',
    guests: [
      {
        name: 'Asha Rao',
        nationality: 'IN',
        idType: 'aadhaar' as const,
        idNumber: '1234 5678 9012',
        dateOfBirth: '1990-04-12',
      },
      { name: 'Ravi Rao', nationality: 'IN' },
    ],
    signatureName: 'Asha Rao',
    acceptTerms: true,
  };
  const tokenOf = async (reservationId: string) => {
    const [row] = await t.db.select().from(reservations).where(eq(reservations.id, reservationId));
    return guestToken(row!);
  };

  it('opens a week before arrival and takes the guests\u2019 details, encrypted', async () => {
    const far = await reserve(20, 22);
    expect(await getGuestCheckin(t.db, await tokenOf(far.id))).toMatchObject({
      status: 'not_started',
      open: false,
      reason: 'Online check-in opens 7 days before arrival',
      // The page can say when to come back.
      opensOn: day(13),
    });

    const reservation = await reserve(2, 4);
    const token = await tokenOf(reservation.id);
    expect(await getGuestCheckin(t.db, token)).toMatchObject({
      open: true,
      opensOn: null,
      expectedGuests: 2,
      terms: 'No smoking in the rooms.',
      propertyCountry: 'IN',
    });

    await expect(submitGuestCheckin(t.db, token, { ...form, acceptTerms: false })).rejects.toThrow(
      /house rules/,
    );
    await expect(
      submitGuestCheckin(t.db, token, { ...form, guests: [{ name: 'Asha Rao' }] }),
    ).rejects.toThrow(/identity document/);
    await expect(
      submitGuestCheckin(t.db, token, {
        ...form,
        guests: [
          { name: 'John Smith', nationality: 'GB', idType: 'driving_licence', idNumber: 'X1' },
        ],
      }),
    ).rejects.toThrow(/must give a passport/);

    const saved = await submitGuestCheckin(t.db, token, form, { ip: '203.0.113.9' });
    expect(saved).toMatchObject({ status: 'submitted', arrivalTime: '15:30' });
    // The guest sees only the end of the number they typed.
    expect(saved.guests[0]).toMatchObject({ name: 'Asha Rao', idNumberEnding: '••••9012' });
    expect(saved.guests[0]).not.toHaveProperty('idNumber');

    const [row] = await t.db
      .select()
      .from(onlineCheckins)
      .where(eq(onlineCheckins.reservationId, reservation.id));
    expect(row!.dataEnc).not.toContain('1234');
    expect(row).toMatchObject({ guestCount: 2, signatureName: 'Asha Rao', ip: '203.0.113.9' });
    const [updated] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservation.id));
    expect(updated!.onlineCheckinAt).not.toBeNull();
    expect(updated!.arrivalTime).toBe('15:30');
    // The booker's profile gained the document, encrypted.
    const [profile] = await t.db.select().from(guests).where(eq(guests.id, reservation.guestId!));
    expect(profile).toMatchObject({ idType: 'aadhaar', nationality: 'IN' });
    expect(profile!.idNumberEnc).not.toContain('1234');
  });

  it('shows staff the details masked, reveals them on request with an audit entry, and locks them once checked', async () => {
    const reservation = await reserve(1, 3);
    const token = await tokenOf(reservation.id);
    await submitGuestCheckin(t.db, token, form);

    const masked = await getStaffCheckin(t.db, org.admin, reservation.id);
    expect(masked.guests[0]).toMatchObject({ idNumber: null, idNumberEnding: '••••9012' });
    const revealed = await getStaffCheckin(t.db, org.admin, reservation.id, { reveal: true });
    expect(revealed.guests[0]!.idNumber).toBe('1234 5678 9012');
    const viewed = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'guest.id_viewed'), eq(auditLog.entityId, reservation.id)));
    expect(viewed).toHaveLength(1);

    // The guest may correct it until the front desk has checked it. A number left empty keeps
    // the one saved; changing the kind of document needs the new number.
    const corrected = await submitGuestCheckin(t.db, token, {
      ...form,
      arrivalTime: '18:00',
      guests: [{ name: 'Asha R. Rao', nationality: 'IN', idType: 'aadhaar' }, { name: 'Ravi Rao' }],
    });
    expect(corrected.guests[0]).toMatchObject({ name: 'Asha R. Rao', idNumberEnding: '••••9012' });
    expect(
      (await getStaffCheckin(t.db, org.admin, reservation.id, { reveal: true })).guests[0]!
        .idNumber,
    ).toBe('1234 5678 9012');
    await expect(
      submitGuestCheckin(t.db, token, {
        ...form,
        guests: [{ name: 'Asha Rao', nationality: 'IN', idType: 'passport' }],
      }),
    ).rejects.toThrow(/identity document/);
    await verifyOnlineCheckin(t.db, org.admin, reservation.id);
    await expect(submitGuestCheckin(t.db, token, form)).rejects.toThrow(/already checked/);
    expect(await getGuestCheckin(t.db, token)).toMatchObject({ status: 'verified', open: false });
    // Nor can a document be added behind the front desk's back.
    await expect(
      addCheckinDocument(t.db, new MemoryFileStore(), token, {
        fileName: 'late.jpg',
        data: Buffer.from('ffd8ffe000104a464946', 'hex'),
      }),
    ).rejects.toThrow(/already checked/);
    // Staff see who checked the details.
    const [checker] = await t.db.select().from(users).where(eq(users.id, org.adminUserId));
    expect(await getStaffCheckin(t.db, org.admin, reservation.id)).toMatchObject({
      status: 'verified',
      verifiedByName: checker!.name,
      restricted: false,
    });
    await expect(verifyOnlineCheckin(t.db, org.admin, reservation.id)).rejects.toThrow(
      /no online check-in waiting/,
    );
  });

  it('knows each guest again when the list is changed, so a saved number stays with its owner', async () => {
    const reservation = await reserve(3, 5);
    const token = await tokenOf(reservation.id);
    const first = await submitGuestCheckin(t.db, token, {
      ...form,
      guests: [
        { name: 'Asha Rao', nationality: 'IN', idType: 'aadhaar', idNumber: '1111 2222 3333' },
        { name: 'Ravi Rao', nationality: 'IN', idType: 'voter_id', idNumber: 'RVR7654321' },
        { name: 'Mira Rao', nationality: 'IN', idType: 'aadhaar', idNumber: '4444 5555 6666' },
      ],
    });
    const [asha, ravi, mira] = first.guests;
    expect(new Set([asha!.key, ravi!.key, mira!.key]).size).toBe(3);

    // Ravi is not coming after all; Mira moves up; a friend is added. No number is typed again.
    const second = await submitGuestCheckin(t.db, token, {
      ...form,
      guests: [
        { key: asha!.key, name: 'Asha Rao', nationality: 'IN', idType: 'aadhaar' },
        { key: mira!.key, name: 'Mira Rao', nationality: 'IN', idType: 'aadhaar' },
        { name: 'Zoya Khan', nationality: 'IN' },
      ],
    });
    expect(second.guests.map((g) => [g.name, g.idNumberEnding])).toEqual([
      ['Asha Rao', '\u2022\u2022\u2022\u20223333'],
      ['Mira Rao', '\u2022\u2022\u2022\u20226666'],
      ['Zoya Khan', null],
    ]);
    expect(second.guests[1]!.key).toBe(mira!.key);
    expect(second.guests[2]!.key).not.toBe(ravi!.key);

    // A key from somewhere else earns nothing, and the same guest cannot be sent twice.
    await expect(
      submitGuestCheckin(t.db, token, {
        ...form,
        guests: [
          { key: 'someone-elses-key', name: 'Asha Rao', nationality: 'IN', idType: 'aadhaar' },
        ],
      }),
    ).rejects.toThrow(/identity document/);
    await expect(
      submitGuestCheckin(t.db, token, {
        ...form,
        guests: [
          { key: asha!.key, name: 'Asha Rao', nationality: 'IN', idType: 'aadhaar' },
          { key: asha!.key, name: 'Asha Rao', nationality: 'IN', idType: 'aadhaar' },
        ],
      }),
    ).rejects.toThrow(/appears twice/);
  });

  it('shows someone who may not see guest details only that the form is in, and by whom', async () => {
    const reservation = await reserve(2, 3);
    await submitGuestCheckin(t.db, await tokenOf(reservation.id), form);
    const housekeeper = await createTestUser(t.db, org.orgId, {
      role: 'housekeeping',
      propertyId: hotel.property.id,
    });
    const seen = await getStaffCheckin(t.db, housekeeper.actor, reservation.id);
    expect(seen).toMatchObject({ status: 'submitted', restricted: true, documents: [] });
    expect(seen.guests).toEqual([
      { name: 'Asha Rao', idNumber: null, visaNumber: null, idNumberEnding: null },
      { name: 'Ravi Rao', idNumber: null, visaNumber: null, idNumberEnding: null },
    ]);
    expect(JSON.stringify(seen)).not.toContain('1990-04-12');
  });

  it('keeps identity documents encrypted, takes only photos and PDFs, and removes them when their time is up', async () => {
    await t.db
      .update(organizations)
      .set({ settings: { guestIdRetentionDays: 30 } })
      .where(eq(organizations.id, org.orgId));
    const store = new MemoryFileStore();
    const reservation = await reserve(1, 2);
    const token = await tokenOf(reservation.id);
    const jpeg = Buffer.concat([
      Buffer.from('ffd8ffe000104a464946', 'hex'),
      Buffer.from('passport photo'),
    ]);

    const document = await addCheckinDocument(t.db, store, token, {
      fileName: '../../etc/passport front.jpg',
      data: jpeg,
    });
    expect(document).toMatchObject({ fileName: 'passport front.jpg', contentType: 'image/jpeg' });
    const [row] = await t.db.select().from(storedFiles).where(eq(storedFiles.id, document.id));
    expect(row!.deleteAfter!.toISOString().slice(0, 10)).toBe(addDays(day(2), 30));
    // What is on disk is not the photo.
    const onDisk = [...store.files.values()][0]!;
    expect(onDisk.includes(Buffer.from('passport photo'))).toBe(false);
    expect(decryptBytes(onDisk).equals(jpeg)).toBe(true);

    // A program renamed to look like a photo is refused: the content decides.
    await expect(
      addCheckinDocument(t.db, store, token, {
        fileName: 'photo.jpg',
        data: Buffer.from('MZ\x90\x00 this is an executable'),
      }),
    ).rejects.toThrow(/Only JPEG, PNG and WebP photos and PDF files/);
    expect(sniffContentType(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');

    const read = await readCheckinDocument(t.db, store, org.admin, reservation.id, document.id);
    expect(read.data.equals(jpeg)).toBe(true);
    // A document of one booking cannot be read through another.
    const other = await reserve(1, 2);
    await expect(
      readCheckinDocument(t.db, store, org.admin, other.id, document.id),
    ).rejects.toMatchObject({ code: 'not_found' });

    // The guest can take one back.
    const second = await addCheckinDocument(t.db, store, token, { fileName: 'b.jpg', data: jpeg });
    await removeCheckinDocument(t.db, store, token, second.id);
    expect((await getGuestCheckin(t.db, token)).documents.map((d) => d.id)).toEqual([document.id]);

    // The retention job removes the file itself, not just the record.
    expect(await purgeExpiredFiles(t.db, store, new Date(`${addDays(day(2), 29)}T00:00:00Z`))).toBe(
      0,
    );
    expect(await purgeExpiredFiles(t.db, store, new Date(`${addDays(day(2), 31)}T00:00:00Z`))).toBe(
      1,
    );
    expect(store.files.size).toBe(0);
    await expect(
      readCheckinDocument(t.db, store, org.admin, reservation.id, document.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(() => decryptBytes(Buffer.from('not ours'))).toThrow(/unknown format/);
    expect(decryptBytes(encryptBytes(Buffer.alloc(0))).length).toBe(0);
  });

  it('closes once the guest has arrived', async () => {
    const reservation = await reserve(0, 1);
    const token = await tokenOf(reservation.id);
    await submitGuestCheckin(t.db, token, form);
    await checkIn(t.db, org.admin, reservation.id, {});
    expect(await getGuestCheckin(t.db, token)).toMatchObject({
      open: false,
      reason: 'You have already checked in at the property',
    });
    await checkOut(t.db, org.admin, reservation.id, { balance: 'leave_open' });
    await expect(submitGuestCheckin(t.db, token, form)).rejects.toThrow(/already checked in/);
  });
});

describe('what guests send with a message', () => {
  const PNG = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('a photo of a passport, as far as this test is concerned'),
  ]);

  it('keeps photos and PDFs from an email encrypted, and leaves anything else as a name', async () => {
    const store = new MemoryFileStore();
    const reservation = await reserve(60, 62, { email: 'sender@example.com', firstName: 'Kiran' });
    const received = await receiveGuestEmail(
      t.db,
      org.orgId,
      {
        from: 'sender@example.com',
        subject: 'Our documents',
        text: 'Attached as asked.',
        messageId: 'att-1@mail.example',
        attachments: [
          { name: '../../passport.png', contentType: 'image/png', size: PNG.length, content: PNG },
          {
            name: 'itinerary.docx',
            contentType: 'application/msword',
            size: 4,
            content: Buffer.from('PK\u0003\u0004'),
          },
          // Too large to have been carried along: a name only.
          { name: 'video.mov', contentType: 'video/quicktime', size: 50_000_000 },
        ],
      },
      store,
    );
    const message = received!.message!;
    const detail = await getConversation(t.db, org.orgId, received!.conversation.id);
    const [photo, document, video] = detail.messages[0]!.attachments;
    expect(photo).toMatchObject({ name: '../../passport.png', contentType: 'image/png' });
    expect(photo!.fileId).toBeTruthy();
    expect(document!.fileId ?? null).toBeNull();
    expect(video!.fileId ?? null).toBeNull();

    const [file] = await t.db.select().from(storedFiles).where(eq(storedFiles.id, photo!.fileId!));
    expect(file).toMatchObject({
      kind: 'message_attachment',
      reservationId: reservation.id,
      guestId: reservation.guestId,
      // Nothing of the path the sender gave survives.
      fileName: 'passport.png',
      encrypted: true,
    });
    // On disk it is not readable without the key.
    expect((await store.get(file!.storageKey)).includes(PNG.subarray(8))).toBe(false);
    const days = (file!.deleteAfter!.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(ATTACHMENT_KEEP_DAYS);

    const read = await readAttachment(t.db, store, org.orgId, message.id, photo!.fileId!);
    expect(read.data.equals(PNG)).toBe(true);
    // A file is read through its message: another message's id does not open it.
    const other = await receiveGuestEmail(
      t.db,
      org.orgId,
      { from: 'sender@example.com', text: 'One more thing.', messageId: 'att-2@mail.example' },
      store,
    );
    await expect(
      readAttachment(t.db, store, org.orgId, other!.message!.id, photo!.fileId!),
    ).rejects.toMatchObject({ code: 'not_found' });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      readAttachment(t.db, store, rival.orgId, message.id, photo!.fileId!),
    ).rejects.toMatchObject({ code: 'not_found' });

    // The same email delivered again keeps nothing twice.
    const before = (await t.db.select().from(storedFiles)).length;
    await receiveGuestEmail(
      t.db,
      org.orgId,
      {
        from: 'sender@example.com',
        text: 'Attached as asked.',
        messageId: 'att-1@mail.example',
        attachments: [{ name: 'passport.png', contentType: 'image/png', content: PNG }],
      },
      store,
    );
    expect((await t.db.select().from(storedFiles)).length).toBe(before);

    // Once its time is up the thread says so instead of offering it.
    await deleteStoredFile(t.db, store, photo!.fileId!);
    const later = await getConversation(t.db, org.orgId, received!.conversation.id);
    expect(later.messages[0]!.attachments[0]).toMatchObject({ fileId: null, expired: true });
    await expect(
      readAttachment(t.db, store, org.orgId, message.id, photo!.fileId!),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fetches a photo sent on WhatsApp, and says why when it cannot', async () => {
    const store = new MemoryFileStore();
    const incoming = async (externalId: string) =>
      (
        await receiveMessage(t.db, {
          orgId: org.orgId,
          channel: 'whatsapp',
          externalThreadId: '919800099999',
          contactAddress: '+919800099999',
          externalId,
          body: '[Photo]',
          attachments: [{ name: 'Photo', contentType: 'image/png' }],
        })
      ).message!;

    const first = await incoming('wamid.media.1');
    const asked: string[] = [];
    const client = {
      async downloadMedia(mediaId: string) {
        asked.push(mediaId);
        return { data: PNG, mimeType: 'image/png' };
      },
    };
    expect(
      await fetchWhatsAppMedia(t.db, store, client, { messageId: first.id, mediaId: 'media-1' }),
    ).toEqual({ kept: true });
    expect(asked).toEqual(['media-1']);
    const [kept] = await t.db.select().from(messages).where(eq(messages.id, first.id));
    expect(kept!.attachments[0]).toMatchObject({ contentType: 'image/png', size: PNG.length });
    const [file] = await t.db
      .select()
      .from(storedFiles)
      .where(eq(storedFiles.id, kept!.attachments[0]!.fileId!));
    expect(file!.fileName).toBe('Photo.png');
    // The job running again does not fetch it a second time.
    expect(
      await fetchWhatsAppMedia(t.db, store, client, { messageId: first.id, mediaId: 'media-1' }),
    ).toMatchObject({ kept: false });
    expect(asked).toHaveLength(1);

    // WhatsApp no longer has it: nothing to try again.
    const second = await incoming('wamid.media.2');
    const gone = {
      async downloadMedia(): Promise<never> {
        throw new PermanentSendError('WhatsApp did not give the file: expired');
      },
    };
    expect(
      await fetchWhatsAppMedia(t.db, store, gone, { messageId: second.id, mediaId: 'media-2' }),
    ).toEqual({ kept: false, reason: 'WhatsApp did not give the file: expired' });
    // An outage is thrown, so the job is tried again.
    const down = {
      async downloadMedia(): Promise<never> {
        throw new Error('WhatsApp could not be reached');
      },
    };
    await expect(
      fetchWhatsAppMedia(t.db, store, down, { messageId: second.id, mediaId: 'media-2' }),
    ).rejects.toThrow('could not be reached');
    // A voice note is not a photo or a PDF: it stays a name.
    const voice = {
      downloadMedia: async () => ({ data: Buffer.from('OggS....'), mimeType: null }),
    };
    expect(
      await fetchWhatsAppMedia(t.db, store, voice, { messageId: second.id, mediaId: 'media-2' }),
    ).toEqual({ kept: false, reason: 'Only photos and PDF files are kept' });
  });
});

describe('WhatsApp', () => {
  const config = { accessToken: 'token-123', phoneNumberId: '1055', apiVersion: 'v27.0' };
  const fake = (status: number, body: unknown) => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it('sends free text and approved templates in the form the Cloud API expects', async () => {
    const { calls, fetchImpl } = fake(200, { messages: [{ id: 'wamid.ABC' }] });
    const client = new WhatsAppClient(config, fetchImpl);
    expect(await client.sendText('919800000000', 'Hello')).toBe('wamid.ABC');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v27.0/1055/messages');
    expect(calls[0]!.headers.authorization).toBe('Bearer token-123');
    expect(calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919800000000',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
    await client.sendTemplate('919800000000', 'pre_arrival_v2', 'en', [
      'Asha',
      'line one\nline two',
      '',
    ]);
    expect(calls[1]!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'pre_arrival_v2',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Asha' },
              { type: 'text', text: 'line one line two' },
              { type: 'text', text: '-' },
            ],
          },
        ],
      },
    });
  });

  it('fetches a file a guest sent from WhatsApp\u2019s own servers only', async () => {
    const calls: { url: string; authorization: string | undefined }[] = [];
    const serving = (address: string) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
        });
        return String(url).startsWith('https://graph.facebook.com/')
          ? new Response(JSON.stringify({ url: address, mime_type: 'image/jpeg', file_size: 5 }))
          : new Response(Buffer.from('\u00ff\u00d8\u00ffab', 'latin1'));
      }) as typeof fetch;

    const good = new WhatsAppClient(config, serving('https://lookaside.fbsbx.com/media/abc'));
    const media = await good.downloadMedia('media-77');
    expect(media.mimeType).toBe('image/jpeg');
    expect(media.data.length).toBe(5);
    expect(calls.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v27.0/media-77',
      'https://lookaside.fbsbx.com/media/abc',
    ]);
    expect(calls.every((c) => c.authorization === 'Bearer token-123')).toBe(true);

    // The access token is not sent anywhere else, whatever address comes back.
    calls.length = 0;
    const elsewhere = new WhatsAppClient(config, serving('https://files.example.net/media/abc'));
    await expect(elsewhere.downloadMedia('media-78')).rejects.toBeInstanceOf(PermanentSendError);
    expect(calls).toHaveLength(1);
    const plain = new WhatsAppClient(config, serving('http://lookaside.fbsbx.com/media/abc'));
    await expect(plain.downloadMedia('media-79')).rejects.toBeInstanceOf(PermanentSendError);

    const missing = new WhatsAppClient(
      config,
      (async () =>
        new Response(JSON.stringify({ error: { message: 'Not found' } }), {
          status: 404,
        })) as typeof fetch,
    );
    await expect(missing.downloadMedia('nope')).rejects.toBeInstanceOf(PermanentSendError);
  });

  it('tells a failure worth retrying from one that will not pass', async () => {
    const windowClosed = new WhatsAppClient(
      config,
      fake(400, {
        error: {
          message: 'Re-engagement message',
          code: 131047,
          error_data: { details: 'More than 24 hours have passed' },
        },
      }).fetchImpl,
    );
    const closed = await windowClosed.sendText('91', 'x').catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(PermanentSendError);
    expect((closed as Error).message).toMatch(/More than 24 hours have passed \(code 131047\)/);
    expect((closed as Error).message).not.toContain('token-123');

    const busy = await new WhatsAppClient(config, fake(429, { error: { code: 130429 } }).fetchImpl)
      .sendText('91', 'x')
      .catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(Error);
    expect(busy).not.toBeInstanceOf(PermanentSendError);

    expect(
      whatsappTransport(null).unavailable({ contactAddress: '+91', connectionId: null }),
    ).toMatch(/not set up/);
  });

  it('accepts only webhook calls signed with the app secret', () => {
    const body = Buffer.from('{"entry":[]}');
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyWhatsAppSignature('app-secret', body, signature)).toBe(true);
    expect(verifyWhatsAppSignature('other', body, signature)).toBe(false);
    expect(verifyWhatsAppSignature('app-secret', Buffer.from('{"entry":[1]}'), signature)).toBe(
      false,
    );
    expect(verifyWhatsAppSignature('app-secret', body, undefined)).toBe(false);
    expect(verifyWhatsAppSignature('app-secret', body, signature.slice(7))).toBe(false);
  });

  it('reads guest messages and delivery receipts out of a webhook', () => {
    const read = readWhatsAppWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1055' },
                contacts: [{ wa_id: '919800000000', profile: { name: 'Asha' } }],
                messages: [
                  {
                    from: '919800000000',
                    id: 'wamid.1',
                    timestamp: '1794000000',
                    type: 'text',
                    text: { body: 'Hi' },
                  },
                  {
                    from: '919800000000',
                    id: 'wamid.2',
                    timestamp: '1794000001',
                    type: 'image',
                    image: { caption: 'Our taxi', id: 'media-77', mime_type: 'image/jpeg' },
                  },
                  {
                    from: '919800000000',
                    id: 'wamid.3',
                    timestamp: '1794000002',
                    type: 'reaction',
                  },
                  { id: 'no-sender', type: 'text', text: { body: 'ignored' } },
                ],
                statuses: [
                  { id: 'wamid.9', status: 'delivered', timestamp: '1794000003' },
                  {
                    id: 'wamid.8',
                    status: 'failed',
                    timestamp: '1794000004',
                    errors: [{ title: 'Undeliverable' }],
                  },
                  { id: 'wamid.7', status: 'deleted' },
                ],
              },
            },
            { value: null },
          ],
        },
        'nonsense',
      ],
    });
    expect(read.messages.map((m) => [m.id, m.body, m.attachment])).toEqual([
      ['wamid.1', 'Hi', null],
      ['wamid.2', '[Photo] Our taxi', 'Photo'],
      ['wamid.3', '[A message of a kind that cannot be shown here]', null],
    ]);
    expect(read.messages[0]).toMatchObject({
      from: '919800000000',
      name: 'Asha',
      phoneNumberId: '1055',
      media: null,
    });
    // A photo comes with what is needed to fetch it.
    expect(read.messages[1]!.media).toEqual({
      id: 'media-77',
      fileName: null,
      mimeType: 'image/jpeg',
    });
    expect(read.messages[0]!.at.toISOString()).toBe('2026-11-06T21:20:00.000Z');
    expect(read.receipts).toMatchObject([
      { id: 'wamid.9', status: 'delivered', error: null },
      { id: 'wamid.8', status: 'failed', error: 'Undeliverable' },
    ]);
    expect(readWhatsAppWebhook(null)).toEqual({ messages: [], receipts: [] });
  });
});
