import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { conversations, RECOMMENDATION_STATUSES, reviews, SENTIMENTS } from '@pms/db';
import {
  applyAssignments,
  applyRecommendations,
  arrivalsAtRisk,
  captureIdDocument,
  confirmAction,
  dismissRecommendations,
  draftReply,
  draftReviewReply,
  generateRecommendations,
  housekeepingForecast,
  listRecommendations,
  listReviews,
  pendingActions,
  recommendationsProperty,
  rejectAction,
  reservationRisks,
  reviewInsights,
  runCopilot,
  suggestAssignments,
  translateText,
} from '@pms/ai';
import { CHANNEL_JOBS, queueReviewReply } from '@pms/channels';
import { DomainError, enqueueJob, notFound, validationError, type Actor } from '@pms/domain';
import { dateString, idParams, propertyParams, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty, authorizeReservation, scopedProperties } from '../lib/scope';
import { authorize } from '../plugins/auth';

/** A limit counted per signed-in person, not per address: the staff of one hotel share an address. */
const perUser = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest): string => req.session?.user.id ?? req.ip,
  },
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/ai/status',
    { schema: { tags: ['assistant'], summary: 'Which AI features this installation has' } },
    async (req) => {
      authorize(req);
      return {
        // With no AI service the same features answer from built-in rules.
        provider: app.ai?.name ?? null,
        model: app.ai?.model ?? null,
        documentCapture: Boolean(app.env.AI_DOCUMENT_CAPTURE_ENABLED && app.ai?.vision),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // The assistant

  r.post(
    '/ai/copilot',
    {
      config: perUser(30),
      schema: {
        tags: ['assistant'],
        summary: 'Ask the assistant something. Changes it proposes wait for confirmation.',
        body: z.object({
          messages: z
            .array(
              z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string().min(1).max(4000),
              }),
            )
            .min(1)
            .max(40),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'ai.use');
      return runCopilot(app.db, app.ai, actor, req.body.messages);
    },
  );

  r.get('/ai/actions', { schema: { tags: ['assistant'] } }, async (req) => {
    const actor = authorize(req, 'ai.use');
    return { actions: await pendingActions(app.db, actor) };
  });

  r.post(
    '/ai/actions/:id/confirm',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Carry out a change the assistant proposed to you',
        params: idParams,
      },
    },
    async (req) => {
      const actor = authorize(req, 'ai.use');
      return confirmAction(app.db, actor, req.params.id);
    },
  );

  r.post(
    '/ai/actions/:id/reject',
    { schema: { tags: ['assistant'], params: idParams } },
    async (req, reply) => {
      const actor = authorize(req, 'ai.use');
      await rejectAction(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // Rate suggestions

  r.get(
    '/properties/:propertyId/pricing/recommendations',
    {
      schema: {
        tags: ['pricing'],
        params: propertyParams,
        querystring: z.object({
          from: dateString.optional(),
          to: dateString.optional(),
          status: z.enum(RECOMMENDATION_STATUSES).optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'rates.read');
      return {
        recommendations: await listRecommendations(app.db, actor.orgId, {
          propertyId: req.params.propertyId,
          ...req.query,
        }),
      };
    },
  );

  r.post(
    '/properties/:propertyId/pricing/refresh',
    {
      config: perUser(6),
      schema: {
        tags: ['pricing'],
        summary: 'Work the suggestions out again now, from how the nights are selling',
        params: propertyParams,
      },
    },
    async (req) => {
      await authorizeProperty(app.db, req, req.params.propertyId, 'rates.write');
      return generateRecommendations(app.db, req.params.propertyId);
    },
  );

  const decide = z.object({ ids: z.array(uuid).min(1).max(1000) });
  const approver = async (req: FastifyRequest, ids: string[]): Promise<Actor> => {
    const session = authorize(req, 'ai.pricing.approve');
    return authorize(
      req,
      'ai.pricing.approve',
      await recommendationsProperty(app.db, session.orgId, ids),
    );
  };

  r.post(
    '/pricing/recommendations/apply',
    {
      schema: {
        tags: ['pricing'],
        summary: 'Set the suggested rates. They reach the booking sites like any rate change.',
        body: decide,
      },
    },
    async (req) => {
      const actor = await approver(req, req.body.ids);
      return { applied: await applyRecommendations(app.db, actor, req.body.ids) };
    },
  );

  r.post(
    '/pricing/recommendations/dismiss',
    { schema: { tags: ['pricing'], body: decide } },
    async (req) => {
      const actor = await approver(req, req.body.ids);
      return { dismissed: await dismissRecommendations(app.db, actor, req.body.ids) };
    },
  );

  // ---------------------------------------------------------------------------
  // Replies and translation

  r.post(
    '/inbox/conversations/:id/draft',
    {
      config: perUser(30),
      schema: {
        tags: ['assistant'],
        summary: 'Suggest a reply to the guest. Nothing is sent.',
        params: idParams,
      },
    },
    async (req) => {
      const session = authorize(req, 'ai.use');
      const [row] = await app.db
        .select({ propertyId: conversations.propertyId })
        .from(conversations)
        .where(and(eq(conversations.id, req.params.id), eq(conversations.orgId, session.orgId)));
      if (!row) throw notFound('Conversation', req.params.id);
      const actor = authorize(req, 'inbox.read', row.propertyId ?? undefined);
      return draftReply(app.db, app.ai, actor, req.params.id);
    },
  );

  r.post(
    '/ai/translate',
    {
      config: perUser(30),
      schema: {
        tags: ['assistant'],
        body: z.object({
          text: z.string().min(1).max(6000),
          target: z.string().regex(/^[a-z]{2}$/i, 'A two-letter language code'),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'ai.use');
      if (!app.ai) {
        throw new DomainError(
          'not_configured',
          'Translation needs an AI service, and none is configured',
        );
      }
      return translateText(app.db, app.ai, actor, req.body.text, req.body.target.toLowerCase());
    },
  );

  // ---------------------------------------------------------------------------
  // Reviews

  const reviewQuery = z.object({
    propertyIds: uuidList,
    from: dateString.optional(),
    to: dateString.optional(),
  });

  r.get(
    '/reviews',
    {
      schema: {
        tags: ['reviews'],
        querystring: reviewQuery.extend({
          sentiment: z.enum(SENTIMENTS).optional(),
          unanswered: z.enum(['true', 'false']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(req, 'reports.read', req.query.propertyIds);
      return {
        reviews: await listReviews(app.db, actor.orgId, {
          ...req.query,
          propertyIds,
          unanswered: req.query.unanswered === 'true',
        }),
      };
    },
  );

  r.get(
    '/reviews/insights',
    {
      schema: {
        tags: ['reviews'],
        summary: 'What guests are saying: scores, mood, subjects, by booking site and by month',
        querystring: reviewQuery,
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(req, 'reports.read', req.query.propertyIds);
      return reviewInsights(app.db, actor.orgId, { ...req.query, propertyIds });
    },
  );

  const reviewProperty = async (req: FastifyRequest, reviewId: string): Promise<string> => {
    const session = authorize(req);
    const [row] = await app.db
      .select({ propertyId: reviews.propertyId })
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), eq(reviews.orgId, session.orgId)));
    if (!row) throw notFound('Review', reviewId);
    return row.propertyId;
  };

  r.post(
    '/reviews/:id/draft-reply',
    {
      config: perUser(30),
      schema: {
        tags: ['reviews'],
        summary: 'Suggest a public reply. Nothing is posted.',
        params: idParams,
      },
    },
    async (req) => {
      const actor = authorize(req, 'ai.use', await reviewProperty(req, req.params.id));
      return draftReviewReply(app.db, app.ai, actor, req.params.id);
    },
  );

  r.post(
    '/reviews/:id/reply',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Post the property\u2019s public reply on the booking site',
        params: idParams,
        body: z.object({ text: z.string().trim().min(1).max(4000) }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'inbox.write', await reviewProperty(req, req.params.id));
      return queueReviewReply(app.db, actor, req.params.id, req.body.text);
    },
  );

  r.post(
    '/properties/:propertyId/reviews/refresh',
    {
      config: perUser(6),
      schema: {
        tags: ['reviews'],
        summary: 'Fetch reviews from the booking sites now',
        params: propertyParams,
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'reports.read');
      const { rows } = await app.db.execute<{ id: string }>(sql`
        SELECT id FROM channel_connections
        WHERE org_id = ${actor.orgId} AND property_id = ${req.params.propertyId}
          AND status IN ('active', 'error')
      `);
      for (const { id } of rows) {
        await enqueueJob(
          app.db,
          CHANNEL_JOBS.pullReviews,
          { connectionId: id },
          { uniqueKey: `${CHANNEL_JOBS.pullReviews}:${id}`, maxAttempts: 4 },
        );
      }
      return reply.status(202).send({ queued: rows.length });
    },
  );

  // ---------------------------------------------------------------------------
  // Operational insights

  r.get(
    '/properties/:propertyId/insights/arrivals-risk',
    {
      schema: {
        tags: ['insights'],
        summary: 'Upcoming arrivals with how likely each is to cancel or not turn up',
        params: propertyParams,
        querystring: z.object({ days: z.coerce.number().int().min(1).max(60).optional() }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'reservations.read',
      );
      return {
        arrivals: await arrivalsAtRisk(app.db, actor.orgId, req.params.propertyId, {
          days: req.query.days,
        }),
      };
    },
  );

  r.get(
    '/reservations/:id/risk',
    { schema: { tags: ['insights'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'reservations.read');
      const [risk] = await reservationRisks(app.db, actor.orgId, [req.params.id]);
      return risk ?? null;
    },
  );

  r.get(
    '/properties/:propertyId/insights/assignments',
    {
      schema: {
        tags: ['insights'],
        summary: 'Rooms suggested for stays that have none, leaving the fewest gaps',
        params: propertyParams,
        querystring: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'reservations.read',
      );
      return {
        plans: await suggestAssignments(app.db, actor.orgId, req.params.propertyId, {
          days: req.query.days,
        }),
      };
    },
  );

  r.post(
    '/properties/:propertyId/insights/assignments/apply',
    {
      schema: {
        tags: ['insights'],
        params: propertyParams,
        body: z.object({
          assignments: z
            .array(z.object({ reservationId: uuid, roomId: uuid, unitId: uuid }))
            .min(1)
            .max(500),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'reservations.write',
      );
      // Every reservation named must be one of this property's.
      for (const reservationId of new Set(req.body.assignments.map((a) => a.reservationId))) {
        const { propertyId } = await authorizeReservation(
          app.db,
          req,
          reservationId,
          'reservations.write',
        );
        if (propertyId !== req.params.propertyId) {
          throw validationError('Every stay must belong to this property');
        }
      }
      return applyAssignments(app.db, actor, req.body.assignments);
    },
  );

  r.get(
    '/properties/:propertyId/insights/housekeeping',
    {
      schema: {
        tags: ['insights'],
        summary: 'Cleaning work ahead, day by day',
        params: propertyParams,
        querystring: z.object({ days: z.coerce.number().int().min(1).max(30).optional() }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'housekeeping.read',
      );
      return housekeepingForecast(app.db, actor.orgId, req.params.propertyId, {
        days: req.query.days,
      });
    },
  );

  r.get(
    '/ai/usage',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Calls made to the AI service in the last 30 days, by feature',
      },
    },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      const { rows } = await app.db.execute<{
        feature: string;
        calls: number;
        failed: number;
        input_tokens: string;
        output_tokens: string;
      }>(sql`
        SELECT feature, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
          coalesce(sum(input_tokens), 0)::text AS input_tokens,
          coalesce(sum(output_tokens), 0)::text AS output_tokens
        FROM ai_runs WHERE org_id = ${actor.orgId} AND created_at > now() - interval '30 days'
        GROUP BY feature ORDER BY feature
      `);
      return {
        usage: rows.map((u) => ({
          feature: u.feature,
          calls: u.calls,
          failed: u.failed,
          inputTokens: Number(u.input_tokens),
          outputTokens: Number(u.output_tokens),
        })),
      };
    },
  );

  // An identity document arrives as the photo itself, not as JSON.
  await app.register(async (upload) => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      upload.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) =>
        done(null, body),
      );
    }
    upload.post(
      '/reservations/:id/id-capture',
      {
        config: perUser(20),
        bodyLimit: 9 * 1024 * 1024,
        schema: {
          tags: ['assistant'],
          summary:
            'Read the details off a photo of an identity document (the request body is the photo). Nothing is saved.',
        },
      },
      async (req: FastifyRequest) => {
        const params = idParams.safeParse(req.params);
        if (!params.success) throw notFound('Reservation');
        // Reading a guest's identity document takes the permission for identity data.
        const { actor, propertyId } = await authorizeReservation(
          app.db,
          req,
          params.data.id,
          'guests.pii',
        );
        authorize(req, 'ai.use', propertyId);
        if (!Buffer.isBuffer(req.body)) throw validationError('Send the photo as the request body');
        return captureIdDocument(app.db, app.ai, app.env, actor, {
          data: req.body,
          propertyId,
          reservationId: params.data.id,
        });
      },
    );
  });
}
