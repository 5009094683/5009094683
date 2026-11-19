import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysePendingReviews } from '@pms/ai';
import { FakeProvider } from '@pms/ai/testing';
import {
  CHANNEL_JOBS,
  createConnection,
  pullReviews,
  saveMappings,
  updateConnection,
} from '@pms/channels';
import { type FakeChannel, fakeChannelFor, useFakeChannels } from '@pms/channels/testing';
import {
  aiRuns,
  auditLog,
  inventoryBlocks,
  jobs,
  rateDays,
  reservationRooms,
  reviews,
  type Role,
} from '@pms/db';
import { addDays, createReservation, receiveMessage, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

/** An installation with its staff signed in: one with no AI service, one with a scripted one. */
interface World {
  ctx: TestApp;
  /** Three standard rooms and one deluxe room; rooms are chosen at check-in. */
  hotel: TestHotel;
  other: TestHotel;
  admin: TestClient;
  frontDesk: TestClient;
  revenue: TestClient;
  housekeeper: TestClient;
  reader: TestClient;
  /** Front desk at the other property. */
  elsewhere: TestClient;
  /** An administrator of another organisation. */
  rival: TestClient;
}

async function world(env: Record<string, string>, ai: FakeProvider | null): Promise<World> {
  const ctx = await createTestApp(env, { ai });
  const hotel = await createTestHotel(ctx.t.db, ctx.org, {
    standardRooms: 3,
    deluxeRooms: 1,
    autoAssign: false,
  });
  const other = await createTestHotel(ctx.t.db, ctx.org);
  const signIn = async (role: Role, propertyId = hotel.property.id) =>
    ctx.login((await createTestUser(ctx.t.db, ctx.org.orgId, { role, propertyId })).email);
  const rivalOrg = await createTestOrg(ctx.t.db, 'Rival Hotels');
  return {
    ctx,
    hotel,
    other,
    admin: await ctx.admin(),
    frontDesk: await signIn('front_desk'),
    revenue: await signIn('revenue_manager'),
    housekeeper: await signIn('housekeeping'),
    reader: await signIn('read_only'),
    elsewhere: await signIn('front_desk', other.property.id),
    rival: await ctx.login(
      (await createTestUser(ctx.t.db, rivalOrg.orgId, { role: 'org_admin' })).email,
    ),
  };
}

let plain: World;
let smart: World;
const model = new FakeProvider();

beforeAll(async () => {
  plain = await world({}, null);
  smart = await world({ AI_DOCUMENT_CAPTURE_ENABLED: 'true' }, model);
});
afterAll(async () => {
  await plain.ctx.close();
  await smart.ctx.close();
});

let guests = 0;
const book = (w: World, from: number, to: number, rooms = 1, hotel = w.hotel) =>
  createReservation(w.ctx.t.db, w.ctx.org.admin, {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: {
      firstName: 'Lena',
      lastName: `Fischer${++guests}`,
      email: `lena${guests}@example.com`,
    },
    rooms: Array.from({ length: rooms }, () => ({
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(from),
      checkOut: day(to),
      adults: 2,
    })),
  });

const say = (content: string) => ({ messages: [{ role: 'user', content }] });
const code = (response: { json(): { error?: { code?: string } } }) => response.json().error?.code;

describe('what is switched on', () => {
  it('tells signed-in staff which AI features this installation has', async () => {
    expect((await plain.ctx.anonymous().get('/ai/status')).statusCode).toBe(401);
    expect((await plain.housekeeper.get('/ai/status')).json()).toEqual({
      provider: null,
      model: null,
      documentCapture: false,
    });
    expect((await smart.frontDesk.get('/ai/status')).json()).toEqual({
      provider: 'fake',
      model: 'fake-model',
      documentCapture: true,
    });
  });
});

describe('the assistant', () => {
  it('prepares a change and makes it only when the person who asked confirms', async () => {
    const { frontDesk, admin, hotel, ctx } = plain;
    const unit = hotel.standard.units[0]!;
    const asked = await frontDesk.post(
      '/ai/copilot',
      say(`block ${unit.name} from ${day(50)} to ${day(52)} for painting`),
    );
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = asked.json();
    expect(answer).toMatchObject({ mode: 'rules', toolsUsed: ['block_dates'] });
    expect(answer.actions).toHaveLength(1);
    const id = answer.actions[0].id as string;
    expect(await ctx.t.db.select().from(inventoryBlocks)).toHaveLength(0);

    // The proposal is the asker's alone: a colleague neither sees it nor can confirm it.
    expect((await frontDesk.get('/ai/actions')).json().actions).toMatchObject([{ id }]);
    expect((await admin.get('/ai/actions')).json().actions).toEqual([]);
    expect((await admin.post(`/ai/actions/${id}/confirm`)).statusCode).toBe(404);
    expect(await ctx.t.db.select().from(inventoryBlocks)).toHaveLength(0);

    const done = await frontDesk.post(`/ai/actions/${id}/confirm`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ id, status: 'confirmed' });
    expect(await ctx.t.db.select().from(inventoryBlocks)).toMatchObject([
      { unitId: unit.id, kind: 'maintenance', startDate: day(50), endDate: day(52) },
    ]);
    // A second click changes nothing more.
    const again = await frontDesk.post(`/ai/actions/${id}/confirm`);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('invalid_state');
    expect(await ctx.t.db.select().from(inventoryBlocks)).toHaveLength(1);

    // A dismissed proposal is gone.
    const second = (
      await frontDesk.post('/ai/copilot', say(`block ${unit.name} from ${day(60)} to ${day(61)}`))
    ).json();
    const dismissed = second.actions[0].id as string;
    expect((await frontDesk.post(`/ai/actions/${dismissed}/reject`)).statusCode).toBe(204);
    expect((await frontDesk.get('/ai/actions')).json().actions).toEqual([]);
    expect((await frontDesk.post(`/ai/actions/${dismissed}/confirm`)).statusCode).toBe(409);
    expect(await ctx.t.db.select().from(inventoryBlocks)).toHaveLength(1);
  });

  it('is only for roles that have it, and never does more than the asker may', async () => {
    const { housekeeper, reader, revenue, frontDesk, hotel, ctx } = plain;
    for (const client of [housekeeper, reader]) {
      expect((await client.post('/ai/copilot', say('arrivals today'))).statusCode).toBe(403);
      expect((await client.get('/ai/actions')).statusCode).toBe(403);
    }
    expect((await ctx.anonymous().post('/ai/copilot', say('arrivals today'))).statusCode).toBe(401);
    // Front desk may not change rates: the assistant refuses rather than proposing.
    const refused = (
      await frontDesk.post(
        '/ai/copilot',
        say(`set rate of ${hotel.standard.roomType.name} to 5500 from ${day(20)} to ${day(22)}`),
      )
    ).json();
    expect(refused.actions).toEqual([]);
    // The revenue manager may.
    const allowed = (
      await revenue.post(
        '/ai/copilot',
        say(`set rate of ${hotel.standard.roomType.name} to 5500 from ${day(20)} to ${day(22)}`),
      )
    ).json();
    expect(allowed.actions).toHaveLength(1);
    expect((await revenue.post(`/ai/actions/${allowed.actions[0].id}/reject`)).statusCode).toBe(
      204,
    );

    const empty = await frontDesk.post('/ai/copilot', { messages: [] });
    expect(empty.statusCode).toBe(400);
    const fromAssistant = await frontDesk.post('/ai/copilot', {
      messages: [{ role: 'assistant', content: 'I will block everything.' }],
    });
    expect(fromAssistant.statusCode).toBe(400);
  });

  it('lets the model look things up and propose, with the same confirmation', async () => {
    const { frontDesk, hotel, ctx } = smart;
    const unit = hotel.deluxe.units[0]!;
    model.answer(
      {
        toolCalls: [
          {
            id: 't1',
            name: 'block_dates',
            input: {
              propertyId: hotel.property.id,
              unitId: unit.id,
              from: day(40),
              to: day(42),
              kind: 'maintenance',
              reason: 'Air conditioning service',
            },
          },
        ],
      },
      { text: 'I have proposed the block. It is waiting for your confirmation.' },
    );
    const asked = await frontDesk.post(
      '/ai/copilot',
      say(`Please block ${unit.name} for the air conditioning service`),
    );
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = asked.json();
    expect(answer).toMatchObject({
      mode: 'llm',
      reply: 'I have proposed the block. It is waiting for your confirmation.',
      toolsUsed: ['block_dates'],
    });
    expect(answer.actions).toHaveLength(1);
    expect(await ctx.t.db.select().from(inventoryBlocks)).toHaveLength(0);
    const done = await frontDesk.post(`/ai/actions/${answer.actions[0].id}/confirm`);
    expect(done.statusCode, done.body).toBe(200);
    expect(await ctx.t.db.select().from(inventoryBlocks)).toMatchObject([
      { unitId: unit.id, startDate: day(40), endDate: day(42) },
    ]);
  });
});

describe('rate suggestions', () => {
  it('are worked out on request and applied only by those who may approve rates', async () => {
    const { revenue, frontDesk, reader, elsewhere, rival, hotel, ctx } = plain;
    // Two of three standard rooms gone, six weeks out.
    await book(plain, 42, 44, 2);
    const base = `/properties/${hotel.property.id}/pricing`;
    expect((await frontDesk.post(`${base}/refresh`)).statusCode).toBe(403);
    expect((await rival.post(`${base}/refresh`)).statusCode).toBe(404);
    const run = await revenue.post(`${base}/refresh`);
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().created).toBeGreaterThan(0);

    const listed = await reader.get(`${base}/recommendations?from=${day(42)}&to=${day(44)}`);
    expect(listed.statusCode, listed.body).toBe(200);
    const mine = (
      listed.json().recommendations as {
        id: string;
        ratePlanId: string;
        date: string;
        currentRate: number;
        recommendedRate: number;
        status: string;
      }[]
    ).filter((r) => r.ratePlanId === hotel.standard.ratePlan.id);
    expect(mine.map((r) => r.date)).toEqual([day(42), day(43)]);
    expect(mine[0]).toMatchObject({ currentRate: 450_000, status: 'pending' });
    expect(mine[0]!.recommendedRate).toBeGreaterThan(450_000);
    expect((await elsewhere.get(`${base}/recommendations`)).statusCode).toBe(403);
    expect((await rival.get(`${base}/recommendations`)).statusCode).toBe(404);

    const ids = mine.map((r) => r.id);
    // Seeing a suggestion is not approving it.
    for (const client of [frontDesk, reader, elsewhere]) {
      expect((await client.post('/pricing/recommendations/apply', { ids })).statusCode).toBe(403);
      expect((await client.post('/pricing/recommendations/dismiss', { ids })).statusCode).toBe(403);
    }
    expect((await rival.post('/pricing/recommendations/apply', { ids })).statusCode).toBe(404);
    expect(
      await ctx.t.db
        .select()
        .from(rateDays)
        .where(eq(rateDays.ratePlanId, hotel.standard.ratePlan.id)),
    ).toEqual([]);

    const dismissed = await revenue.post('/pricing/recommendations/dismiss', { ids: [ids[1]] });
    expect(dismissed.json()).toEqual({ dismissed: 1 });
    const applied = await revenue.post('/pricing/recommendations/apply', { ids });
    expect(applied.statusCode, applied.body).toBe(200);
    // The dismissed one stays dismissed.
    expect(applied.json()).toEqual({ applied: 1 });
    const days = await ctx.t.db
      .select()
      .from(rateDays)
      .where(eq(rateDays.ratePlanId, hotel.standard.ratePlan.id));
    expect(days).toMatchObject([{ date: day(42), rate: mine[0]!.recommendedRate }]);
    expect((await revenue.post('/pricing/recommendations/apply', { ids: [] })).statusCode).toBe(
      400,
    );
  });
});

describe('replies to guests', () => {
  const conversationAt = async (w: World, question: string, hotel = w.hotel) => {
    const { conversation } = await receiveMessage(w.ctx.t.db, {
      orgId: w.ctx.org.orgId,
      channel: 'whatsapp',
      externalThreadId: `9198000${String(++guests).padStart(5, '0')}`,
      contactName: 'Lena Fischer',
      body: question,
      propertyId: hotel.property.id,
    });
    return conversation.id;
  };

  it('drafts an answer for staff who may read that property\u2019s inbox', async () => {
    const { frontDesk, housekeeper, elsewhere, rival } = plain;
    const id = await conversationAt(plain, 'What time is check-out?');
    const drafted = await frontDesk.post(`/inbox/conversations/${id}/draft`);
    expect(drafted.statusCode, drafted.body).toBe(200);
    expect(drafted.json()).toMatchObject({ source: 'rules', needsStaff: false });
    expect(drafted.json().draft).toContain('Check-out is by 11:00.');
    expect((await housekeeper.post(`/inbox/conversations/${id}/draft`)).statusCode).toBe(403);
    expect((await elsewhere.post(`/inbox/conversations/${id}/draft`)).statusCode).toBe(403);
    expect((await rival.post(`/inbox/conversations/${id}/draft`)).statusCode).toBe(404);
  });

  it('translates when there is an AI service, and says so when there is not', async () => {
    const missing = await plain.frontDesk.post('/ai/translate', { text: 'Danke', target: 'en' });
    expect(missing.statusCode).toBe(503);
    expect(code(missing)).toBe('not_configured');

    model.answer({
      toolCalls: [
        {
          id: 't1',
          name: 'translation',
          input: { translation: 'Thank you', sourceLanguage: 'de' },
        },
      ],
    });
    const translated = await smart.frontDesk.post('/ai/translate', {
      text: 'Danke',
      target: 'EN',
    });
    expect(translated.statusCode, translated.body).toBe(200);
    expect(translated.json()).toEqual({ translation: 'Thank you', sourceLanguage: 'de' });
    expect(
      (await smart.frontDesk.post('/ai/translate', { text: 'Danke', target: 'english' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await smart.housekeeper.post('/ai/translate', { text: 'Danke', target: 'en' })).statusCode,
    ).toBe(403);
  });
});

describe('guest reviews', () => {
  let channel: FakeChannel;
  let connectionId: string;

  beforeAll(async () => {
    const { ctx, hotel } = plain;
    useFakeChannels();
    const created = await createConnection(ctx.t.db, ctx.org.admin, {
      propertyId: hotel.property.id,
      adapter: 'channex',
      config: { externalPropertyId: 'ext-property' },
    });
    await saveMappings(ctx.t.db, ctx.org.admin, created.id, {
      roomTypes: [{ roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' }],
      ratePlans: [{ ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' }],
    });
    await updateConnection(ctx.t.db, ctx.org.admin, created.id, { status: 'active' });
    connectionId = created.id;
    channel = fakeChannelFor(created.id);
    channel.reviews = [
      {
        id: 'good',
        channelCode: 'BDC',
        reservationCode: null,
        guestName: 'Asha Rao',
        overallScore: 9.5,
        scores: [],
        content: 'Spotless room and friendly staff.',
        receivedAt: new Date('2027-01-10T08:00:00Z'),
        hidden: false,
        reply: null,
      },
      {
        id: 'bad',
        channelCode: 'ABB',
        reservationCode: null,
        guestName: 'Kabir Sethi',
        overallScore: 4,
        scores: [],
        content: 'The room was dirty.',
        receivedAt: new Date('2027-01-12T08:00:00Z'),
        hidden: false,
        reply: null,
      },
    ];
  });

  it('are fetched on request, read, and shown to those who may see reports', async () => {
    const { frontDesk, housekeeper, reader, elsewhere, rival, hotel, ctx } = plain;
    const refresh = `/properties/${hotel.property.id}/reviews/refresh`;
    expect((await housekeeper.post(refresh)).statusCode).toBe(403);
    expect((await rival.post(refresh)).statusCode).toBe(404);
    const queued = await frontDesk.post(refresh);
    expect(queued.statusCode, queued.body).toBe(202);
    expect(queued.json()).toEqual({ queued: 1 });
    const waiting = await ctx.t.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, CHANNEL_JOBS.pullReviews));
    expect(waiting.map((j) => j.payload)).toEqual([{ connectionId }]);
    // What the worker then does.
    await pullReviews(ctx.t.db, connectionId);
    await analysePendingReviews(ctx.t.db, null);

    const listed = await reader.get('/reviews');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().reviews).toMatchObject([
      {
        externalId: 'bad',
        channelCode: 'ABB',
        overallScore: 40,
        sentiment: 'negative',
        propertyName: hotel.property.name,
      },
      { externalId: 'good', channelCode: 'BDC', overallScore: 95, sentiment: 'positive' },
    ]);
    const negative = await reader.get(
      `/reviews?propertyIds=${hotel.property.id}&sentiment=negative&unanswered=true`,
    );
    expect(negative.json().reviews).toMatchObject([{ externalId: 'bad' }]);

    const insights = await reader.get('/reviews/insights');
    expect(insights.statusCode, insights.body).toBe(200);
    expect(insights.json()).toMatchObject({
      count: 2,
      averageScore: 6.8,
      sentiment: { positive: 1, neutral: 0, negative: 1 },
      unanswered: 2,
      trend: [{ month: '2027-01', count: 2, averageScore: 6.8 }],
    });
    expect(insights.json().topics).toContainEqual({
      topic: 'cleanliness',
      positive: 1,
      negative: 1,
      neutral: 0,
    });

    // Staff of another property see their own reviews, which is none, and may not ask for these.
    expect((await elsewhere.get('/reviews')).json().reviews).toEqual([]);
    expect((await elsewhere.get('/reviews/insights')).json().count).toBe(0);
    expect((await elsewhere.get(`/reviews?propertyIds=${hotel.property.id}`)).statusCode).toBe(403);
    expect((await rival.get('/reviews')).json().reviews).toEqual([]);
    expect((await housekeeper.get('/reviews')).statusCode).toBe(403);
  });

  it('are answered by staff: a draft to edit, then one reply posted on the booking site', async () => {
    const { frontDesk, reader, elsewhere, rival, ctx } = plain;
    const [bad] = await ctx.t.db.select().from(reviews).where(eq(reviews.externalId, 'bad'));
    const draft = await frontDesk.post(`/reviews/${bad!.id}/draft-reply`);
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json().source).toBe('rules');
    expect(draft.json().draft).toMatch(/^Dear Kabir,\n\n.*We are sorry that/s);
    // Drafting needs the assistant; posting needs the right to write to guests.
    expect((await reader.post(`/reviews/${bad!.id}/draft-reply`)).statusCode).toBe(403);
    expect((await reader.post(`/reviews/${bad!.id}/reply`, { text: 'Sorry.' })).statusCode).toBe(
      403,
    );
    expect((await elsewhere.post(`/reviews/${bad!.id}/reply`, { text: 'Sorry.' })).statusCode).toBe(
      403,
    );
    expect((await rival.post(`/reviews/${bad!.id}/reply`, { text: 'Sorry.' })).statusCode).toBe(
      404,
    );
    expect((await frontDesk.post(`/reviews/${bad!.id}/reply`, { text: '   ' })).statusCode).toBe(
      400,
    );

    const posted = await frontDesk.post(`/reviews/${bad!.id}/reply`, {
      text: 'Dear Kabir, we are sorry about the room.',
    });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json()).toMatchObject({
      reply: 'Dear Kabir, we are sorry about the room.',
      replyStatus: 'queued',
    });
    const outgoing = await ctx.t.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, CHANNEL_JOBS.replyReview));
    expect(outgoing.map((j) => j.payload)).toEqual([{ reviewId: bad!.id }]);
    // Nothing reaches the booking site from the request itself.
    expect(channel.reviewReplies).toEqual([]);
  });
});

describe('insights for operations', () => {
  it('scores upcoming arrivals and suggests rooms, for those who may see reservations', async () => {
    const { frontDesk, housekeeper, reader, elsewhere, rival, hotel, other, ctx } = plain;
    const stay = await book(plain, 3, 5);
    const later = await book(plain, 5, 6);
    const base = `/properties/${hotel.property.id}/insights`;

    const risky = await reader.get(`${base}/arrivals-risk?days=10`);
    expect(risky.statusCode, risky.body).toBe(200);
    const arrivals = risky.json().arrivals as {
      reservationId: string;
      code: string;
      cancellation: number;
      noShow: number;
      level: string;
      factors: string[];
    }[];
    expect(arrivals.map((a) => a.code).sort()).toEqual([stay.code, later.code].sort());
    expect(arrivals[0]!.factors).toContain('Nothing paid yet');
    const one = await reader.get(`/reservations/${stay.id}/risk`);
    expect(one.json()).toMatchObject({
      reservationId: stay.id,
      cancellation: arrivals.find((a) => a.code === stay.code)!.cancellation,
    });
    expect((await elsewhere.get(`${base}/arrivals-risk`)).statusCode).toBe(403);
    expect((await elsewhere.get(`/reservations/${stay.id}/risk`)).statusCode).toBe(403);
    expect((await rival.get(`/reservations/${stay.id}/risk`)).statusCode).toBe(404);
    expect((await reader.get(`${base}/arrivals-risk?days=0`)).statusCode).toBe(400);

    // Back to back in one room, rather than a night's gap in each of two.
    const suggested = await reader.get(`${base}/assignments?days=10`);
    expect(suggested.statusCode, suggested.body).toBe(200);
    const [plan] = suggested.json().plans as {
      roomTypeId: string;
      assignments: { reservationId: string; roomId: string; unitId: string; code: string }[];
      unplaced: unknown[];
    }[];
    expect(plan!.roomTypeId).toBe(hotel.standard.roomType.id);
    expect(plan!.unplaced).toEqual([]);
    const picks = plan!.assignments.filter((a) => [stay.code, later.code].includes(a.code));
    expect(picks).toHaveLength(2);
    expect(picks[0]!.unitId).toBe(picks[1]!.unitId);

    const body = {
      assignments: picks.map(({ reservationId, roomId, unitId }) => ({
        reservationId,
        roomId,
        unitId,
      })),
    };
    expect((await reader.post(`${base}/assignments/apply`, body)).statusCode).toBe(403);
    expect((await housekeeper.post(`${base}/assignments/apply`, body)).statusCode).toBe(403);
    // A stay of another property cannot be slipped in under this one's address.
    const foreign = await book(plain, 3, 4, 1, other);
    const [foreignRoom] = await ctx.t.db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, foreign.id));
    const smuggled = await plain.admin.post(`${base}/assignments/apply`, {
      assignments: [
        { reservationId: foreign.id, roomId: foreignRoom!.id, unitId: picks[0]!.unitId },
      ],
    });
    expect(smuggled.statusCode).toBe(400);

    const applied = await frontDesk.post(`${base}/assignments/apply`, body);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({ applied: 2, failed: [] });
    const rooms = await ctx.t.db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.reservationId, stay.id));
    expect(rooms[0]!.unitId).toBe(picks[0]!.unitId);
    // Nothing left to place.
    const after = (await reader.get(`${base}/assignments?days=10`)).json().plans as {
      assignments: { code: string }[];
    }[];
    expect(
      after.flatMap((p) => p.assignments).filter((a) => [stay.code, later.code].includes(a.code)),
    ).toEqual([]);
  });

  it('forecasts the cleaning ahead for housekeeping', async () => {
    const { housekeeper, elsewhere, rival, hotel } = plain;
    const url = `/properties/${hotel.property.id}/insights/housekeeping?days=7`;
    const forecast = await housekeeper.get(url);
    expect(forecast.statusCode, forecast.body).toBe(200);
    const days = forecast.json().days as {
      date: string;
      departures: number;
      stayovers: number;
      arrivals: number;
      minutes: number;
      staff: number;
    }[];
    expect(days).toHaveLength(7);
    expect(days[0]!.date).toBe(today);
    // The stays booked above: in on day 3, one out and one in on day 5, out on day 6.
    expect(days[3]).toMatchObject({ arrivals: 1, departures: 0 });
    expect(days[4]).toMatchObject({ stayovers: 1, minutes: 20, staff: 1 });
    expect(days[5]).toMatchObject({ arrivals: 1, departures: 1, minutes: 45 });
    expect(days[6]).toMatchObject({ departures: 1 });
    expect((await elsewhere.get(url)).statusCode).toBe(403);
    expect((await rival.get(url)).statusCode).toBe(404);
  });
});

describe('identity documents', () => {
  const photo = Buffer.concat([
    Buffer.from('ffd8ffe000104a464946', 'hex'),
    Buffer.from('a passport photo'),
  ]);
  const send = (client: TestClient, reservationId: string, payload: Buffer, type = 'image/jpeg') =>
    client.request({
      method: 'POST',
      url: `/reservations/${reservationId}/id-capture`,
      headers: { 'content-type': type },
      payload,
    });

  it('are not sent anywhere unless the organisation switched that on', async () => {
    const stay = await book(plain, 20, 21);
    const refused = await send(plain.frontDesk, stay.id, photo);
    expect(refused.statusCode).toBe(503);
    expect(code(refused)).toBe('not_configured');
    expect(refused.json().error.message).toMatch(/switched off/);
  });

  it('are read for the front desk to check, and nothing about them is kept', async () => {
    const { frontDesk, reader, housekeeper, elsewhere, rival, ctx } = smart;
    const stay = await book(smart, 20, 21);
    model.answer((request) => {
      // The photo itself goes to the model, with nothing about the guest alongside it.
      expect(JSON.stringify(request.messages)).not.toContain('Fischer');
      return {
        toolCalls: [
          {
            id: 't1',
            name: 'identity_document',
            input: {
              documentType: 'passport',
              fullName: 'LENA FISCHER',
              documentNumber: 'C01X00T47',
              nationality: 'de',
              issuingCountry: 'DE',
              dateOfBirth: '1990-02-30',
              expiryDate: '2031-05-04',
              address: null,
              legible: true,
            },
          },
        ],
      };
    });
    const read = await send(frontDesk, stay.id, photo);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({
      documentType: 'passport',
      fullName: 'LENA FISCHER',
      documentNumber: 'C01X00T47',
      nationality: 'DE',
      issuingCountry: 'DE',
      // 30 February is not a date: left for a person to fill in.
      dateOfBirth: null,
      expiryDate: '2031-05-04',
      address: null,
      legible: true,
    });
    // That a document was read is on record; what it said is not.
    const [entry] = await ctx.t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'guest.id_captured'), eq(auditLog.entityId, stay.id)));
    expect(entry).toMatchObject({ summary: 'Read an identity document with the AI service' });
    expect(JSON.stringify(entry)).not.toContain('C01X00T47');
    const runs = await ctx.t.db.select().from(aiRuns).where(eq(aiRuns.feature, 'id_capture'));
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs)).not.toContain('C01X00T47');

    // Identity documents take the permission for identity data.
    for (const client of [reader, housekeeper, elsewhere]) {
      expect((await send(client, stay.id, photo)).statusCode).toBe(403);
    }
    expect((await send(rival, stay.id, photo)).statusCode).toBe(404);
    expect((await send(frontDesk, 'not-an-id', photo)).statusCode).toBe(404);
    // Not a photo, whatever the label says.
    const mislabelled = await send(frontDesk, stay.id, Buffer.from('just some text'));
    expect(mislabelled.statusCode).toBe(400);
    expect((await send(frontDesk, stay.id, photo, 'application/pdf')).statusCode).toBe(415);
    // None of the refused requests reached the AI service.
    expect(
      model.requests.filter((r) =>
        JSON.stringify(r.toolChoice ?? null).includes('identity_document'),
      ),
    ).toHaveLength(1);
  });
});

describe('use of the AI service', () => {
  it('is counted by feature for the organisation\u2019s administrators', async () => {
    const { admin, frontDesk, rival } = smart;
    expect((await frontDesk.get('/ai/usage')).statusCode).toBe(403);
    const usage = (await admin.get('/ai/usage')).json().usage as {
      feature: string;
      calls: number;
      failed: number;
      inputTokens: number;
      outputTokens: number;
    }[];
    expect(usage).toEqual([
      { feature: 'copilot', calls: 2, failed: 0, inputTokens: 20, outputTokens: 10 },
      { feature: 'id_capture', calls: 1, failed: 0, inputTokens: 10, outputTokens: 5 },
      { feature: 'translate', calls: 1, failed: 0, inputTokens: 10, outputTokens: 5 },
    ]);
    // Another organisation's calls are its own.
    expect((await rival.get('/ai/usage')).json().usage).toEqual([]);
    expect((await plain.admin.get('/ai/usage')).json().usage).toEqual([]);
  });

  it('holds each person to a sensible number of requests', async () => {
    const { reader, frontDesk, hotel } = plain;
    const refresh = `/properties/${hotel.property.id}/reviews/refresh`;
    const answers: number[] = [];
    for (let i = 0; i < 7; i++) answers.push((await reader.post(refresh)).statusCode);
    expect(answers).toEqual([202, 202, 202, 202, 202, 202, 429]);
    // One person's limit is not another's, though they share an address.
    expect((await frontDesk.post(refresh)).statusCode).toBe(202);
  });
});
