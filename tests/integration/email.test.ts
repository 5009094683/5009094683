import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { setMailboxFactory, type MailboxReader, type RawEmail } from '@pms/channels';
import { bookingRevisions, reservations } from '@pms/db';
import { createTestUser, type TestHotel } from '@pms/domain/testing';
import {
  day,
  liveHotel,
  openAlerts,
  shownEverywhere,
  startStack,
  waitFor,
  type ConnectedProperty,
  type Stack,
} from './harness';

const INBOUND_SECRET = 'inbound-email-test-secret';

let stack: Stack;
let hotel: TestHotel;
let live: ConnectedProperty;
let connectionId: string;
/** The reservations mailbox, as the fake mail server holds it. */
const inbox: RawEmail[] = [];
let uidValidity = '1';
let nextUid = 1;

const reader: MailboxReader = {
  async fetchAfter(position, limit) {
    const from = position.uidValidity === uidValidity ? position.lastUid : 0;
    return { uidValidity, messages: inbox.filter((m) => m.uid > from).slice(0, limit) };
  },
};

interface Mail {
  from?: string;
  to?: string;
  subject: string;
  body: string;
  /** What the receiving server recorded about the sender. Default: verified. */
  auth?: 'pass' | 'fail' | 'none';
  date?: Date;
}

let messageSeq = 0;

function mime(mail: Mail): string {
  const from = mail.from ?? 'noreply@booking.com';
  const domain = from.split('@')[1];
  const auth =
    mail.auth === 'none'
      ? []
      : mail.auth === 'fail'
        ? [
            `Authentication-Results: mx.test; dkim=fail header.d=${domain}; spf=fail smtp.mailfrom=${domain}; dmarc=fail`,
          ]
        : [
            `Authentication-Results: mx.test; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
          ];
  return [
    `From: ${from}`,
    `To: ${mail.to ?? 'reservations@hotel.test'}`,
    `Subject: ${mail.subject}`,
    `Message-ID: <test-${++messageSeq}@${domain}>`,
    `Date: ${(mail.date ?? new Date()).toUTCString()}`,
    ...auth,
    'Content-Type: text/plain; charset=utf-8',
    '',
    mail.body,
    '',
  ].join('\r\n');
}

/** Delivers an email to the mailbox; the worker finds it on its next check. */
function deliver(mail: Mail): void {
  inbox.push({ uid: nextUid++, source: Buffer.from(mime(mail)) });
}

const bookingNotice = (
  reference: string,
  fields: {
    checkIn: string;
    checkOut: string;
    room?: string;
    guest?: string;
    total?: string;
    rooms?: number;
  },
) =>
  [
    'You have a new booking.',
    `Booking number: ${reference}`,
    `Guest name: ${fields.guest ?? 'Lena Fischer'}`,
    `Check-in: ${fields.checkIn}`,
    `Check-out: ${fields.checkOut}`,
    `Room type: ${fields.room ?? 'Standard Room'}`,
    ...(fields.rooms ? [`Number of rooms: ${fields.rooms}`] : []),
    'Adults: 2',
    `Total price: ${fields.total ?? 'INR 9,000.00'}`,
  ].join('\n');

/** Makes the worker check the mailbox now rather than at the next minute. */
async function checkMailbox(): Promise<void> {
  const before = await finishedChecks();
  await stack.api.t.db.execute(
    sql`UPDATE jobs SET created_at = now() - interval '10 minutes'
        WHERE unique_key = ${`channel.pull:poll:${connectionId}`}`,
  );
  const res = await stack.admin.post(`/channels/connections/${connectionId}/pull`);
  expect(res.statusCode).toBe(202);
  await waitFor('the mailbox to be checked', async () => (await finishedChecks()) > before);
}

async function finishedChecks(): Promise<number> {
  const { rows } = await stack.api.t.db.execute<{ n: number }>(sql`
    SELECT coalesce(sum(CASE WHEN status = 'running' THEN attempts - 1 ELSE attempts END), 0)::int AS n
    FROM jobs WHERE kind = 'channel.pull' AND payload->>'connectionId' = ${connectionId}
  `);
  return rows[0]!.n;
}

const byReference = async (reference: string) =>
  (
    await stack.api.t.db
      .select()
      .from(reservations)
      .where(eq(reservations.channelReservationCode, reference))
  )[0];

const revisions = async () =>
  (
    (
      await stack.admin.get(`/channels/revisions?connectionId=${connectionId}&limit=200`)
    ).json() as {
      revisions: { id: string; status: string; error: string | null; externalBookingId: string }[];
    }
  ).revisions;

beforeAll(async () => {
  setMailboxFactory(() => reader);
  stack = await startStack({ env: { INBOUND_EMAIL_SECRET: INBOUND_SECRET } });
  // The same hotel is also on the channel manager, so an email booking must close its other sites.
  ({ hotel, live } = await liveHotel(stack, { standardRooms: 4, deluxeRooms: 2 }));
  const created = await stack.admin.post('/channels/connections', {
    propertyId: hotel.property.id,
    adapter: 'email',
  });
  expect(created.statusCode).toBe(201);
  connectionId = (created.json() as { id: string }).id;
  const saved = await stack.admin.put(`/channels/connections/${connectionId}/email/mailbox`, {
    host: 'imap.hotel.test',
    user: 'reservations@hotel.test',
    password: 'mailbox-password',
  });
  expect(saved.statusCode).toBe(204);
  await checkMailbox();
});
afterAll(async () => {
  setMailboxFactory(null);
  await stack.stop();
});

describe('the reservations mailbox', () => {
  it('turns a booking email into a reservation, for staff to check, and closes the room on the sites', async () => {
    deliver({
      from: 'alerts@go-mmt.com',
      subject: 'Booking Confirmation - NH7412589630',
      body: bookingNotice('NH7412589630', {
        checkIn: day(10),
        checkOut: day(12),
        guest: 'Rahul Mehta',
        total: 'Rs. 9,000',
      }),
    });
    await checkMailbox();
    const reservation = await byReference('NH7412589630');
    expect(reservation).toMatchObject({
      status: 'confirmed',
      source: 'ota',
      channelCode: 'MMT',
      guestName: 'Rahul Mehta',
      checkIn: day(10),
      checkOut: day(12),
      totalAmount: 900_000,
      needsReview: true,
    });
    expect(reservation!.reviewReason).toBe(
      'Read from an email from MakeMyTrip. Check the details against MakeMyTrip.',
    );
    // MakeMyTrip is not on the channel manager here, but the sites that are must lose the room.
    await waitFor('the sites to close the room', () =>
      shownEverywhere(stack, live, hotel.standard.roomType.id, day(10)).every((v) => v === 3),
    );
  });

  it('reads each email once', async () => {
    const before = (await revisions()).length;
    await checkMailbox();
    await checkMailbox();
    expect((await revisions()).length).toBe(before);
  });

  it('applies a change and a cancellation from a verified sender', async () => {
    deliver({
      subject: 'New booking 7001000001',
      body: bookingNotice('7001000001', { checkIn: day(20), checkOut: day(22) }),
      date: new Date(Date.now() - 3 * 60_000),
    });
    await checkMailbox();
    deliver({
      subject: 'Booking modified: 7001000001',
      body: `This reservation has been changed.\nBooking number: 7001000001\nCheck-in: ${day(21)}\nCheck-out: ${day(24)}\nRoom type: Standard Room`,
      date: new Date(Date.now() - 2 * 60_000),
    });
    await checkMailbox();
    expect(await byReference('7001000001')).toMatchObject({
      status: 'confirmed',
      checkIn: day(21),
      checkOut: day(24),
    });

    deliver({
      subject: 'Cancellation: booking 7001000001',
      body: 'The guest has cancelled this reservation.\nBooking number: 7001000001',
      date: new Date(Date.now() - 60_000),
    });
    await checkMailbox();
    expect(await byReference('7001000001')).toMatchObject({ status: 'cancelled' });
  });

  it('will not cancel on the word of a sender it cannot verify, until the property says to trust such mail', async () => {
    deliver({
      subject: 'New booking 7001000002',
      body: bookingNotice('7001000002', { checkIn: day(30), checkOut: day(32) }),
      date: new Date(Date.now() - 2 * 60_000),
    });
    await checkMailbox();
    deliver({
      auth: 'none',
      subject: 'Cancellation: booking 7001000002',
      body: 'The guest has cancelled this reservation.\nBooking number: 7001000002',
      date: new Date(Date.now() - 60_000),
    });
    await checkMailbox();
    expect(await byReference('7001000002')).toMatchObject({ status: 'confirmed' });
    const held = (await revisions()).find(
      (r) => r.status === 'failed' && /7001000002/.test(r.error ?? ''),
    );
    expect(held!.error).toMatch(/asks to cancel booking 7001000002.*could not confirm who sent it/);
    const alerts = (await openAlerts(stack, 'booking_needs_review')).filter(
      (a) => a.entityId === held!.id,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical' });

    // Applying it again changes nothing while the setting stands.
    expect(
      (
        (await stack.admin.post(`/channels/revisions/${held!.id}/reprocess`)).json() as {
          status: string;
        }
      ).status,
    ).toBe('failed');
    expect(await byReference('7001000002')).toMatchObject({ status: 'confirmed' });

    // The property decides to trust mail its server cannot verify; the held email is applied.
    const saved = await stack.admin.put(`/channels/connections/${connectionId}/email/mailbox`, {
      trustUnverifiedSenders: true,
    });
    expect(saved.statusCode).toBe(204);
    const applied = await stack.admin.post(`/channels/revisions/${held!.id}/reprocess`);
    expect(applied.json()).toMatchObject({ status: 'applied' });
    expect(await byReference('7001000002')).toMatchObject({ status: 'cancelled' });
    expect(
      (await openAlerts(stack, 'booking_needs_review')).filter((a) => a.entityId === held!.id),
    ).toHaveLength(0);
    await stack.admin.put(`/channels/connections/${connectionId}/email/mailbox`, {
      trustUnverifiedSenders: false,
    });
  });

  it('does nothing with an email that fails the sender checks', async () => {
    deliver({
      auth: 'fail',
      subject: 'New booking 7001000003',
      body: bookingNotice('7001000003', { checkIn: day(40), checkOut: day(42) }),
    });
    await checkMailbox();
    expect(await byReference('7001000003')).toBeUndefined();
    const held = (await revisions()).find((r) => /7001000003/.test(r.error ?? ''));
    expect(held).toMatchObject({ status: 'failed' });
    expect(held!.error).toMatch(/may be forged/);
  });

  it('tells staff about a booking email it cannot read', async () => {
    deliver({
      subject: 'New booking',
      body: 'You have a new booking. Sign in to the extranet to see it.',
    });
    await checkMailbox();
    const unread = (await revisions()).find((r) =>
      /no booking reference could be found/.test(r.error ?? ''),
    );
    expect(unread).toMatchObject({ status: 'failed' });
    const alerts = (await openAlerts(stack, 'booking_needs_review')).filter(
      (a) => a.entityId === unread!.id,
    );
    expect(alerts[0]!.body).toMatch(/Open the email and enter the booking by hand/);
    // It is not retried: the email will not read differently in a minute.
    const [row] = await stack.api.t.db
      .select()
      .from(bookingRevisions)
      .where(eq(bookingRevisions.id, unread!.id));
    expect(row!.nextAttemptAt).toBeNull();
  });

  it('ignores mail that is not about a booking', async () => {
    const before = (await revisions()).length;
    deliver({
      subject: 'Your commission invoice for December',
      body: 'Please find your invoice attached.',
    });
    deliver({
      from: 'newsletter@travel-news.example',
      subject: 'Ten trends for 2027',
      body: 'Bookings are up.',
    });
    await checkMailbox();
    expect((await revisions()).length).toBe(before);
  });

  it('holds a booking for a room it cannot place, and places it once the room name is mapped', async () => {
    deliver({
      subject: 'New booking 7001000004',
      body: bookingNotice('7001000004', {
        checkIn: day(50),
        checkOut: day(52),
        room: 'Premium Ocean Suite',
      }),
    });
    await checkMailbox();
    expect(await byReference('7001000004')).toBeUndefined();
    const held = (await revisions()).find((r) => r.externalBookingId === 'BDC:7001000004');
    expect(held).toMatchObject({ status: 'unmapped' });
    expect(held!.error).toContain('Premium Ocean Suite');

    // Staff say what the channel calls the deluxe room (in any letter case).
    const put = await stack.admin.put(`/channels/connections/${connectionId}/mappings`, {
      roomTypes: [{ roomTypeId: hotel.deluxe.roomType.id, externalId: '  PREMIUM  Ocean Suite ' }],
    });
    expect(put.statusCode).toBe(200);
    const applied = await stack.admin.post(`/channels/revisions/${held!.id}/reprocess`);
    expect(applied.json()).toMatchObject({ status: 'applied' });
    const reservation = await byReference('7001000004');
    const detail = (await stack.admin.get(`/reservations/${reservation!.id}`)).json() as {
      rooms: { roomTypeId: string }[];
    };
    expect(detail.rooms[0]!.roomTypeId).toBe(hotel.deluxe.roomType.id);
  });

  it('splits a booking for several rooms', async () => {
    deliver({
      subject: 'New booking 7001000005',
      body: bookingNotice('7001000005', {
        checkIn: day(60),
        checkOut: day(61),
        rooms: 2,
        total: 'INR 9,001.00',
      }),
    });
    await checkMailbox();
    const reservation = await byReference('7001000005');
    const detail = (await stack.admin.get(`/reservations/${reservation!.id}`)).json() as {
      totalAmount: number;
      rooms: { amount: number }[];
    };
    expect(detail.rooms.map((r) => r.amount)).toEqual([450_050, 450_050]);
    expect(detail.totalAmount).toBe(900_100);
  });
});

describe('email handed over by a mail service', () => {
  const post = (body: string, headers: Record<string, string>, id = connectionId) =>
    fetch(`${stack.apiUrl}/webhooks/inbound-email/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', ...headers },
      body,
    });

  it('records the booking, once, and only with the shared secret', async () => {
    const raw = mime({
      from: 'no-reply@agoda.com',
      subject: 'Booking confirmation - Booking ID 889900112',
      body: bookingNotice('889900112', { checkIn: day(70), checkOut: day(72), guest: 'Chen Wei' }),
    });
    expect((await post(raw, {})).status).toBe(401);
    expect((await post(raw, { 'x-inbound-email-secret': 'wrong' })).status).toBe(401);
    expect(await byReference('889900112')).toBeUndefined();

    const first = await post(raw, { 'x-inbound-email-secret': INBOUND_SECRET });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      received: true,
      status: 'applied',
      duplicate: false,
    });
    expect(await byReference('889900112')).toMatchObject({
      channelCode: 'AGO',
      guestName: 'Chen Wei',
    });

    const again = await post(raw, { 'x-inbound-email-secret': INBOUND_SECRET });
    expect(await again.json()).toMatchObject({ received: true, duplicate: true });

    // Services that post JSON put the raw message in a field.
    const viaJson = await fetch(
      `${stack.apiUrl}/webhooks/inbound-email/${connectionId}?secret=${INBOUND_SECRET}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      },
    );
    expect(await viaJson.json()).toMatchObject({ received: true, duplicate: true });
  });

  it('says so when the email is not about a booking, and refuses an unknown mailbox', async () => {
    const res = await post(mime({ subject: 'Invoice', body: 'Your invoice.' }), {
      'x-inbound-email-secret': INBOUND_SECRET,
    });
    expect(await res.json()).toEqual({ received: true, ignored: 'not_a_booking' });
    const unknown = await post(
      mime({ subject: 'New booking 1', body: 'x' }),
      { 'x-inbound-email-secret': INBOUND_SECRET },
      '00000000-0000-4000-8000-000000000000',
    );
    expect(unknown.status).toBe(404);
    expect((await post('', { 'x-inbound-email-secret': INBOUND_SECRET })).status).toBe(400);
  });
});

describe('mailbox settings', () => {
  it('never gives the password back, and are for channel managers only', async () => {
    const res = await stack.admin.get(`/channels/connections/${connectionId}/email/mailbox`);
    expect(res.json()).toEqual({
      host: 'imap.hotel.test',
      port: null,
      user: 'reservations@hotel.test',
      folder: null,
      recipient: null,
      trustUnverifiedSenders: false,
      hasPassword: true,
      forwardingUrl: `${stack.apiUrl}/webhooks/inbound-email/${connectionId}`,
    });
    expect(res.body).not.toContain('mailbox-password');
    const summary = await stack.admin.get(`/channels/connections/${connectionId}`);
    expect(summary.body).not.toContain('mailbox-password');

    const reader = await createTestUser(stack.api.t.db, stack.api.org.orgId, { role: 'read_only' });
    const client = await stack.api.login(reader.email);
    expect(
      (await client.get(`/channels/connections/${connectionId}/email/mailbox`)).statusCode,
    ).toBe(403);
    expect(
      (
        await client.put(`/channels/connections/${connectionId}/email/mailbox`, {
          host: 'evil.example',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('only handles mail addressed to the property when the mailbox is shared', async () => {
    await stack.admin.put(`/channels/connections/${connectionId}/email/mailbox`, {
      recipient: 'goa@hotel.test',
    });
    deliver({
      to: 'jaipur@hotel.test',
      subject: 'New booking 7001000006',
      body: bookingNotice('7001000006', { checkIn: day(80), checkOut: day(81) }),
    });
    deliver({
      to: 'goa@hotel.test',
      subject: 'New booking 7001000007',
      body: bookingNotice('7001000007', { checkIn: day(80), checkOut: day(81) }),
    });
    await checkMailbox();
    expect(await byReference('7001000006')).toBeUndefined();
    expect(await byReference('7001000007')).toMatchObject({ status: 'confirmed' });
    await stack.admin.put(`/channels/connections/${connectionId}/email/mailbox`, {
      recipient: null,
    });
  });

  it('starts over with recent mail when the mail server rebuilds the mailbox', async () => {
    deliver({
      subject: 'New booking 7001000008',
      body: bookingNotice('7001000008', { checkIn: day(90), checkOut: day(91) }),
    });
    // The server renumbers everything: positions remembered before mean nothing now.
    uidValidity = '2';
    const before = (await revisions()).length;
    await checkMailbox();
    // Everything is offered again. What was already recorded is recognised; the new email is
    // added, and so is the one skipped earlier while the mailbox was limited to one address.
    expect((await revisions()).length).toBe(before + 2);
    expect(await byReference('7001000008')).toMatchObject({ status: 'confirmed' });
    expect(await byReference('7001000006')).toMatchObject({ status: 'confirmed' });
    expect(
      (
        await stack.api.t.db
          .select()
          .from(reservations)
          .where(eq(reservations.channelReservationCode, 'NH7412589630'))
      ).length,
    ).toBe(1);
  });
});
