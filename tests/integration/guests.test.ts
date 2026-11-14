import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { automationSends, messages, paymentOrders, reservations } from '@pms/db';
import { updateProperty } from '@pms/domain';
import type { TestHotel } from '@pms/domain/testing';
import {
  day,
  guestBooks,
  liveHotel,
  reservationFor,
  shownEverywhere,
  startStack,
  waitFor,
  type ConnectedProperty,
  type Stack,
} from './harness';

let stack: Stack;
let hotel: TestHotel;
let live: ConnectedProperty;

beforeAll(async () => {
  stack = await startStack();
  ({ hotel, live } = await liveHotel(stack, { standardRooms: 2, deluxeRooms: 1 }));
  await updateProperty(stack.api.t.db, stack.api.org.admin, hotel.property.id, {
    settings: { bookingEngineEnabled: true, bookingHoldMinutes: 5 },
  });
  await waitFor('the sites to show the rooms', () => {
    const shown = shownEverywhere(stack, live, hotel.standard.roomType.id, day(10));
    return shown.length > 1 && shown.every((n) => n === 2);
  });
});
afterAll(async () => {
  await stack.stop();
});

const guest = () => stack.api.anonymous();
const std = () => hotel.standard.roomType.id;

const websiteBooking = (from: number, to: number, email: string) => ({
  propertyCode: hotel.property.code,
  checkIn: day(from),
  checkOut: day(to),
  rooms: [{ roomTypeId: std(), ratePlanId: hotel.standard.ratePlan.id, adults: 2 }],
  guest: { firstName: 'Meera', lastName: 'Nair', email },
  acceptTerms: true,
});

describe('a booking on the hotel\u2019s own website', () => {
  it('closes the room on every booking site while the guest pays, and stays closed once paid', async () => {
    const booked = (
      await guest().post('/public/bookings', websiteBooking(10, 12, 'meera@example.com'))
    ).json();
    expect(booked.status).toBe('tentative');
    // The hold alone is enough: one of two rooms is gone on both sites, on both nights.
    await waitFor('the sites to show one room left', () =>
      [day(10), day(11)].every((date) =>
        shownEverywhere(stack, live, std(), date).every((n) => n === 1),
      ),
    );

    const payPath = new URL(booked.payment.checkoutUrl).pathname;
    await guest().request({
      method: 'POST',
      url: payPath,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'outcome=paid',
    });
    // The guest closes the tab without coming back: the worker finds the payment on its own.
    const [order] = await stack.api.t.db
      .select()
      .from(paymentOrders)
      .innerJoin(reservations, eq(reservations.id, paymentOrders.reservationId))
      .where(eq(reservations.code, booked.code));
    await stack.api.t.db
      .update(paymentOrders)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(paymentOrders.id, order!.payment_orders.id));
    await waitFor('the worker to record the payment', async () => {
      const view = (await guest().get(`/public/bookings/${booked.token}`)).json();
      return view.status === 'confirmed' && view.paid === 945_000;
    });
    expect(shownEverywhere(stack, live, std(), day(10)).every((n) => n === 1)).toBe(true);

    // And the confirmation goes out by itself.
    await waitFor('the confirmation email', () =>
      stack.api.mailer.sent.find(
        (m) => m.to === 'meera@example.com' && m.subject.includes(booked.code),
      ),
    );
    const mail = stack.api.mailer.sent.find((m) => m.subject.includes(booked.code))!;
    expect(mail.subject).toBe(
      `Your booking at ${hotel.property.name} is confirmed (${booked.code})`,
    );
    expect(mail.text).toContain('Paid: ₹9,450');
  });

  it('gives the room back to the booking sites when the guest never pays', async () => {
    expect(shownEverywhere(stack, live, std(), day(20)).every((n) => n === 2)).toBe(true);
    const booked = (
      await guest().post('/public/bookings', websiteBooking(20, 21, 'ghost@example.com'))
    ).json();
    await waitFor('the hold to reach the sites', () =>
      shownEverywhere(stack, live, std(), day(20)).every((n) => n === 1),
    );
    // Time passes: the hold has run out.
    await stack.api.t.db
      .update(reservations)
      .set({ holdExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(reservations.code, booked.code));
    await waitFor('the room to be on sale again everywhere', () =>
      shownEverywhere(stack, live, std(), day(20)).every((n) => n === 2),
    );
    expect((await guest().get(`/public/bookings/${booked.token}`)).json().status).toBe('cancelled');
    // Nobody is told about a booking that never was.
    const sends = await stack.api.t.db
      .select()
      .from(automationSends)
      .innerJoin(reservations, eq(reservations.id, automationSends.reservationId))
      .where(eq(reservations.code, booked.code));
    expect(sends).toEqual([]);
  });

  it('cannot take the last room a booking site sold a moment earlier', async () => {
    // One deluxe room. Booking.com sells it; the website tries for the same night.
    const dlx = hotel.deluxe.roomType.id;
    const ota = guestBooks(stack, live, 'BDC', {
      roomTypeId: dlx,
      ratePlanId: hotel.deluxe.ratePlan.id,
      checkIn: day(30),
      checkOut: day(31),
    });
    await waitFor('the booking to arrive', () => reservationFor(stack, ota.code));
    const refused = await guest().post('/public/bookings', {
      ...websiteBooking(30, 31, 'late@example.com'),
      rooms: [{ roomTypeId: dlx, ratePlanId: hotel.deluxe.ratePlan.id, adults: 2 }],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('no_availability');
    const search = (
      await guest().get(
        `/public/properties/${hotel.property.code}/availability?checkIn=${day(30)}&checkOut=${day(31)}`,
      )
    ).json();
    expect(
      search.offers.find((o: { roomType: { id: string } }) => o.roomType.id === dlx).available,
    ).toBe(0);
  });
});

describe('a guest writing on a booking site', () => {
  it('reaches the inbox within moments, and the reply reaches the guest on that site', async () => {
    const ota = guestBooks(
      stack,
      live,
      'BDC',
      {
        roomTypeId: std(),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(40),
        checkOut: day(42),
      },
      { guest: { name: 'Lena', surname: 'Fischer' } },
    );
    const reservation = await waitFor('the booking to arrive', () =>
      reservationFor(stack, ota.code),
    );

    stack.sim.state.guestMessage(ota.id, 'Can we check in at 10 am?');
    const conversation = await waitFor('the message to reach the inbox', async () => {
      const list = (
        await stack.admin.get(`/inbox/conversations?reservationId=${reservation.id}`)
      ).json();
      return list.conversations[0];
    });
    expect(conversation).toMatchObject({
      channel: 'ota',
      unreadCount: 1,
      lastMessagePreview: 'Can we check in at 10 am?',
      contactName: 'Lena Fischer',
    });

    const reply = await stack.admin.post(`/inbox/conversations/${conversation.id}/messages`, {
      body: 'Yes, your room will be ready from 10.',
    });
    expect(reply.statusCode).toBe(201);
    const thread = [...stack.sim.state.threads.values()].find((t) => t.bookingId === ota.id)!;
    await waitFor('the reply to reach the booking site', () =>
      thread.messages.some(
        (m) => m.sender === 'property' && m.message === 'Yes, your room will be ready from 10.',
      ),
    );
    await waitFor('the message to show as sent', async () => {
      const [row] = await stack.api.t.db
        .select()
        .from(messages)
        .where(eq(messages.id, reply.json().id));
      return row?.status === 'sent';
    });

    // A message the webhook never announced is still found by the regular check.
    stack.sim.state.guestMessage(ota.id, 'One more question: is there parking?', { silent: true });
    await stack.admin.post(`/channels/connections/${live.connectionId}/pull`);
    await waitFor('the unannounced message', async () => {
      const detail = (await stack.admin.get(`/inbox/conversations/${conversation.id}`)).json();
      return detail.messages.some(
        (m: { body: string }) => m.body === 'One more question: is there parking?',
      );
    });
    const detail = (await stack.admin.get(`/inbox/conversations/${conversation.id}`)).json();
    // The thread reads whole and in order, with nothing twice.
    expect(
      detail.messages.map((m: { direction: string; body: string }) => [m.direction, m.body]),
    ).toEqual([
      ['in', 'Can we check in at 10 am?'],
      ['out', 'Yes, your room will be ready from 10.'],
      ['in', 'One more question: is there parking?'],
    ]);
  });

  it('says plainly when the property has no message box at the channel manager', async () => {
    stack.sim.state.messagingDisabled.add(live.externalPropertyId);
    const ota = guestBooks(stack, live, 'ABB', {
      roomTypeId: std(),
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(50),
      checkOut: day(51),
    });
    const reservation = await waitFor('the booking to arrive', () =>
      reservationFor(stack, ota.code),
    );
    const conversation = (
      await stack.admin.post('/inbox/conversations', {
        channel: 'ota',
        reservationId: reservation.id,
      })
    ).json();
    const sent = await stack.admin.post(`/inbox/conversations/${conversation.id}/messages`, {
      body: 'Welcome!',
    });
    await waitFor('the message to fail', async () => {
      const [row] = await stack.api.t.db
        .select()
        .from(messages)
        .where(eq(messages.id, sent.json().id));
      return row?.status === 'failed' && row;
    }).then((row) => {
      expect(row.error).toBe(
        'The channel manager\u2019s messages add-on is not switched on for this property.',
      );
    });
    stack.sim.state.messagingDisabled.delete(live.externalPropertyId);
  });
});

describe('a guest reviewing a stay on a booking site', () => {
  it('is read and filed under the booking, and the reply is posted on that site, once', async () => {
    const ota = guestBooks(
      stack,
      live,
      'BDC',
      {
        roomTypeId: std(),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(60),
        checkOut: day(62),
      },
      { guest: { name: 'Kabir', surname: 'Sethi' } },
    );
    const reservation = await waitFor('the booking to arrive', () =>
      reservationFor(stack, ota.code),
    );

    const posted = stack.sim.state.guestReview({
      bookingId: ota.id,
      score: 4,
      scores: [{ category: 'staff', score: 9 }],
      content: 'The room was dirty and the wifi was slow.',
    });
    interface Review {
      id: string;
      externalId: string;
      sentiment: string | null;
      topics: { topic: string; sentiment: string }[];
      replyStatus: string;
    }
    const find = async (): Promise<Review | undefined> =>
      (await stack.admin.get('/reviews'))
        .json()
        .reviews.find((r: Review) => r.externalId === posted.id);
    const review = await waitFor('the review to arrive and be read', async () => {
      const row = await find();
      return row?.sentiment ? row : undefined;
    });
    expect(review).toMatchObject({
      channelCode: 'BDC',
      reservationId: reservation.id,
      otaReservationCode: ota.code,
      guestName: 'Kabir Sethi',
      overallScore: 40,
      sentiment: 'negative',
      analysedBy: 'rules',
      reply: null,
      replyStatus: 'none',
    });
    expect(review.topics).toEqual(
      expect.arrayContaining([
        { topic: 'cleanliness', sentiment: 'negative' },
        { topic: 'wifi', sentiment: 'negative' },
        { topic: 'staff', sentiment: 'positive' },
      ]),
    );
    const insights = (await stack.admin.get('/reviews/insights')).json();
    expect(insights).toMatchObject({ count: 1, averageScore: 4, unanswered: 1 });

    const text = 'Dear Kabir, we are sorry about the room and have spoken to the team.';
    const reply = await stack.admin.post(`/reviews/${review.id}/reply`, { text });
    expect(reply.statusCode).toBe(200);
    await waitFor(
      'the reply to reach the booking site',
      () => stack.sim.state.reviews.get(posted.id)?.reply === text,
    );
    await waitFor('the review to show as answered', async () => {
      return (await find())?.replyStatus === 'sent';
    });
    // Booking sites take one reply per review.
    const again = await stack.admin.post(`/reviews/${review.id}/reply`, { text: 'One more thing' });
    expect(again.statusCode).toBe(409);
    expect(stack.sim.state.reviews.get(posted.id)?.reply).toBe(text);
    expect((await stack.admin.get('/reviews/insights')).json().unanswered).toBe(0);

    // A review nobody announced is found when staff ask for the latest.
    const quiet = stack.sim.state.guestReview({
      propertyId: live.externalPropertyId,
      channel: 'ABB',
      score: 10,
      content: 'Wonderful stay, spotless villa.',
      guestName: 'Asha',
      silent: true,
    });
    const refreshed = await stack.admin.post(`/properties/${hotel.property.id}/reviews/refresh`);
    expect(refreshed.statusCode).toBe(202);
    await waitFor('the unannounced review', async () => {
      const rows = (await stack.admin.get('/reviews?sentiment=positive')).json().reviews;
      return rows.some((r: Review) => r.externalId === quiet.id);
    });
  });
});
