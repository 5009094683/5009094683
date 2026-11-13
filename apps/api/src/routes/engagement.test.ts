import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  jobs,
  messages,
  organizations,
  paymentOrders,
  reservations,
  type Role,
} from '@pms/db';
import { addDays, deliverMessage, guestToken, todayIn, updateProperty } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let admin: TestClient;
let frontDesk: TestClient;
let housekeeper: TestClient;
let reader: TestClient;
let revenue: TestClient;
let guest: TestClient;
let hotel: TestHotel;
let other: TestHotel;
/** The booking site names the chain it sells for; with more than one organisation it has to. */
let org: string;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

const WHATSAPP_SECRET = 'whatsapp-app-secret';
const INBOUND_SECRET = 'inbound-email-secret';

beforeAll(async () => {
  ctx = await createTestApp({
    WHATSAPP_APP_SECRET: WHATSAPP_SECRET,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_ACCESS_TOKEN: 'token',
    WHATSAPP_PHONE_NUMBER_ID: '1055',
    INBOUND_EMAIL_SECRET: INBOUND_SECRET,
  });
  admin = await ctx.admin();
  guest = ctx.anonymous();
  const [row] = await ctx.t.db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, ctx.org.orgId));
  org = row!.slug;
  hotel = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 6 });
  other = await createTestHotel(ctx.t.db, ctx.org);
  await updateProperty(ctx.t.db, ctx.org.admin, hotel.property.id, {
    settings: { bookingEngineEnabled: true, bookingTerms: 'No parties.' },
  });
  const signIn = async (role: Role) => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role,
      propertyId: hotel.property.id,
    });
    return ctx.login(user.email);
  };
  frontDesk = await signIn('front_desk');
  housekeeper = await signIn('housekeeping');
  reader = await signIn('read_only');
  revenue = await signIn('revenue_manager');
});
afterAll(async () => {
  await ctx.close();
});

let guestSeq = 0;
/** Each booker is a different person: a shared name and phone number would be taken for one returning guest. */
const bookingBody = (
  from: number,
  to: number,
  email = `guest${from}@example.com`,
  phone = `+91 98000 ${String(20000 + ++guestSeq)}`,
) => ({
  org,
  propertyCode: hotel.property.code,
  checkIn: day(from),
  checkOut: day(to),
  rooms: [
    {
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      adults: 2,
    },
  ],
  guest: { firstName: 'Meera', lastName: `Nair${guestSeq}`, email, phone },
  acceptTerms: true,
});

/** Books on the website and pays on the stand-in payment page, as a guest would. */
async function bookAndPay(from: number, to: number, email?: string, phone?: string) {
  const response = await guest.post('/public/bookings', bookingBody(from, to, email, phone));
  expect(response.statusCode, response.body).toBe(201);
  const booked = response.json();
  const payPath = new URL(booked.payment.checkoutUrl).pathname.replace(/^\/api/, '');
  const paid = await guest.request({
    method: 'POST',
    url: payPath,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'outcome=paid',
  });
  expect(paid.statusCode).toBe(303);
  const synced = await guest.post(`/public/bookings/${booked.token}/sync`);
  expect(synced.json().status).toBe('confirmed');
  const [reservation] = await ctx.t.db
    .select()
    .from(reservations)
    .where(eq(reservations.code, booked.code));
  return { ...booked, reservationId: reservation!.id, payPath, redirect: paid.headers.location };
}

describe('the booking site', () => {
  it('shows what can be booked without signing in, and nothing else', async () => {
    const listed = (await guest.get(`/public/properties?org=${org}`)).json();
    expect(listed.organisation.name).toBe('Test Hotels');
    expect(listed.properties.map((p: { code: string }) => p.code)).toEqual([hotel.property.code]);
    expect(
      (await guest.get(`/public/properties/${other.property.code}?org=${org}`)).statusCode,
    ).toBe(404);
    const detail = (await guest.get(`/public/properties/${hotel.property.code}?org=${org}`)).json();
    expect(detail).toMatchObject({ terms: 'No parties.', payment: { mode: 'full' } });
    // Nothing internal leaks into the public description of a property.
    expect(JSON.stringify(detail)).not.toMatch(/orgId|gstin|settings|businessDate/);

    const search = await guest.get(
      `/public/properties/${hotel.property.code}/availability?org=${org}&checkIn=${day(10)}&checkOut=${day(12)}&adults=2`,
    );
    expect(search.statusCode).toBe(200);
    const standard = search
      .json()
      .offers.find(
        (o: { roomType: { id: string } }) => o.roomType.id === hotel.standard.roomType.id,
      );
    expect(standard).toMatchObject({ available: 6 });
    expect(standard.plans[0]).toMatchObject({ total: 945_000, payNow: 945_000 });

    const bad = await guest.get(
      `/public/properties/${hotel.property.code}/availability?org=${org}&checkIn=${day(12)}&checkOut=${day(10)}`,
    );
    expect(bad.statusCode).toBe(400);
  });

  it('takes a booking through payment to confirmation, with the price set by the server', async () => {
    // Whatever amounts a browser sends along are ignored: there is nowhere to put them.
    const tampered = await guest.post('/public/bookings', {
      ...bookingBody(10, 12),
      total: 1,
      payNow: 1,
      rooms: [{ ...bookingBody(10, 12).rooms[0], nightlyRates: [1, 1] }],
    });
    expect(tampered.statusCode).toBe(201);
    expect(tampered.json()).toMatchObject({ status: 'tentative', total: 945_000, payNow: 945_000 });
    const booked = tampered.json();
    expect(booked.payment.checkoutUrl).toContain('/public/mock-pay/mock_');

    const payPath = new URL(booked.payment.checkoutUrl).pathname.replace(/^\/api/, '');
    const page = await guest.get(payPath);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('₹9,450.00');
    expect(page.body).toContain('stand-in payment page');

    const paid = await guest.request({
      method: 'POST',
      url: payPath,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=paid',
    });
    expect(paid.statusCode).toBe(303);
    expect(paid.headers.location).toBe(`http://localhost:3001/booking/${booked.token}?paid=1`);
    // Paying twice is not possible.
    expect((await guest.get(payPath)).body).toContain('already made');

    const after = (await guest.post(`/public/bookings/${booked.token}/sync`)).json();
    expect(after).toMatchObject({ status: 'confirmed', paid: 945_000, balance: 0 });
    expect(after.property.name).toBe(hotel.property.name);

    // Staff see it as a website reservation with the payment on its folio.
    const [reservation] = await ctx.t.db
      .select()
      .from(reservations)
      .where(eq(reservations.code, booked.code));
    const folio = (await frontDesk.get(`/reservations/${reservation!.id}/folios`)).json();
    expect(folio.balance).toBe(-945_000);
    expect(folio.folios[0].lines[0]).toMatchObject({ kind: 'payment', source: 'gateway' });
  });

  it('opens a booking only with its own link', async () => {
    const a = await bookAndPay(14, 15, 'a@example.com');
    const b = await bookAndPay(14, 15, 'b@example.com');
    expect((await guest.get(`/public/bookings/${a.code}`)).statusCode).toBe(400);
    expect((await guest.get(`/public/bookings/${a.token.slice(0, -2)}xx`)).statusCode).toBe(404);
    // One guest's link does not open another guest's payment.
    const [order] = await ctx.t.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.reservationId, b.reservationId));
    expect((await guest.get(`/public/bookings/${a.token}/pay/${order!.id}`)).statusCode).toBe(404);
    expect((await guest.get(`/public/bookings/${b.token}/pay/${order!.id}`)).json()).toMatchObject({
      status: 'paid',
      checkoutUrl: null,
      amount: 472_500,
    });

    // Staff can replace the link; the old one stops working.
    const link = (await frontDesk.get(`/reservations/${a.reservationId}/guest-link`)).json();
    expect(link.url).toBe(`http://localhost:3001/booking/${a.token}`);
    expect(
      (await reader.post(`/reservations/${a.reservationId}/guest-link/revoke`)).statusCode,
    ).toBe(403);
    const replaced = await frontDesk.post(`/reservations/${a.reservationId}/guest-link/revoke`);
    expect(replaced.statusCode).toBe(200);
    expect((await guest.get(`/public/bookings/${a.token}`)).statusCode).toBe(404);
    const fresh = replaced.json().url.split('/booking/')[1];
    expect((await guest.get(`/public/bookings/${fresh}`)).json().code).toBe(a.code);
  });

  it('lets the guest cancel, and sends the refund back through the gateway', async () => {
    const booked = await bookAndPay(20, 22, 'cancel@example.com');
    const view = (await guest.get(`/public/bookings/${booked.token}`)).json();
    expect(view.cancellation).toMatchObject({ allowed: true, charge: 0, refund: 945_000 });
    const cancelled = await guest.post(`/public/bookings/${booked.token}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ refunded: 945_000, refundPending: 0 });
    expect((await guest.post(`/public/bookings/${booked.token}/cancel`)).statusCode).toBe(409);
    const folio = (await frontDesk.get(`/reservations/${booked.reservationId}/folios`)).json();
    expect(folio.balance).toBe(0);
    expect(folio.folios[0].lines.map((l: { kind: string }) => l.kind)).toEqual([
      'payment',
      'refund',
    ]);
  });
});

describe('payments staff start', () => {
  it('sends a payment link, records the payment, and refunds through the gateway', async () => {
    const created = await frontDesk.post('/reservations', {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Phone', lastName: 'Caller', email: 'caller@example.com' },
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          checkIn: day(8),
          checkOut: day(9),
          adults: 2,
        },
      ],
    });
    const reservationId = created.json().id as string;
    expect(
      (await housekeeper.post(`/reservations/${reservationId}/payment-links`, { amount: 100 }))
        .statusCode,
    ).toBe(403);
    const link = await frontDesk.post(`/reservations/${reservationId}/payment-links`, {
      amount: 200_000,
      description: 'Deposit',
      send: true,
    });
    expect(link.statusCode).toBe(201);
    expect(link.json().payUrl).toMatch(
      /^http:\/\/localhost:3001\/booking\/.+\/pay\/[0-9a-f-]{36}$/,
    );
    // The link went to the guest by email, the only way to reach them here.
    expect(link.json().sent).toMatchObject({ channel: 'email' });
    const [queued] = await ctx.t.db
      .select()
      .from(messages)
      .where(eq(messages.templateKey, 'payment_request'));
    expect(queued!.body).toContain('Please pay ₹2,000');
    expect(queued!.body).toContain(link.json().payUrl);

    const token = link.json().payUrl.split('/booking/')[1].split('/pay/')[0];
    const landing = (await guest.get(`/public/bookings/${token}/pay/${link.json().id}`)).json();
    expect(landing).toMatchObject({ amount: 200_000, status: 'created', description: 'Deposit' });
    const payPath = new URL(landing.checkoutUrl).pathname.replace(/^\/api/, '');
    await guest.request({
      method: 'POST',
      url: payPath,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=paid',
    });
    const synced = await frontDesk.post(`/payment-orders/${link.json().id}/sync`);
    expect(synced.json()).toMatchObject({ status: 'paid' });
    const orders = (await frontDesk.get(`/reservations/${reservationId}/payment-orders`)).json();
    expect(orders.orders).toMatchObject([{ status: 'paid', amount: 200_000, payUrl: null }]);

    // Refunding an online payment goes through the gateway; front desk may not, accounts may.
    const folio = (await frontDesk.get(`/reservations/${reservationId}/folios`)).json();
    const paymentId = folio.folios[0].lines[0].paymentId as string;
    const refundBody = { amount: 50_000, reason: 'Guest shortened the stay' };
    expect((await frontDesk.post(`/payments/${paymentId}/refund`, refundBody)).statusCode).toBe(
      403,
    );
    const refund = await admin.post(`/payments/${paymentId}/refund`, refundBody);
    expect(refund.statusCode).toBe(201);
    expect(refund.json().payment).toMatchObject({ amount: -50_000, method: 'online' });
    expect(refund.json().payment.reference).toMatch(/^mockrfnd_/);

    // A link can be withdrawn while it is unpaid, never once paid.
    const second = await frontDesk.post(`/reservations/${reservationId}/payment-links`, {
      amount: 10_000,
    });
    expect(
      (await frontDesk.post(`/payment-orders/${second.json().id}/cancel`)).json(),
    ).toMatchObject({ status: 'cancelled' });
    expect((await frontDesk.post(`/payment-orders/${link.json().id}/cancel`)).statusCode).toBe(409);
  });

  it('refuses webhook calls it cannot verify', async () => {
    // The stand-in gateway sends none, so nothing claiming to be one is believed.
    const forged = await guest.request({
      method: 'POST',
      url: '/webhooks/payments/mock',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'payment_link.paid' }),
    });
    expect(forged.statusCode).toBe(401);
    expect((await guest.post('/webhooks/payments/razorpay', {})).statusCode).toBe(404);
  });
});

describe('the inbox', () => {
  const whatsapp = (body: unknown, secret = WHATSAPP_SECRET) => {
    const payload = JSON.stringify(body);
    return guest.request({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
      },
      payload,
    });
  };
  const incoming = (id: string, text: string, from = '919800012345') => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '1055' },
              contacts: [{ wa_id: from, profile: { name: 'Meera' } }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  it('answers WhatsApp\u2019s address check only with the right token', async () => {
    const ok = await guest.get(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const wrong = await guest.get(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=12345',
    );
    expect(wrong.statusCode).toBe(403);
  });

  it('files a signed WhatsApp message under the guest\u2019s stay and lets staff answer', async () => {
    const booked = await bookAndPay(30, 31, 'whatsapp@example.com', '+91 98000 12345');
    expect((await whatsapp(incoming('wamid.forged', 'hi'), 'wrong-secret')).statusCode).toBe(401);
    const delivered = await whatsapp(incoming('wamid.100', 'What time is breakfast?'));
    expect(delivered.json()).toMatchObject({ stored: 1 });
    // The same delivery again, as WhatsApp does when it is unsure, adds nothing.
    expect((await whatsapp(incoming('wamid.100', 'What time is breakfast?'))).json()).toMatchObject(
      { stored: 0 },
    );
    // A message for another business number on a shared webhook is not ours.
    const foreign = incoming('wamid.200', 'not for us');
    foreign.entry[0]!.changes[0]!.value.metadata.phone_number_id = '9999';
    expect((await whatsapp(foreign)).json()).toMatchObject({ stored: 0 });

    expect((await housekeeper.get('/inbox/conversations')).statusCode).toBe(403);
    const list = (
      await frontDesk.get('/inbox/conversations?status=active&channel=whatsapp')
    ).json();
    const conversation = list.conversations.find(
      (c: { reservationCode: string }) => c.reservationCode === booked.code,
    );
    expect(conversation).toMatchObject({
      contactName: 'Meera',
      unreadCount: 1,
      propertyId: hotel.property.id,
      lastMessagePreview: 'What time is breakfast?',
    });
    expect((await frontDesk.get('/inbox/unread')).json().unread).toBeGreaterThanOrEqual(1);

    const opened = (await frontDesk.get(`/inbox/conversations/${conversation.id}`)).json();
    expect(opened.messages).toHaveLength(1);
    expect(opened).toMatchObject({ canWriteFreely: true, sendingUnavailable: null });
    // Looking without being able to answer leaves it unread for those who can.
    expect((await reader.post(`/inbox/conversations/${conversation.id}/read`)).statusCode).toBe(
      403,
    );
    expect((await frontDesk.get('/inbox/unread')).json().unread).toBeGreaterThanOrEqual(1);
    expect((await frontDesk.post(`/inbox/conversations/${conversation.id}/read`)).statusCode).toBe(
      204,
    );

    // Who it can be given to: people who answer guests at this property.
    const assignees = (await frontDesk.get(`/inbox/assignees?propertyId=${hotel.property.id}`))
      .json()
      .staff.map((person: { name: string }) => person.name);
    expect(assignees.length).toBeGreaterThan(0);
    expect((await housekeeper.get('/inbox/assignees')).statusCode).toBe(403);

    // The templates, filled in for this guest by the server, and one sent in this conversation.
    const offered = (await reader.get(`/inbox/conversations/${conversation.id}/templates`)).json();
    const preArrival = offered.templates.find((x: { key: string }) => x.key === 'pre_arrival');
    expect(preArrival.body).toContain('Meera');
    expect(preArrival.body).not.toContain('{{');
    expect(offered.variables.guest_name).toBeTruthy();
    expect(
      (
        await reader.post(`/inbox/conversations/${conversation.id}/send-template`, {
          templateKey: 'pre_arrival',
        })
      ).statusCode,
    ).toBe(403);
    const template = await frontDesk.post(`/inbox/conversations/${conversation.id}/send-template`, {
      templateKey: 'pre_arrival',
    });
    expect(template.json().sent.message).toMatchObject({
      conversationId: conversation.id,
      body: preArrival.body,
      templateKey: 'pre_arrival',
    });

    // Someone who may only read cannot answer; front desk can.
    const reply = { body: 'Breakfast is from 7 to 10:30.' };
    expect(
      (await reader.post(`/inbox/conversations/${conversation.id}/messages`, reply)).statusCode,
    ).toBe(403);
    const sent = await frontDesk.post(`/inbox/conversations/${conversation.id}/messages`, reply);
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ status: 'queued', direction: 'out' });
    const queued = await ctx.t.db
      .select()
      .from(jobs)
      .where(eq(jobs.uniqueKey, `message.send:${sent.json().id}`));
    expect(queued).toHaveLength(1);

    // A receipt for it, once the worker has sent it.
    await ctx.t.db
      .update(messages)
      .set({ status: 'sent', externalId: 'wamid.out.1' })
      .where(eq(messages.id, sent.json().id));
    const receipt = await whatsapp({
      entry: [
        {
          changes: [
            {
              value: { statuses: [{ id: 'wamid.out.1', status: 'read', timestamp: '1794000000' }] },
            },
          ],
        },
      ],
    });
    expect(receipt.json()).toMatchObject({ updated: 1 });

    const assigned = await frontDesk.patch(`/inbox/conversations/${conversation.id}`, {
      status: 'closed',
    });
    expect(assigned.json().status).toBe('closed');
    // Moving it to a property the user has no rights at is refused.
    expect(
      (
        await frontDesk.patch(`/inbox/conversations/${conversation.id}`, {
          propertyId: other.property.id,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps one property\u2019s conversations from staff of another', async () => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'front_desk',
      propertyId: other.property.id,
    });
    const elsewhere = await ctx.login(user.email);
    const mine = (await frontDesk.get('/inbox/conversations')).json().conversations;
    expect(mine.length).toBeGreaterThan(0);
    // A page at a time, with the cursor the page before gave.
    const first = (await frontDesk.get('/inbox/conversations?limit=1')).json();
    expect(first.conversations).toHaveLength(1);
    if (mine.length > 1) {
      const second = (
        await frontDesk.get(
          `/inbox/conversations?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).json();
      expect(second.conversations[0].id).toBe(mine[1].id);
    } else {
      expect(first.nextCursor).toBeNull();
    }
    expect((await frontDesk.get('/inbox/conversations?cursor=nonsense')).statusCode).toBe(400);
    const theirs = (await elsewhere.get('/inbox/conversations')).json().conversations;
    expect(theirs).toEqual([]);
    expect((await elsewhere.get(`/inbox/conversations/${mine[0].id}`)).statusCode).toBe(403);
    expect(
      (await elsewhere.post(`/inbox/conversations/${mine[0].id}/messages`, { body: 'x' }))
        .statusCode,
    ).toBe(403);
    const rival = await createTestOrg(ctx.t.db, 'Rival Hotels');
    const outsider = await ctx.login(
      (await createTestUser(ctx.t.db, rival.orgId, { role: 'org_admin' })).email,
    );
    expect((await outsider.get(`/inbox/conversations/${mine[0].id}`)).statusCode).toBe(404);
  });

  it('takes a guest\u2019s email from the mail service, with the secret, and only from known senders', async () => {
    await bookAndPay(33, 34, 'emailer@example.com');
    let mailSeq = 0;
    const mime = (from: string, ...extraHeaders: string[]) =>
      [
        `From: Guest <${from}>`,
        'To: stay@seabreeze.example',
        'Subject: Early check-in',
        `Message-ID: <m${++mailSeq}@mail.example>`,
        ...extraHeaders,
        'Content-Type: text/plain',
        '',
        'Could we check in at 10 am?',
      ].join('\r\n');
    const deliver = (raw: string, secret = INBOUND_SECRET) =>
      guest.request({
        method: 'POST',
        url: '/webhooks/inbox/email',
        headers: { 'content-type': 'message/rfc822', 'x-inbound-email-secret': secret },
        payload: raw,
      });

    expect((await deliver(mime('emailer@example.com'), 'wrong')).statusCode).toBe(401);
    expect((await deliver(mime('emailer@example.com'))).json()).toEqual({
      received: true,
      duplicate: false,
    });
    expect((await deliver(mime('stranger@elsewhere.example'))).json()).toMatchObject({
      ignored: 'unknown_sender',
    });
    // The receiving server says the sender is forged: not shown as the guest.
    const forged = mime(
      'emailer@example.com',
      'Authentication-Results: mx.example; dmarc=fail header.from=example.com',
    );
    expect((await deliver(forged)).json()).toMatchObject({ ignored: 'sender_not_genuine' });

    const list = (await frontDesk.get('/inbox/conversations?channel=email&search=emailer')).json();
    expect(list.conversations).toMatchObject([
      { contactAddress: 'emailer@example.com', lastMessagePreview: 'Could we check in at 10 am?' },
    ]);
    // Answering sends an email in the same thread.
    const reply = await frontDesk.post(
      `/inbox/conversations/${list.conversations[0].id}/messages`,
      {
        body: 'Yes, your room will be ready.',
      },
    );
    await deliverMessage(ctx.t.db, reply.json().id);
    expect(ctx.mailer.last()).toMatchObject({
      to: 'emailer@example.com',
      subject: 'Re: Early check-in',
      text: 'Yes, your room will be ready.',
    });

    // A photo sent with an email is kept and can be opened by those who may read the conversation.
    const photo = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('the guest\u2019s photo'),
    ]);
    const withPhoto = [
      'From: Guest <emailer@example.com>',
      'To: stay@seabreeze.example',
      'Subject: Our car',
      'Message-ID: <photo-1@mail.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="frontier"',
      '',
      '--frontier',
      'Content-Type: text/plain',
      '',
      'This is the car we arrive in.',
      '--frontier',
      'Content-Type: image/png; name="car.png"',
      'Content-Disposition: attachment; filename="car.png"',
      'Content-Transfer-Encoding: base64',
      '',
      photo.toString('base64'),
      '--frontier--',
      '',
    ].join('\r\n');
    expect((await deliver(withPhoto)).json()).toEqual({ received: true, duplicate: false });
    const thread = (await frontDesk.get(`/inbox/conversations/${list.conversations[0].id}`)).json();
    const message = thread.messages.at(-1);
    expect(message.attachments).toMatchObject([{ name: 'car.png', contentType: 'image/png' }]);
    const path = `/inbox/messages/${message.id}/attachments/${message.attachments[0].fileId}`;
    const opened = await frontDesk.get(path);
    expect(opened.statusCode).toBe(200);
    expect(opened.headers['content-type']).toBe('image/png');
    expect(opened.headers['x-content-type-options']).toBe('nosniff');
    expect(opened.headers['content-security-policy']).toContain('sandbox');
    expect(opened.rawPayload.equals(photo)).toBe(true);
    expect((await housekeeper.get(path)).statusCode).toBe(403);
    expect((await guest.get(path)).statusCode).toBe(401);
    // Another message's id does not open the file.
    const first = thread.messages[0];
    expect(
      (
        await frontDesk.get(
          `/inbox/messages/${first.id}/attachments/${message.attachments[0].fileId}`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('lets managers change templates and automatic messages, and nobody else', async () => {
    const templates = (await frontDesk.get('/messaging/templates')).json();
    expect(templates.templates).toHaveLength(6);
    expect(templates.variables).toHaveProperty('booking_link');
    const body = {
      key: 'late_checkout',
      name: 'Late check-out offer',
      body: 'Dear {{guest_first_name}}, stay until 2 pm for a small charge.',
    };
    expect((await frontDesk.post('/messaging/templates', body)).statusCode).toBe(403);
    const created = await admin.post('/messaging/templates', body);
    expect(created.statusCode).toBe(201);
    const bad = await admin.post('/messaging/templates', { ...body, key: 'x2', body: '{{nope}}' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/Unknown placeholder/);

    // A manager of one property may change its own templates, not the organisation's.
    const gm = await ctx.login(
      (
        await createTestUser(ctx.t.db, ctx.org.orgId, {
          role: 'general_manager',
          propertyId: hotel.property.id,
        })
      ).email,
    );
    expect((await gm.post('/messaging/templates', { ...body, key: 'gm_org' })).statusCode).toBe(
      403,
    );
    const own = await gm.post('/messaging/templates', {
      ...body,
      key: 'late_checkout',
      propertyId: hotel.property.id,
    });
    expect(own.statusCode).toBe(201);
    expect((await gm.put(`/messaging/templates/${created.json().id}`, body)).statusCode).toBe(403);
    expect((await gm.delete(`/messaging/templates/${own.json().id}`)).statusCode).toBe(204);

    const rules = (await frontDesk.get('/messaging/automations')).json();
    expect(rules.rules).toHaveLength(5);
    const rule = {
      name: 'Late check-out offer',
      trigger: 'check_in_day',
      sendHour: 9,
      templateKey: 'late_checkout',
      channels: ['email'],
    };
    expect((await frontDesk.post('/messaging/automations', rule)).statusCode).toBe(403);
    const added = await admin.post('/messaging/automations', rule);
    expect(added.statusCode).toBe(201);
    // The template is in use now and cannot be removed from under the rule.
    expect((await admin.delete(`/messaging/templates/${created.json().id}`)).statusCode).toBe(409);
    expect((await admin.delete(`/messaging/automations/${added.json().id}`)).statusCode).toBe(204);
    expect((await admin.delete(`/messaging/templates/${created.json().id}`)).statusCode).toBe(204);
  });

  it('lets revenue managers run promotional codes for their own property only', async () => {
    const mine = await revenue.post('/promos', {
      code: 'stay3',
      kind: 'percent',
      value: 1500,
      propertyId: hotel.property.id,
      minNights: 3,
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json()).toMatchObject({ code: 'STAY3', usedCount: 0 });
    // For the whole chain, or for another property, takes rights there.
    expect(
      (await revenue.post('/promos', { code: 'chain', kind: 'percent', value: 500 })).statusCode,
    ).toBe(403);
    expect(
      (
        await revenue.post('/promos', {
          code: 'theirs',
          kind: 'percent',
          value: 500,
          propertyId: other.property.id,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await frontDesk.post('/promos', { code: 'fd', kind: 'percent', value: 500 })).statusCode,
    ).toBe(403);
    const chain = await admin.post('/promos', {
      code: 'chain',
      kind: 'amount',
      value: 50_000,
      currency: 'INR',
    });
    expect(chain.statusCode).toBe(201);
    expect((await revenue.patch(`/promos/${chain.json().id}`, { active: false })).statusCode).toBe(
      403,
    );
    expect(
      (await revenue.patch(`/promos/${mine.json().id}`, { active: false })).json().active,
    ).toBe(false);
    const visible = (await revenue.get('/promos')).json().promos;
    expect(visible.map((p: { code: string }) => p.code).sort()).toEqual(['CHAIN', 'STAY3']);

    const search = await guest.get(
      `/public/properties/${hotel.property.code}/availability?org=${org}&checkIn=${day(40)}&checkOut=${day(42)}&promo=chain`,
    );
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().promo).toMatchObject({ code: 'CHAIN', label: '₹500 off', applied: true });
  });
});

describe('online check-in', () => {
  it('takes the guest\u2019s details and document, and shows them to staff with care', async () => {
    const booked = await bookAndPay(2, 3, 'checkin@example.com');
    const base = `/public/bookings/${booked.token}/check-in`;
    expect((await guest.get(base)).json()).toMatchObject({
      status: 'not_started',
      open: true,
      terms: 'No parties.',
    });
    const form = {
      arrivalTime: '16:00',
      guests: [
        { name: 'Meera Nair', nationality: 'IN', idType: 'aadhaar', idNumber: '4321 8765 0000' },
      ],
      signatureName: 'Meera Nair',
      acceptTerms: true,
    };
    expect((await guest.post(base, { ...form, acceptTerms: false })).statusCode).toBe(400);
    const saved = await guest.post(base, form);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().guests[0]).toMatchObject({ idNumberEnding: '••••0000' });
    expect(saved.body).not.toContain('4321 8765');

    const jpeg = Buffer.concat([
      Buffer.from('ffd8ffe000104a464946', 'hex'),
      Buffer.from('id photo'),
    ]);
    const upload = await guest.request({
      method: 'POST',
      url: `${base}/documents`,
      headers: {
        'content-type': 'image/jpeg',
        'x-file-name': encodeURIComponent('aadhaar front.jpg'),
      },
      payload: jpeg,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({
      fileName: 'aadhaar front.jpg',
      contentType: 'image/jpeg',
    });
    // Saying "image/jpeg" does not make it one.
    const fake = await guest.request({
      method: 'POST',
      url: `${base}/documents`,
      headers: { 'content-type': 'image/jpeg' },
      payload: Buffer.from('<script>alert(1)</script>'),
    });
    expect(fake.statusCode).toBe(400);
    // Nothing readable is on disk.
    expect([...ctx.files.files.values()].some((f) => f.includes(Buffer.from('id photo')))).toBe(
      false,
    );

    const path = `/reservations/${booked.reservationId}/online-checkin`;
    const masked = (await reader.get(path)).json();
    expect(masked).toMatchObject({ status: 'submitted', arrivalTime: '16:00' });
    expect(masked.guests[0]).toMatchObject({ idNumber: null, idNumberEnding: '••••0000' });
    // Seeing the number or the document takes the permission for identity data, and is recorded.
    expect((await reader.get(`${path}?reveal=true`)).statusCode).toBe(403);
    expect((await reader.get(`${path}/documents/${upload.json().id}`)).statusCode).toBe(403);
    const revealed = (await frontDesk.get(`${path}?reveal=true`)).json();
    expect(revealed.guests[0].idNumber).toBe('4321 8765 0000');
    const file = await frontDesk.get(`${path}/documents/${upload.json().id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.rawPayload.equals(jpeg)).toBe(true);
    const viewed = await ctx.t.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'guest.id_viewed'), eq(auditLog.entityId, booked.reservationId)),
      );
    expect(viewed).toHaveLength(2);

    // The board at the front desk shows who has checked in online.
    const board = (
      await frontDesk.get(`/properties/${hotel.property.id}/front-desk?date=${day(2)}`)
    ).json();
    const stay = board.arrivals.find((s: { code: string }) => s.code === booked.code);
    expect(stay.onlineCheckinAt).not.toBeNull();

    expect((await housekeeper.post(`${path}/verify`)).statusCode).toBe(403);
    expect((await frontDesk.post(`${path}/verify`)).statusCode).toBe(204);
    expect((await guest.post(base, form)).statusCode).toBe(409);
    expect((await guest.delete(`${base}/documents/${upload.json().id}`)).statusCode).toBe(409);

    // A link for another booking does not reach this one's documents.
    const [otherBooking] = await ctx.t.db
      .select()
      .from(reservations)
      .where(eq(reservations.propertyId, hotel.property.id))
      .limit(1);
    const otherToken = guestToken(otherBooking!);
    if (otherBooking!.id !== booked.reservationId) {
      expect(
        (
          await guest.delete(
            `/public/bookings/${otherToken}/check-in/documents/${upload.json().id}`,
          )
        ).statusCode,
      ).not.toBe(204);
    }
  });
});
