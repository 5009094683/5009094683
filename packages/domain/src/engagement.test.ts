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
  reservations,
  storedFiles,
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
import {
  listAutomationRules,
  listTemplates,
  renderTemplate,
  runAutomations,
  saveAutomationRule,
  saveTemplate,
  sendTemplate,
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
import { MemoryFileStore, purgeExpiredFiles, sniffContentType } from './storage';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';
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
    const listed = await listConversations(t.db, org.orgId, {
      propertyIds: 'all',
      search: 'priya',
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      unreadCount: 2,
      reservationCode: reservation.code,
      propertyName: hotel.property.name,
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
    expect((await listConversations(t.db, org.orgId, scoped)).map((c) => c.id)).toContain(
      conversation.id,
    );
    await updateConversation(t.db, org.admin, conversation.id, {
      propertyId: hotel.property.id,
    });
    expect((await listConversations(t.db, org.orgId, scoped)).map((c) => c.id)).not.toContain(
      conversation.id,
    );
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
    expect(reply).toMatchObject({ status: 'queued', direction: 'out' });
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
    });

    const reservation = await reserve(2, 4);
    const token = await tokenOf(reservation.id);
    expect(await getGuestCheckin(t.db, token)).toMatchObject({
      open: true,
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
    await expect(verifyOnlineCheckin(t.db, org.admin, reservation.id)).rejects.toThrow(
      /no online check-in waiting/,
    );
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
                    image: { caption: 'Our taxi' },
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
    });
    expect(read.messages[0]!.at.toISOString()).toBe('2026-11-06T21:20:00.000Z');
    expect(read.receipts).toMatchObject([
      { id: 'wamid.9', status: 'delivered', error: null },
      { id: 'wamid.8', status: 'failed', error: 'Undeliverable' },
    ]);
    expect(readWhatsAppWebhook(null)).toEqual({ messages: [], receipts: [] });
  });
});
