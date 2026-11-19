import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_KEY_ROLES, WEBHOOK_DELIVERY_STATUSES } from '@pms/db';
import {
  ROLE_LABELS,
  WEBHOOK_EVENTS,
  createApiKey,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listApiKeys,
  listWebhookDeliveries,
  listWebhookEndpoints,
  queueWebhookTest,
  retryWebhookDelivery,
  revokeApiKey,
  rotateWebhookSecret,
  updateWebhookEndpoint,
} from '@pms/domain';
import { idParams, uuid } from '../lib/schemas';
import { authorize } from '../plugins/auth';

/**
 * Connections to other systems: keys that let them call this API, and
 * webhooks that tell them when something changes. Both are for those who
 * manage the organisation, and neither can be managed with an API key.
 */
export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const urls = { allowPrivate: app.env.WEBHOOKS_ALLOW_PRIVATE_HOSTS };

  r.get('/api-keys', { schema: { tags: ['integrations'] } }, async (req) => {
    const actor = authorize(req, 'org.manage');
    return {
      keys: await listApiKeys(app.db, actor.orgId),
      roles: API_KEY_ROLES.map((role) => ({ role, label: ROLE_LABELS[role] })),
    };
  });

  r.post(
    '/api-keys',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Create an API key. The key itself is in the answer, and only there.',
        body: z.object({
          name: z.string().trim().min(1).max(120),
          grants: z
            .array(z.object({ role: z.enum(API_KEY_ROLES), propertyId: uuid.nullable() }))
            .min(1)
            .max(50),
          expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'org.manage');
      const created = await createApiKey(app.db, actor, {
        name: req.body.name,
        grants: req.body.grants,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
      });
      return reply.status(201).send(created);
    },
  );

  r.delete(
    '/api-keys/:id',
    {
      schema: { tags: ['integrations'], summary: 'Revoke a key at once', params: idParams },
    },
    async (req) => revokeApiKey(app.db, authorize(req, 'org.manage'), req.params.id),
  );

  // ---------------------------------------------------------------------------
  // Outbound webhooks

  const endpointBody = z.object({
    url: z.string().trim().min(1).max(2000),
    description: z.string().max(200).nullable().optional(),
    events: z.array(z.string().max(60)).min(1).max(30),
    propertyIds: z.array(uuid).max(200).nullable().optional(),
    active: z.boolean().optional(),
  });

  r.get('/outbound-webhooks', { schema: { tags: ['integrations'] } }, async (req) => {
    const actor = authorize(req, 'org.manage');
    return {
      endpoints: await listWebhookEndpoints(app.db, actor.orgId),
      events: WEBHOOK_EVENTS,
    };
  });

  r.post(
    '/outbound-webhooks',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Add a webhook. Its signing secret is in the answer, and only there.',
        body: endpointBody,
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'org.manage');
      return reply.status(201).send(await createWebhookEndpoint(app.db, actor, req.body, urls));
    },
  );

  r.patch(
    '/outbound-webhooks/:id',
    { schema: { tags: ['integrations'], params: idParams, body: endpointBody.partial() } },
    async (req) =>
      updateWebhookEndpoint(app.db, authorize(req, 'org.manage'), req.params.id, req.body, urls),
  );

  r.delete(
    '/outbound-webhooks/:id',
    { schema: { tags: ['integrations'], params: idParams } },
    async (req, reply) => {
      await deleteWebhookEndpoint(app.db, authorize(req, 'org.manage'), req.params.id);
      return reply.status(204).send();
    },
  );

  r.post(
    '/outbound-webhooks/:id/rotate-secret',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Replace the signing secret. The old one stops working at once.',
        params: idParams,
      },
    },
    async (req) => rotateWebhookSecret(app.db, authorize(req, 'org.manage'), req.params.id),
  );

  r.post(
    '/outbound-webhooks/:id/test',
    {
      schema: { tags: ['integrations'], summary: 'Send a ping to try it out', params: idParams },
    },
    async (req, reply) =>
      reply
        .status(202)
        .send(await queueWebhookTest(app.db, authorize(req, 'org.manage'), req.params.id)),
  );

  r.get(
    '/outbound-webhooks/:id/deliveries',
    {
      schema: {
        tags: ['integrations'],
        summary: 'What was sent to an endpoint lately, and how it went',
        params: idParams,
        querystring: z.object({
          status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      return {
        deliveries: await listWebhookDeliveries(app.db, actor.orgId, req.params.id, req.query),
      };
    },
  );

  r.post(
    '/outbound-webhooks/deliveries/:id/retry',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Send a delivery that was given up once more',
        params: z.object({ id: z.coerce.number().int().positive() }),
      },
    },
    async (req, reply) => {
      await retryWebhookDelivery(app.db, authorize(req, 'org.manage'), req.params.id);
      return reply.status(202).send({ status: 'queued' });
    },
  );
}
