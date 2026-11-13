import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  CHANNEL_ADAPTERS,
  REVISION_STATUSES,
  bookingRevisions,
  channelConnections,
  type Database,
} from '@pms/db';
import {
  CHANNEL_JOBS,
  channexChannelScreenUrl,
  channexConfig,
  channexStatus,
  channexStructure,
  connectionLog,
  createConnection,
  ensureChannexWebhook,
  getConnectionSummary,
  getMappings,
  handleChannexWebhook,
  listChannexProperties,
  listConnections,
  listRevisions,
  provisionChannex,
  reprocessRevision,
  requestFullSync,
  saveMappings,
  updateConnection,
  verifyChannexWebhook,
  workerStatus,
  type ChannexWebhookBody,
} from '@pms/channels';
import {
  DomainError,
  enqueueJob,
  forbidden,
  notFound,
  validationError,
  type Actor,
  type Permission,
} from '@pms/domain';
import { idParams, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty, scopedProperties } from '../lib/scope';
import { authorize } from '../plugins/auth';

/** Authorises an action on a connection by the property it belongs to. */
async function authorizeConnection(
  db: Database,
  req: FastifyRequest,
  connectionId: string,
  permission: Permission,
): Promise<Actor> {
  const session = authorize(req);
  const [row] = await db
    .select({ propertyId: channelConnections.propertyId })
    .from(channelConnections)
    .where(
      and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, session.orgId)),
    );
  if (!row) throw notFound('Connection', connectionId);
  return authorize(req, permission, row.propertyId);
}

const connectionConfig = z
  .object({
    externalPropertyId: z.string().trim().min(1).max(100).optional(),
    baseUrl: z.url().max(300).optional(),
  })
  .strict();

const connectionSecrets = z
  .object({ apiKey: z.string().trim().min(8).max(400).optional() })
  .strict();

const mappingBody = z.object({
  roomTypes: z
    .array(
      z.object({
        roomTypeId: uuid,
        externalId: z.string().trim().min(1).max(100),
        externalName: z.string().max(200).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
  ratePlans: z
    .array(
      z.object({
        ratePlanId: uuid,
        externalId: z.string().trim().min(1).max(100),
        externalName: z.string().max(200).nullable().optional(),
      }),
    )
    .max(2000)
    .optional(),
});

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Pointing a connection at another server, or giving it its own key, decides
   * where guest data and availability are sent: organisation admins only.
   */
  function guardEndpointChange(
    actor: Actor,
    input: { config?: { baseUrl?: string }; secrets?: object },
  ): void {
    const touchesEndpoint = input.config?.baseUrl !== undefined || input.secrets !== undefined;
    if (touchesEndpoint && !authorizeOrg(actor)) {
      throw forbidden('Only an organisation admin can change where a connection sends its data');
    }
  }
  const authorizeOrg = (actor: Actor): boolean =>
    actor.grants.some((g) => g.propertyId === null && g.role === 'org_admin');

  r.get(
    '/channels/status',
    {
      schema: {
        tags: ['channels'],
        summary: 'Whether the channel manager is set up and the sync worker is running',
      },
    },
    async (req) => {
      authorize(req, 'channels.read');
      return { channex: channexConfig(app.env), worker: await workerStatus(app.db) };
    },
  );

  r.get(
    '/channels/connections',
    { schema: { tags: ['channels'], querystring: z.object({ propertyIds: uuidList }) } },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(req, 'channels.read', req.query.propertyIds);
      return { connections: await listConnections(app.db, actor.orgId, propertyIds) };
    },
  );

  r.post(
    '/channels/connections',
    {
      schema: {
        tags: ['channels'],
        summary: 'Add a route from a property to the booking channels',
        body: z.object({
          propertyId: uuid,
          adapter: z.enum(CHANNEL_ADAPTERS),
          name: z.string().trim().min(1).max(120).optional(),
          config: connectionConfig.optional(),
          secrets: connectionSecrets.optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.body.propertyId, 'channels.manage');
      guardEndpointChange(actor, req.body);
      const created = await createConnection(app.db, actor, req.body);
      return reply.status(201).send(await getConnectionSummary(app.db, actor.orgId, created.id));
    },
  );

  r.get(
    '/channels/connections/:id',
    { schema: { tags: ['channels'], params: idParams } },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.read');
      const [connection, mappings, log] = await Promise.all([
        getConnectionSummary(app.db, actor.orgId, req.params.id),
        getMappings(app.db, req.params.id),
        connectionLog(app.db, req.params.id, 50),
      ]);
      return { connection, mappings, log };
    },
  );

  r.patch(
    '/channels/connections/:id',
    {
      schema: {
        tags: ['channels'],
        summary: 'Rename, reconfigure, switch on or pause a connection',
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          status: z.enum(['active', 'paused', 'disabled']).optional(),
          config: connectionConfig.optional(),
          secrets: connectionSecrets.optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      guardEndpointChange(actor, req.body);
      await updateConnection(app.db, actor, req.params.id, req.body);
      return getConnectionSummary(app.db, actor.orgId, req.params.id);
    },
  );

  r.get(
    '/channels/connections/:id/mappings',
    { schema: { tags: ['channels'], params: idParams } },
    async (req) => {
      await authorizeConnection(app.db, req, req.params.id, 'channels.read');
      return getMappings(app.db, req.params.id);
    },
  );

  r.put(
    '/channels/connections/:id/mappings',
    {
      schema: {
        tags: ['channels'],
        summary:
          'Replace which channel rooms and rates the PMS room types and rate plans correspond to',
        params: idParams,
        body: mappingBody,
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      await saveMappings(app.db, actor, req.params.id, req.body);
      return getMappings(app.db, req.params.id);
    },
  );

  r.post(
    '/channels/connections/:id/full-sync',
    {
      schema: {
        tags: ['channels'],
        summary: 'Send the whole horizon to the channel again',
        params: idParams,
      },
    },
    async (req, reply) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      await requestFullSync(app.db, actor, req.params.id);
      return reply.status(202).send({ queued: true });
    },
  );

  for (const [path, kind, summary] of [
    ['pull', CHANNEL_JOBS.pull, 'Fetch waiting bookings now'],
    ['drift-check', CHANNEL_JOBS.driftCheck, 'Compare what the channel holds with the PMS now'],
    [
      'import-bookings',
      CHANNEL_JOBS.importBookings,
      'Bring in bookings made before the connection existed',
    ],
  ] as const) {
    r.post(
      `/channels/connections/:id/${path}`,
      { schema: { tags: ['channels'], summary, params: idParams } },
      async (req, reply) => {
        await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
        const queued = await enqueueJob(
          app.db,
          kind,
          { connectionId: req.params.id, via: 'poll' },
          { uniqueKey: `${kind}:manual:${req.params.id}`, maxAttempts: 2 },
        );
        return reply.status(202).send({ queued });
      },
    );
  }

  r.get(
    '/channels/connections/:id/log',
    {
      schema: {
        tags: ['channels'],
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
      },
    },
    async (req) => {
      await authorizeConnection(app.db, req, req.params.id, 'channels.read');
      return { log: await connectionLog(app.db, req.params.id, req.query.limit ?? 100) };
    },
  );

  r.get(
    '/channels/revisions',
    {
      schema: {
        tags: ['channels'],
        summary: 'Booking messages received from the channels, newest first',
        querystring: z.object({
          propertyIds: uuidList,
          connectionId: uuid.optional(),
          status: z.enum(REVISION_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(req, 'channels.read', req.query.propertyIds);
      return {
        revisions: await listRevisions(app.db, actor.orgId, {
          propertyIds,
          connectionId: req.query.connectionId,
          status: req.query.status,
          limit: req.query.limit,
        }),
      };
    },
  );

  r.post(
    '/channels/revisions/:id/reprocess',
    {
      schema: {
        tags: ['channels'],
        summary: 'Apply a booking message again, after fixing what stopped it',
        params: idParams,
      },
    },
    async (req) => {
      const session = authorize(req);
      const [row] = await app.db
        .select({ connectionId: bookingRevisions.connectionId })
        .from(bookingRevisions)
        .innerJoin(channelConnections, eq(channelConnections.id, bookingRevisions.connectionId))
        .where(
          and(eq(bookingRevisions.id, req.params.id), eq(channelConnections.orgId, session.orgId)),
        );
      if (!row) throw notFound('Booking message', req.params.id);
      const actor = await authorizeConnection(app.db, req, row.connectionId, 'channels.manage');
      return reprocessRevision(app.db, actor, req.params.id);
    },
  );

  // ---------------------------------------------------------------------------
  // Channel manager (Channex) set-up

  r.get(
    '/channels/channex',
    {
      schema: {
        tags: ['channels'],
        summary: 'Channel manager account status, for the people who manage it',
      },
    },
    async (req) => {
      authorize(req, 'channels.manage');
      return channexStatus(app.env);
    },
  );

  r.get(
    '/channels/channex/properties',
    { schema: { tags: ['channels'], summary: 'Properties in the channel manager account' } },
    async (req) => {
      authorize(req, 'channels.manage');
      return { properties: await listChannexProperties(app.env) };
    },
  );

  r.post(
    '/channels/channex/webhook',
    {
      schema: {
        tags: ['channels'],
        summary: 'Register this PMS as the channel manager’s webhook target',
      },
    },
    async (req) => {
      authorize(req, 'org.manage');
      return ensureChannexWebhook(app.env);
    },
  );

  r.get(
    '/channels/connections/:id/channex/structure',
    {
      schema: {
        tags: ['channels'],
        summary: 'Room types and rate plans that exist in the channel manager, to map against',
        params: idParams,
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      return channexStructure(app.db, actor.orgId, req.params.id);
    },
  );

  r.post(
    '/channels/connections/:id/channex/provision',
    {
      schema: {
        tags: ['channels'],
        summary:
          'Create this property, its room types and rate plans in the channel manager, and map them',
        params: idParams,
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      return provisionChannex(app.db, actor, req.params.id);
    },
  );

  r.post(
    '/channels/connections/:id/channex/channel-screen',
    {
      schema: {
        tags: ['channels'],
        summary: 'A one-time link to the channel manager’s screen for connecting and mapping OTAs',
        params: idParams,
        body: z
          .object({
            channels: z
              .array(z.string().regex(/^[A-Z0-9]{2,4}$/))
              .max(40)
              .optional(),
          })
          .optional(),
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      return { url: await channexChannelScreenUrl(app.db, actor, req.params.id, req.body ?? {}) };
    },
  );
}

/**
 * Endpoints the channels call. They are authenticated by the caller's
 * signature or shared secret, not by a session, and need the request body
 * exactly as sent, so they live in their own scope with their own parser.
 */
export async function channelWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );

  app.post(
    '/webhooks/channex',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: { tags: ['webhooks'], summary: 'Channel manager notifications' },
    },
    async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const verdict = verifyChannexWebhook(app.env, { headers: req.headers, rawBody });
      if (!verdict.ok) {
        req.log.warn({ reason: verdict.reason }, 'refused a channel manager webhook call');
        throw new DomainError('unauthenticated', 'Webhook verification failed');
      }
      let body: ChannexWebhookBody;
      try {
        body = JSON.parse(rawBody.toString('utf8')) as ChannexWebhookBody;
      } catch {
        throw validationError('The webhook body is not valid JSON');
      }
      if (!body || typeof body !== 'object')
        throw validationError('The webhook body is not an object');
      // If this throws (the database is down), the 5xx makes the channel manager deliver again later.
      const outcome = await handleChannexWebhook(app.db, body);
      return reply.status(200).send({ received: true, action: outcome.action });
    },
  );
}
