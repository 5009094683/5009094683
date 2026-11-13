import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiRuns, alerts, auditLog, reservations, reviews } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  addDays,
  cancelReservation,
  createReservation,
  receiveMessage,
  todayIn,
  updateProperty,
  type Actor,
} from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
  type TestOrg,
} from '@pms/domain/testing';
import { captureIdDocument, readBookingEmail } from './documents';
import {
  arrivalsAtRisk,
  detectUnusualCancellations,
  housekeepingForecast,
  planAssignments,
  scoreRisk,
  suggestAssignments,
  applyAssignments,
} from './insights';
import { draftReply, translateText } from './replies';
import {
  analyseByRules,
  analysePendingReviews,
  analyseReview,
  draftReviewReply,
  reviewInsights,
} from './reviews';
import { FakeProvider } from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;
let staff: Actor;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 1, autoAssign: false });
  await updateProperty(t.db, org.admin, hotel.property.id, {
    addressLine1: 'Fort Aguada Road',
    city: 'Candolim',
    phone: '+91 832 555 0100',
    settings: {
      amenities: ['Swimming pool', 'Free parking', 'Free Wi-Fi', 'Breakfast available'],
      arrivalInstructions: 'Reception is open 24 hours.',
      knowledge: 'Pets are not allowed. The beach is a two-minute walk.',
    },
  });
  const user = await createTestUser(t.db, org.orgId, {
    role: 'front_desk',
    propertyId: hotel.property.id,
  });
  staff = {
    type: 'user',
    orgId: org.orgId,
    userId: user.id,
    label: user.email,
    grants: [{ role: 'front_desk', propertyId: hotel.property.id }],
  };
});
afterAll(async () => {
  await t.drop();
});

let seq = 0;
const book = (
  from: number,
  to: number,
  extra: { source?: 'phone' | 'ota'; email?: string | null } = {},
) =>
  createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: extra.source ?? 'phone',
    channelCode: extra.source === 'ota' ? 'BDC' : null,
    guest: {
      firstName: 'Lena',
      lastName: `Fischer${++seq}`,
      email: extra.email === undefined ? `lena${seq}@example.com` : extra.email,
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

async function conversationWith(question: string, reservationId?: string) {
  const { conversation } = await receiveMessage(t.db, {
    orgId: org.orgId,
    channel: 'whatsapp',
    externalThreadId: `9198000${String(++seq).padStart(5, '0')}`,
    contactName: 'Lena Fischer',
    body: question,
    propertyId: hotel.property.id,
    reservationId: reservationId ?? null,
  });
  return conversation;
}

describe('drafting replies to guests', () => {
  it('answers the common questions from the property\u2019s own details when there is no AI service', async () => {
    const conversation = await conversationWith('Hi, what time is check-in and is there parking?');
    const draft = await draftReply(t.db, null, staff, conversation.id);
    expect(draft).toMatchObject({ source: 'rules', needsStaff: false, language: 'en' });
    expect(draft.draft).toBe(
      'Dear Lena,\n\nCheck-in is from 14:00. Reception is open 24 hours. Yes, parking is available.\n\nTest Hotel 1',
    );
    // Anything else is left to a person rather than guessed.
    const other = await conversationWith('Can I get a refund for last night?');
    expect(await draftReply(t.db, null, staff, other.id)).toMatchObject({
      draft: null,
      needsStaff: true,
    });
  });

  it('gives the model the property facts and the conversation, and nothing that identifies the guest', async () => {
    const reservation = await book(5, 7, { email: 'private.address@example.com' });
    const conversation = await conversationWith('Darf ich meinen Hund mitbringen?', reservation.id);
    const provider = new FakeProvider().answer({
      toolCalls: [
        {
          id: 'c1',
          name: 'draft_reply',
          input: {
            reply: 'Liebe Lena, leider sind Haustiere bei uns nicht erlaubt.\n\nTest Hotel 1',
            language: 'de',
            englishTranslation: 'Dear Lena, unfortunately pets are not allowed.\n\nTest Hotel 1',
            needsStaff: false,
            reason: null,
          },
        },
      ],
    });
    const draft = await draftReply(t.db, provider, staff, conversation.id);
    expect(draft).toEqual({
      draft: 'Liebe Lena, leider sind Haustiere bei uns nicht erlaubt.\n\nTest Hotel 1',
      language: 'de',
      translation: 'Dear Lena, unfortunately pets are not allowed.\n\nTest Hotel 1',
      needsStaff: false,
      reason: null,
      source: 'llm',
    });
    const sent = provider.sentText();
    expect(sent).toContain('Pets are not allowed');
    expect(sent).toContain('Darf ich meinen Hund mitbringen?');
    expect(sent).toContain(`Booking ${reservation.code}`);
    // First name only: no surname, email or phone number leaves the system.
    expect(sent).toContain("Guest's first name: Lena");
    expect(sent).not.toContain('private.address@example.com');
    expect(sent).not.toContain('Fischer');
    // The model is told how to treat what the guest wrote, and the answer was forced into a checked shape.
    expect(provider.requests[0]!.system).toMatch(/not instructions to you/);
    expect(provider.requests[0]!.toolChoice).toEqual({ name: 'draft_reply' });
    const [run] = await t.db.select().from(aiRuns).where(eq(aiRuns.feature, 'reply_draft'));
    expect(run).toMatchObject({ userId: staff.userId, ok: true });
  });

  it('flags what staff must decide, and refuses an answer in the wrong shape', async () => {
    const conversation = await conversationWith('I want a late check-out at 4 pm, free of charge.');
    const provider = new FakeProvider().answer({
      toolCalls: [
        {
          id: 'c1',
          name: 'draft_reply',
          input: {
            reply: 'Dear Lena, we will check and come back to you shortly.',
            language: 'en',
            englishTranslation: null,
            needsStaff: true,
            reason: 'A free late check-out is for staff to decide',
          },
        },
      ],
    });
    expect(await draftReply(t.db, provider, staff, conversation.id)).toMatchObject({
      needsStaff: true,
      reason: 'A free late check-out is for staff to decide',
      translation: null,
    });
    const broken = new FakeProvider().answer({
      toolCalls: [{ id: 'c1', name: 'draft_reply', input: { reply: 42 } }],
    });
    await expect(draftReply(t.db, broken, staff, conversation.id)).rejects.toMatchObject({
      code: 'upstream_failed',
    });
    const silent = new FakeProvider().answer({ text: 'Sure! Here is a reply...' });
    await expect(draftReply(t.db, silent, staff, conversation.id)).rejects.toThrow(
      /did not answer in the expected form/,
    );

    const translated = await translateText(
      t.db,
      new FakeProvider().answer({
        toolCalls: [
          {
            id: 'c1',
            name: 'translation',
            input: { translation: 'Thank you', sourceLanguage: 'DE' },
          },
        ],
      }),
      staff,
      'Danke',
      'en',
    );
    expect(translated).toEqual({ translation: 'Thank you', sourceLanguage: 'de' });
  });
});

describe('reading reviews', () => {
  const insert = async (values: Partial<typeof reviews.$inferInsert> & { externalId: string }) => {
    const [row] = await t.db
      .insert(reviews)
      .values({
        orgId: org.orgId,
        propertyId: hotel.property.id,
        receivedAt: new Date(),
        channelCode: 'BDC',
        ...values,
      })
      .returning();
    return row!;
  };

  it('sorts a review into mood and subjects without a language model', () => {
    const mixed = analyseByRules({
      overallScore: 60,
      scores: [
        { category: 'clean', score: 4 },
        { category: 'location', score: 10 },
      ],
      content:
        'The staff were friendly and helpful. But the bathroom was not clean and the wifi was slow. Great breakfast!',
    });
    expect(mixed.sentiment).toBe('neutral');
    const byTopic = Object.fromEntries(mixed.topics.map((x) => [x.topic, x.sentiment]));
    expect(byTopic).toMatchObject({
      cleanliness: 'negative',
      location: 'positive',
      staff: 'positive',
      wifi: 'negative',
      food: 'positive',
    });
    expect(analyseByRules({ overallScore: 95, scores: [], content: null })).toMatchObject({
      sentiment: 'positive',
      topics: [],
      summary: null,
    });
    expect(
      analyseByRules({
        overallScore: null,
        scores: [],
        content: 'Dirty room, rude staff. Terrible.',
      }).sentiment,
    ).toBe('negative');
  });

  it('reads waiting reviews, with the model when there is one and the rules when it fails', async () => {
    const praised = await insert({
      externalId: 'r1',
      overallScore: 90,
      content: 'Lovely pool and very clean rooms.',
      guestName: 'Asha Rao',
    });
    const criticised = await insert({
      externalId: 'r2',
      overallScore: 40,
      content: 'Zimmer war schmutzig und laut.',
      guestName: 'Lena Fischer',
    });
    const provider = new FakeProvider().answer((request) => {
      // The review text is given to the model as text to classify.
      expect(JSON.stringify(request.messages)).toMatch(/Lovely pool|Zimmer war schmutzig/);
      return {
        toolCalls: [
          {
            id: 'c1',
            name: 'classify_review',
            input: {
              sentiment: 'negative',
              topics: [
                { topic: 'cleanliness', sentiment: 'negative' },
                { topic: 'noise', sentiment: 'negative' },
              ],
              summary: 'The room was dirty and noisy.',
              language: 'de',
            },
          },
        ],
      };
    });
    // The newest review is read first: the German one, by the model. Then the model fails.
    await t.db
      .update(reviews)
      .set({ receivedAt: new Date(Date.now() - 60_000) })
      .where(eq(reviews.id, praised.id));
    expect(await analysePendingReviews(t.db, provider)).toBe(2);
    const [german] = await t.db.select().from(reviews).where(eq(reviews.id, criticised.id));
    expect(german).toMatchObject({
      sentiment: 'negative',
      language: 'de',
      analysedBy: 'llm',
      summary: 'The room was dirty and noisy.',
    });
    // The second call had no scripted answer: the model "was down", and the rules read it instead.
    const [english] = await t.db.select().from(reviews).where(eq(reviews.id, praised.id));
    expect(english).toMatchObject({ sentiment: 'positive', analysedBy: 'rules' });
    expect(english!.topics).toContainEqual({ topic: 'cleanliness', sentiment: 'positive' });
    expect(await analysePendingReviews(t.db, null)).toBe(0);

    const insights = await reviewInsights(t.db, org.orgId, { propertyIds: 'all' });
    expect(insights).toMatchObject({
      count: 2,
      averageScore: 6.5,
      sentiment: { positive: 1, neutral: 0, negative: 1 },
      unanswered: 2,
    });
    expect(insights.topics[0]).toMatchObject({ topic: 'cleanliness', positive: 1, negative: 1 });
    expect(insights.byChannel).toEqual([{ channelCode: 'BDC', count: 2, averageScore: 6.5 }]);
    // Someone with access to no property sees nothing.
    expect((await reviewInsights(t.db, org.orgId, { propertyIds: [] })).count).toBe(0);
  });

  it('drafts a public reply that answers what was said', async () => {
    const review = await insert({
      externalId: 'r3',
      overallScore: 50,
      content: 'The room was not clean. Staff were friendly though.',
      guestName: 'Kabir Sethi',
    });
    await analyseReview(t.db, null, review.id);
    const byRules = await draftReviewReply(t.db, null, staff, review.id);
    expect(byRules.source).toBe('rules');
    expect(byRules.draft).toContain('Dear Kabir,');
    expect(byRules.draft).toContain('We are sorry that the cleanliness and room fell short');
    expect(byRules.draft).toContain('glad that you liked the staff');

    const provider = new FakeProvider().answer({
      toolCalls: [{ id: 'c1', name: 'review_reply', input: { reply: 'Dear Kabir, thank you...' } }],
    });
    expect(await draftReviewReply(t.db, provider, staff, review.id)).toEqual({
      draft: 'Dear Kabir, thank you...',
      source: 'llm',
    });
    // Only the first name goes to the model.
    expect(provider.sentText()).not.toContain('Sethi');
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(draftReviewReply(t.db, null, rival.admin, review.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('risk, rooms and workload', () => {
  const base = {
    source: 'phone',
    paymentCollect: 'property',
    leadDays: 10,
    nights: 2,
    nonRefundable: false,
    totalAmount: 900_000,
    paid: 0,
    hasContact: true,
    pastStays: 0,
    pastCancellations: 0,
    pastNoShows: 0,
    onlineCheckin: false,
    daysToArrival: 10,
  };

  it('scores a booking from what is known about it, and says why', () => {
    const plain = scoreRisk(base);
    const unpaidOta = scoreRisk({ ...base, source: 'ota', leadDays: 75 });
    const prepaid = scoreRisk({ ...base, paid: 900_000, nonRefundable: true });
    const repeatNoShow = scoreRisk({ ...base, pastNoShows: 1, hasContact: false });
    expect(unpaidOta.cancellation).toBeGreaterThan(plain.cancellation);
    expect(unpaidOta.level).toBe('medium');
    expect(unpaidOta.factors.slice(0, 2)).toEqual([
      'Booked on a booking site with nothing paid',
      'Booked more than two months ahead',
    ]);
    expect(prepaid.cancellation).toBeLessThan(plain.cancellation);
    expect(prepaid.level).toBe('low');
    expect(repeatNoShow.noShow).toBeGreaterThan(plain.noShow + 25);
    expect(repeatNoShow.level).toBe('high');
    expect(scoreRisk({ ...base, onlineCheckin: true }).noShow).toBe(1);
    // Never certain either way.
    const extreme = scoreRisk({
      ...base,
      source: 'ota',
      leadDays: 90,
      pastNoShows: 3,
      pastCancellations: 5,
      hasContact: false,
      nights: 10,
    });
    expect(extreme.cancellation).toBeLessThanOrEqual(95);
    expect(extreme.noShow).toBeLessThanOrEqual(95);
  });

  it('lists upcoming arrivals riskiest first', async () => {
    const safe = await book(3, 5);
    const risky = await book(4, 6, { source: 'ota', email: null });
    const list = await arrivalsAtRisk(t.db, org.orgId, hotel.property.id, { days: 10 });
    const codes = list.map((r) => r.code);
    expect(codes.indexOf(risky.code)).toBeLessThan(codes.indexOf(safe.code));
    expect(list.find((r) => r.code === risky.code)).toMatchObject({ source: 'BDC' });
    // Someone due yesterday who may still come is on the front desk's list, so is scored too.
    const overdue = await book(-1, 2);
    const later = await arrivalsAtRisk(t.db, org.orgId, hotel.property.id, { days: 10 });
    expect(later.find((r) => r.code === overdue.code)!.factors).toContain(
      'Was due earlier and has not arrived',
    );
    expect(scoreRisk({ ...base, daysToArrival: -1 }).noShow).toBe(scoreRisk(base).noShow + 20);
    const rival = await createTestOrg(t.db, 'Rival 2');
    await expect(arrivalsAtRisk(t.db, rival.orgId, hotel.property.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('places stays back to back, keeps long runs free, and says what it could not place', () => {
    const units = [
      { id: 'u1', name: '101' },
      { id: 'u2', name: '102' },
    ];
    const stay = (code: string, checkIn: string, checkOut: string) => ({
      roomId: `room-${code}`,
      reservationId: `res-${code}`,
      code,
      guestName: code,
      checkIn,
      checkOut,
    });
    const plan = planAssignments(
      units,
      [{ unitId: 'u1', from: '2026-12-01', to: '2026-12-03' }],
      [
        stay('A', '2026-12-03', '2026-12-05'),
        stay('B', '2026-12-05', '2026-12-08'),
        stay('C', '2026-12-04', '2026-12-06'),
        stay('D', '2026-12-04', '2026-12-05'),
      ],
    );
    const placed = Object.fromEntries(plan.assignments.map((a) => [a.code, a.unitName]));
    // A follows the guest leaving 101 that morning; B follows A; C overlaps both and takes 102.
    expect(placed).toEqual({ A: '101', B: '101', C: '102' });
    expect(plan.assignments.find((a) => a.code === 'A')!.gapBefore).toBe(0);
    // D overlaps A in 101 and C in 102: nowhere to go.
    expect(plan.unplaced.map((s) => s.code)).toEqual(['D']);
  });

  it('suggests rooms for real stays and assigns them through the usual checks', async () => {
    const empty = await createTestHotel(t.db, org, {
      standardRooms: 2,
      deluxeRooms: 1,
      autoAssign: false,
    });
    const make = (from: number, to: number) =>
      createReservation(t.db, org.admin, {
        propertyId: empty.property.id,
        source: 'phone',
        guest: { firstName: 'Guest', lastName: `${from}` },
        rooms: [
          {
            roomTypeId: empty.standard.roomType.id,
            ratePlanId: empty.standard.ratePlan.id,
            checkIn: day(from),
            checkOut: day(to),
            adults: 1,
          },
        ],
      });
    const first = await make(2, 4);
    const second = await make(4, 6);
    const plans = await suggestAssignments(t.db, org.orgId, empty.property.id);
    expect(plans).toHaveLength(1);
    const [a, b] = plans[0]!.assignments;
    expect([a!.code, b!.code]).toEqual([first.code, second.code]);
    // The second stay follows the first into the same room, leaving the other room free throughout.
    expect(a!.unitId).toBe(b!.unitId);
    const result = await applyAssignments(
      t.db,
      org.admin,
      plans[0]!.assignments.map(({ reservationId, roomId, unitId }) => ({
        reservationId,
        roomId,
        unitId,
      })),
    );
    expect(result).toEqual({ applied: 2, failed: [] });
    expect(await suggestAssignments(t.db, org.orgId, empty.property.id)).toEqual([]);
    // Giving a taken room again is refused by the same rule as by hand, and reported.
    const third = await make(3, 5);
    const clash = await applyAssignments(t.db, org.admin, [
      { reservationId: third.id, roomId: third.rooms[0]!.id, unitId: a!.unitId },
    ]);
    expect(clash.applied).toBe(0);
    expect(clash.failed[0]!.reason).toMatch(/already taken/);
  });

  it('adds up the cleaning ahead', async () => {
    const quiet = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 1 });
    await updateProperty(t.db, org.admin, quiet.property.id, {
      settings: { departureCleanMinutes: 60, stayoverCleanMinutes: 30 },
    });
    for (const [from, to] of [
      [0, 2],
      [0, 3],
      [1, 2],
    ] as const) {
      await createReservation(t.db, org.admin, {
        propertyId: quiet.property.id,
        source: 'phone',
        guest: { firstName: 'G', lastName: `${from}${to}` },
        rooms: [
          {
            roomTypeId: quiet.standard.roomType.id,
            ratePlanId: quiet.standard.ratePlan.id,
            checkIn: day(from),
            checkOut: day(to),
            adults: 1,
          },
        ],
      });
    }
    const forecast = await housekeepingForecast(t.db, org.orgId, quiet.property.id, { days: 4 });
    expect(forecast.days.map((d) => [d.arrivals, d.stayovers, d.departures, d.minutes])).toEqual([
      [2, 0, 0, 0],
      [1, 2, 0, 60],
      [0, 1, 2, 150],
      [0, 0, 1, 60],
    ]);
    expect(forecast.busiest).toBe(day(2));
    expect(forecast.days[2]!.staff).toBe(1);
  });

  it('raises one alert when a property loses far more bookings in a day than usual', async () => {
    const busy = await createTestHotel(t.db, org, { standardRooms: 8, deluxeRooms: 1 });
    const make = async (n: number) =>
      createReservation(t.db, org.admin, {
        propertyId: busy.property.id,
        source: 'ota',
        channelCode: n % 2 ? 'BDC' : 'ABB',
        guest: { firstName: 'C', lastName: `${n}` },
        rooms: [
          {
            roomTypeId: busy.standard.roomType.id,
            ratePlanId: busy.standard.ratePlan.id,
            checkIn: day(20 + n),
            checkOut: day(21 + n),
            adults: 1,
          },
        ],
      });
    for (let n = 0; n < 3; n++) {
      await cancelReservation(t.db, org.admin, (await make(n)).id, { reason: 'Guest' });
    }
    // Three in a day is not yet out of the ordinary.
    expect(await detectUnusualCancellations(t.db)).toBe(0);
    for (let n = 3; n < 6; n++) {
      await cancelReservation(t.db, org.admin, (await make(n)).id, { reason: 'Guest' });
    }
    expect(await detectUnusualCancellations(t.db)).toBe(1);
    // Checked again an hour later: the same alert, not another.
    expect(await detectUnusualCancellations(t.db)).toBe(0);
    const raised = await t.db.select().from(alerts).where(eq(alerts.kind, 'unusual_cancellations'));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe(`${busy.property.name}: 6 cancellations in the last 24 hours`);
    expect(raised[0]!.body).toContain('ABB, BDC');
    // Holds that lapsed unpaid are not cancellations by guests.
    await t.db
      .update(reservations)
      .set({ cancellationReason: 'Hold expired before the booking was completed' })
      .where(eq(reservations.propertyId, busy.property.id));
    await t.db.delete(alerts).where(eq(alerts.kind, 'unusual_cancellations'));
    expect(await detectUnusualCancellations(t.db)).toBe(0);
  });
});

describe('documents', () => {
  const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.from('passport')]);
  const answer = {
    toolCalls: [
      {
        id: 'c1',
        name: 'identity_document',
        input: {
          documentType: 'passport',
          fullName: ' LENA FISCHER ',
          documentNumber: 'C01X00T47',
          nationality: 'de',
          issuingCountry: 'DEU',
          dateOfBirth: '1988-02-30',
          expiryDate: '2031-05-04',
          address: null,
          legible: true,
        },
      },
    ],
  };

  it('reads an identity document only when the organisation has switched that on', async () => {
    const provider = new FakeProvider().answer(answer);
    await expect(
      captureIdDocument(t.db, provider, { AI_DOCUMENT_CAPTURE_ENABLED: false }, staff, {
        data: jpeg,
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    // Nothing was sent anywhere.
    expect(provider.requests).toHaveLength(0);
    await expect(
      captureIdDocument(t.db, null, { AI_DOCUMENT_CAPTURE_ENABLED: true }, staff, { data: jpeg }),
    ).rejects.toMatchObject({ code: 'not_configured' });
    await expect(
      captureIdDocument(t.db, provider, { AI_DOCUMENT_CAPTURE_ENABLED: true }, staff, {
        data: Buffer.from('%PDF-1.7 not a photo'),
      }),
    ).rejects.toThrow(/photo/);

    const read = await captureIdDocument(
      t.db,
      provider,
      { AI_DOCUMENT_CAPTURE_ENABLED: true },
      staff,
      {
        data: jpeg,
        propertyId: hotel.property.id,
      },
    );
    expect(read).toEqual({
      documentType: 'passport',
      fullName: 'LENA FISCHER',
      documentNumber: 'C01X00T47',
      nationality: 'DE',
      // What does not look right is dropped rather than passed on: a three-letter code, a date that does not exist.
      issuingCountry: null,
      dateOfBirth: null,
      expiryDate: '2031-05-04',
      address: null,
      legible: true,
    });
    const part = (provider.requests[0]!.messages[0]!.content as { type: string }[])[1];
    expect(part).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
    // That a document was read is on record; what it said is not.
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'guest.id_captured'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('C01X00T47');
    const [run] = await t.db.select().from(aiRuns).where(eq(aiRuns.feature, 'id_capture'));
    expect(JSON.stringify(run)).not.toContain('FISCHER');
  });

  it('reads a booking email the patterns could not, and gives up rather than guess', async () => {
    const email = {
      subject: 'Neue Buchung 4821-XZ',
      text: 'Gast: Lena Fischer. Anreise 12.12.2026, Abreise 15.12.2026. Gesamtpreis 13.500,00 INR.',
      channelName: 'Booking.com',
      defaultCurrency: 'INR',
    };
    const reading = (input: Record<string, unknown>) =>
      new FakeProvider().answer({ toolCalls: [{ id: 'c1', name: 'booking_notice', input }] });
    const full = {
      isBookingNotice: true,
      status: 'new',
      reference: '4821-XZ',
      guestName: 'Lena Fischer',
      guestEmail: 'not an email',
      guestPhone: null,
      checkIn: '2026-12-12',
      checkOut: '2026-12-15',
      roomName: 'Deluxe Room',
      rooms: 1,
      adults: 2,
      children: null,
      currency: 'inr',
      totalAmount: '13500.00',
      notes: null,
    };
    expect(await readBookingEmail(t.db, reading(full), org.orgId, email)).toMatchObject({
      status: 'new',
      reference: '4821-XZ',
      guestName: 'Lena Fischer',
      guestEmail: null,
      checkIn: '2026-12-12',
      checkOut: '2026-12-15',
      currency: 'INR',
      totalAmount: 1_350_000,
    });
    // No reference, impossible dates, or "this is not a booking notice": no reservation comes of it.
    for (const bad of [
      { ...full, reference: null },
      { ...full, checkOut: '2026-12-10' },
      { ...full, checkIn: '2026-13-45' },
      { ...full, isBookingNotice: false },
    ]) {
      expect(await readBookingEmail(t.db, reading(bad), org.orgId, email)).toBeNull();
    }
    // A cancellation needs only the reference.
    expect(
      await readBookingEmail(
        t.db,
        reading({ ...full, status: 'cancelled', checkIn: null, checkOut: null }),
        org.orgId,
        email,
      ),
    ).toMatchObject({ status: 'cancelled', reference: '4821-XZ' });
  });
});
