import { and, eq, sql } from 'drizzle-orm';
import { channelConnections, reservations, reviews, type DbOrTx } from '@pms/db';
import {
  enqueueJob,
  invalidState,
  notFound,
  raiseAlert,
  transact,
  validationError,
  writeAudit,
  type Actor,
} from '@pms/domain';
import { ChannelError } from '../adapter';
import { CHANNEL_JOBS } from '../jobs';
import { adapterFor } from './connections';

export interface ReviewPull {
  outcome: 'ok' | 'unsupported' | 'unavailable';
  /** Reviews that were not on file before. */
  fresh: number;
}

/**
 * Reads the booking sites' reviews for a connection and files the new ones.
 * A review already on file is refreshed (the guest's text can appear later,
 * and a reply posted on the site itself shows up here).
 */
export async function pullReviews(db: DbOrTx, connectionId: string): Promise<ReviewPull> {
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, connectionId));
  if (!connection) return { outcome: 'unsupported', fresh: 0 };
  const adapter = adapterFor(connection);
  if (!adapter.listReviews) return { outcome: 'unsupported', fresh: 0 };
  let list;
  try {
    list = await adapter.listReviews();
  } catch (err) {
    // Reviews are an add-on at the channel manager: a property without it answers "forbidden".
    if (err instanceof ChannelError && !err.retryable) return { outcome: 'unavailable', fresh: 0 };
    throw err;
  }
  let fresh = 0;
  for (const review of list) {
    if (Number.isNaN(review.receivedAt.getTime())) continue;
    const [reservation] = review.reservationCode
      ? await db
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              eq(reservations.propertyId, connection.propertyId),
              eq(reservations.channelReservationCode, review.reservationCode),
            ),
          )
          .limit(1)
      : [];
    const values = {
      channelCode: review.channelCode,
      reservationId: reservation?.id ?? null,
      otaReservationCode: review.reservationCode,
      guestName: review.guestName,
      overallScore: review.overallScore === null ? null : Math.round(review.overallScore * 10),
      scores: review.scores,
      content: review.content,
      hidden: review.hidden,
    };
    const inserted = await db
      .insert(reviews)
      .values({
        orgId: connection.orgId,
        propertyId: connection.propertyId,
        connectionId: connection.id,
        externalId: review.id,
        receivedAt: review.receivedAt,
        reply: review.reply,
        replyStatus: review.reply ? 'sent' : 'none',
        ...values,
      })
      .onConflictDoNothing()
      .returning({ id: reviews.id });
    if (inserted.length > 0) {
      fresh++;
      continue;
    }
    await db
      .update(reviews)
      .set({
        ...values,
        // Text that arrived after the first reading is read again.
        analysedAt: sql`CASE WHEN ${reviews.content} IS DISTINCT FROM ${review.content} THEN NULL ELSE ${reviews.analysedAt} END`,
        // A reply written on the booking site itself is taken over; one waiting to be sent from here is left alone.
        ...(review.reply
          ? {
              reply: sql`CASE WHEN ${reviews.replyStatus} = 'queued' THEN ${reviews.reply} ELSE ${review.reply} END`,
              replyStatus: sql`CASE WHEN ${reviews.replyStatus} = 'queued' THEN 'queued' ELSE 'sent' END`,
            }
          : {}),
      })
      .where(and(eq(reviews.connectionId, connection.id), eq(reviews.externalId, review.id)));
  }
  return { outcome: 'ok', fresh };
}

/** Saves the property's reply to a review and queues it to be posted on the booking site. */
export async function queueReviewReply(
  db: DbOrTx,
  actor: Actor,
  reviewId: string,
  text: string,
): Promise<typeof reviews.$inferSelect> {
  const reply = text.trim();
  if (!reply) throw validationError('Write a reply first');
  if (reply.length > 4000) throw validationError('A reply can be at most 4,000 characters');
  return transact(db, async (tx) => {
    const [review] = await tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.orgId, actor.orgId)))
      .for('update');
    if (!review) throw notFound('Review', reviewId);
    if (review.replyStatus === 'sent') {
      throw invalidState('This review has already been answered; booking sites take one reply');
    }
    if (!review.connectionId)
      throw invalidState('This review did not come through a booking site connection');
    const [updated] = await tx
      .update(reviews)
      .set({
        reply,
        replyStatus: 'queued',
        replyError: null,
        repliedBy: actor.userId ?? null,
      })
      .where(eq(reviews.id, reviewId))
      .returning();
    await enqueueJob(
      tx,
      CHANNEL_JOBS.replyReview,
      { reviewId },
      { uniqueKey: `${CHANNEL_JOBS.replyReview}:${reviewId}`, maxAttempts: 5 },
    );
    await writeAudit(tx, actor, {
      action: 'review.reply_queued',
      entityType: 'review',
      entityId: reviewId,
      propertyId: review.propertyId,
      summary: `Replied to a review${review.guestName ? ` from ${review.guestName}` : ''}`,
    });
    return updated!;
  });
}

/** Posts a queued reply. Run by the worker; throws for a failure worth retrying. */
export async function sendReviewReply(
  db: DbOrTx,
  reviewId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<'sent' | 'failed' | 'skipped'> {
  const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
  if (!review || review.replyStatus !== 'queued' || !review.reply || !review.connectionId) {
    return 'skipped';
  }
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, review.connectionId));
  const fail = async (error: string): Promise<'failed'> => {
    await db
      .update(reviews)
      .set({ replyStatus: 'failed', replyError: error.slice(0, 500) })
      .where(eq(reviews.id, reviewId));
    await raiseAlert(db, {
      orgId: review.orgId,
      propertyId: review.propertyId,
      kind: 'message_failed',
      severity: 'warning',
      title: 'A reply to a guest review could not be posted',
      body: `${error} Open the review to try again, or answer it on the booking site itself.`,
      entityType: 'review',
      entityId: review.id,
      dedupeKey: `review_reply_failed:${review.id}`,
    });
    return 'failed';
  };
  if (!connection) return fail('The booking site connection no longer exists.');
  const adapter = adapterFor(connection);
  if (!adapter.replyToReview) return fail('This kind of connection cannot post replies.');
  try {
    await adapter.replyToReview(review.externalId, review.reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err instanceof ChannelError && !err.retryable) || options.finalAttempt)
      return fail(message);
    throw err;
  }
  await db
    .update(reviews)
    .set({ replyStatus: 'sent', replyError: null, repliedAt: new Date() })
    .where(eq(reviews.id, reviewId));
  return 'sent';
}
