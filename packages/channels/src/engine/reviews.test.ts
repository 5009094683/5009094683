import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, auditLog, jobs, reviews } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createTestHotel, createTestOrg, type TestOrg } from '@pms/domain/testing';
import { ChannelError, type ChannelReview } from '../adapter';
import { handleChannexWebhook } from '../channex/webhook';
import { CHANNEL_JOBS } from '../jobs';
import { bookingEvent, type FakeChannel, fakeChannelFor, useFakeChannels } from '../testing';
import {
  createConnection,
  saveMappings,
  updateConnection,
  type ConnectionRow,
} from './connections';
import { ingestBookingEvent } from './inbound';
import { pullReviews, queueReviewReply, sendReviewReply } from './reviews';

let t: TestDatabase;
let org: TestOrg;
let connection: ConnectionRow;
let channel: FakeChannel;

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
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  channel.reviews = [];
  channel.reviewReplies.length = 0;
  channel.failReviewReply = null;
  channel.failListReviews = null;
  channel.hasReviews = true;
  await t.db.delete(reviews);
  await t.db.delete(jobs);
});

let seq = 0;
const review = (overrides: Partial<ChannelReview> = {}): ChannelReview => ({
  id: `review-${++seq}`,
  channelCode: 'BDC',
  reservationCode: null,
  guestName: 'Lena Fischer',
  overallScore: 8.5,
  scores: [{ category: 'clean', score: 9 }],
  content: 'Lovely stay.',
  receivedAt: new Date('2027-01-16T08:00:00Z'),
  hidden: false,
  reply: null,
  ...overrides,
});

const stored = async (externalId: string) => {
  const [row] = await t.db
    .select()
    .from(reviews)
    .where(and(eq(reviews.connectionId, connection.id), eq(reviews.externalId, externalId)));
  return row!;
};

describe('reviews from booking sites', () => {
  it('files a review once, under the reservation it is about', async () => {
    const booked = await ingestBookingEvent(
      t.db,
      connection,
      bookingEvent({
        channelReservationCode: 'BDC-777',
        rooms: [
          {
            externalRoomTypeId: 'ext-std',
            externalRatePlanId: 'ext-std-bar',
            checkIn: '2027-01-12',
            checkOut: '2027-01-15',
          },
        ],
      }),
      'webhook',
    );
    const about = review({ reservationCode: 'BDC-777' });
    const loose = review({ overallScore: null, scores: [], content: null, guestName: null });
    channel.reviews = [about, loose, review({ receivedAt: new Date('nonsense') })];

    // The one with no usable date is passed over; it is not filed under a made-up one.
    expect(await pullReviews(t.db, connection.id)).toEqual({ outcome: 'ok', fresh: 2 });
    expect(await stored(about.id)).toMatchObject({
      orgId: org.orgId,
      propertyId: connection.propertyId,
      channelCode: 'BDC',
      reservationId: booked.reservationId,
      otaReservationCode: 'BDC-777',
      guestName: 'Lena Fischer',
      // Out of 100, so that 8.5 stays a whole number.
      overallScore: 85,
      scores: [{ category: 'clean', score: 9 }],
      content: 'Lovely stay.',
      reply: null,
      replyStatus: 'none',
      analysedAt: null,
    });
    expect(await stored(loose.id)).toMatchObject({
      reservationId: null,
      overallScore: null,
      content: null,
    });

    expect(await pullReviews(t.db, connection.id)).toEqual({ outcome: 'ok', fresh: 0 });
    expect(await t.db.select().from(reviews)).toHaveLength(2);
  });

  it('takes up text and a reply that appear later, and has changed text read again', async () => {
    const scoreOnly = review({ content: null });
    channel.reviews = [scoreOnly];
    await pullReviews(t.db, connection.id);
    const read = new Date('2027-01-17T00:00:00Z');
    await t.db
      .update(reviews)
      .set({ analysedAt: read, sentiment: 'positive', analysedBy: 'rules' })
      .where(eq(reviews.externalId, scoreOnly.id));

    // Nothing changed: what was worked out about it stands.
    await pullReviews(t.db, connection.id);
    expect((await stored(scoreOnly.id)).analysedAt).toEqual(read);

    // The guest's words arrive, and the manager answers on the booking site itself.
    channel.reviews = [
      { ...scoreOnly, content: 'The room was noisy.', reply: 'Sorry about the noise.' },
    ];
    await pullReviews(t.db, connection.id);
    expect(await stored(scoreOnly.id)).toMatchObject({
      content: 'The room was noisy.',
      analysedAt: null,
      reply: 'Sorry about the noise.',
      replyStatus: 'sent',
    });
  });

  it('says so when the connection has no reviews to give', async () => {
    channel.reviews = [review()];
    // The reviews add-on is not switched on for this property.
    channel.failListReviews = new ChannelError('forbidden', { retryable: false, status: 403 });
    expect(await pullReviews(t.db, connection.id)).toEqual({ outcome: 'unavailable', fresh: 0 });
    // An outage is for the job queue to retry.
    channel.failListReviews = new ChannelError('down', { retryable: true, status: 503 });
    await expect(pullReviews(t.db, connection.id)).rejects.toThrow('down');
    channel.failListReviews = null;
    // A kind of connection that carries no reviews, such as a calendar feed.
    channel.hasReviews = false;
    expect(await pullReviews(t.db, connection.id)).toEqual({ outcome: 'unsupported', fresh: 0 });
    expect(await pullReviews(t.db, '00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'unsupported',
      fresh: 0,
    });
    expect(await t.db.select().from(reviews)).toHaveLength(0);
  });

  it('queues one read when the channel manager announces a review', async () => {
    const announce = () =>
      handleChannexWebhook(t.db, {
        event: 'review',
        property_id: 'ext-property',
        payload: { id: 'whatever', content: 'This text is never trusted' },
      });
    expect(await announce()).toMatchObject({
      action: 'reviews_queued',
      connectionId: connection.id,
    });
    await announce();
    const queued = await t.db.select().from(jobs).where(eq(jobs.kind, CHANNEL_JOBS.pullReviews));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ connectionId: connection.id });
    // Nothing is taken from the announcement itself.
    expect(await t.db.select().from(reviews)).toHaveLength(0);
  });
});

describe('replying to a review', () => {
  const filed = async (overrides: Partial<ChannelReview> = {}) => {
    const item = review(overrides);
    channel.reviews = [item];
    await pullReviews(t.db, connection.id);
    return stored(item.id);
  };

  it('posts the reply on the booking site, once', async () => {
    const row = await filed();
    await expect(queueReviewReply(t.db, org.admin, row.id, '   ')).rejects.toMatchObject({
      code: 'validation',
    });
    const queued = await queueReviewReply(t.db, org.admin, row.id, '  Thank you, Lena!  ');
    expect(queued).toMatchObject({
      reply: 'Thank you, Lena!',
      replyStatus: 'queued',
      repliedBy: org.adminUserId,
    });
    const waiting = await t.db.select().from(jobs).where(eq(jobs.kind, CHANNEL_JOBS.replyReview));
    expect(waiting.map((j) => j.payload)).toEqual([{ reviewId: row.id }]);
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'review.reply_queued'), eq(auditLog.entityId, row.id)));
    expect(entry!.summary).toBe('Replied to a review from Lena Fischer');

    // Reading the reviews again before the reply has gone out does not lose it.
    await pullReviews(t.db, connection.id);
    expect(await stored(row.externalId)).toMatchObject({
      reply: 'Thank you, Lena!',
      replyStatus: 'queued',
    });

    expect(await sendReviewReply(t.db, row.id)).toBe('sent');
    expect(channel.reviewReplies).toEqual([{ reviewId: row.externalId, text: 'Thank you, Lena!' }]);
    const sent = await stored(row.externalId);
    expect(sent).toMatchObject({ replyStatus: 'sent', replyError: null });
    expect(sent.repliedAt).toBeInstanceOf(Date);

    // The job running twice posts nothing more, and a second reply is refused.
    expect(await sendReviewReply(t.db, row.id)).toBe('skipped');
    expect(channel.reviewReplies).toHaveLength(1);
    await expect(queueReviewReply(t.db, org.admin, row.id, 'Once more')).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('keeps a review of another organisation out of reach', async () => {
    const row = await filed();
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(queueReviewReply(t.db, rival.admin, row.id, 'Hello')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await stored(row.externalId)).replyStatus).toBe('none');
  });

  it('retries an outage, and tells staff when the reply cannot be posted', async () => {
    const row = await filed();
    await queueReviewReply(t.db, org.admin, row.id, 'Thank you!');

    channel.failReviewReply = new ChannelError('down', { retryable: true, status: 503 });
    await expect(sendReviewReply(t.db, row.id)).rejects.toThrow('down');
    expect((await stored(row.externalId)).replyStatus).toBe('queued');

    // The last attempt gives up in the open rather than failing quietly.
    expect(await sendReviewReply(t.db, row.id, { finalAttempt: true })).toBe('failed');
    expect(await stored(row.externalId)).toMatchObject({
      replyStatus: 'failed',
      replyError: 'down',
    });
    const [alert] = await t.db
      .select()
      .from(alerts)
      .where(eq(alerts.dedupeKey, `review_reply_failed:${row.id}`));
    expect(alert).toMatchObject({
      kind: 'message_failed',
      severity: 'warning',
      propertyId: connection.propertyId,
      entityType: 'review',
      entityId: row.id,
    });
    expect(alert!.body).toMatch(/answer it on the booking site itself/);

    // Staff try again once the site is back.
    channel.failReviewReply = null;
    await queueReviewReply(t.db, org.admin, row.id, 'Thank you!');
    expect(await sendReviewReply(t.db, row.id)).toBe('sent');
    expect(channel.reviewReplies).toHaveLength(1);

    // A refusal by the booking site is final at once.
    const second = await filed();
    await queueReviewReply(t.db, org.admin, second.id, 'Thanks');
    channel.failReviewReply = new ChannelError('Reply has already been given', {
      retryable: false,
      status: 422,
    });
    expect(await sendReviewReply(t.db, second.id)).toBe('failed');
    expect((await stored(second.externalId)).replyError).toBe('Reply has already been given');
  });
});
