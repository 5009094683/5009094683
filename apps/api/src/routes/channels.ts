import { timingSafeEqual } from 'node:crypto';
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
  channexWebhookState,
  connectionLog,
  createConnection,
  ensureChannexWebhook,
  exportCalendar,
  getConnectionSummary,
  getMappings,
  handleChannexWebhook,
  ingestInboundEmail,
  listChannexProperties,
  listConnections,
  listIcalFeeds,
  listRevisions,
  provisionChannex,
  reprocessRevision,
  setAsideRevision,
  requestFullSync,
  saveIcalFeeds,
  saveMailbox,
  saveMappings,
  updateConnection,
  verifyChannexWebhook,
  workerStatus,
  type ChannexWebhookBody,
  type EmailConnectionConfig,
} from '@pms/channels';
import {
  DomainError,
  can,
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
      return {
        channex: channexConfig(app.env),
        worker: await workerStatus(app.db),
        // Where the stand-in for the booking sites can be opened, when it is in use.
        simulatorUrl: app.env.usingChannelSimulator ? app.env.OTA_SIM_URL : null,
      };
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

  r.post(
    '/channels/revisions/:id/set-aside',
    {
      schema: {
        tags: ['channels'],
        summary:
          'Mark a booking message that could not be recorded as dealt with by hand; applying it again reopens it',
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
      return setAsideRevision(app.db, actor, req.params.id);
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

  r.get(
    '/channels/channex/webhook',
    {
      schema: {
        tags: ['channels'],
        summary: 'Whether the channel manager is set to announce bookings to this PMS',
      },
    },
    async (req) => {
      authorize(req, 'channels.read');
      return channexWebhookState(app.env);
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

const icalFeedInput = z.object({
  id: uuid.optional(),
  unitId: uuid,
  importUrl: z.string().trim().max(1000).nullable().optional(),
  label: z.string().trim().min(1).max(60),
  channelCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,6}$/)
    .nullable()
    .optional(),
  treatAs: z.enum(['auto', 'reservations', 'blocks']).optional(),
});

/** Calendar feeds: reading a channel's calendar for a unit, and offering ours to it. */
export async function icalRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/channels/connections/:id/ical/feeds',
    {
      schema: {
        tags: ['channels'],
        summary: 'Calendars read for and offered to channels, per unit',
        params: idParams,
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.read');
      const connection = await getConnectionSummary(app.db, actor.orgId, req.params.id);
      const feeds = await listIcalFeeds(app.db, actor.orgId, req.params.id, app.env);
      // The addresses are capabilities: only people who manage this property's channels see them.
      if (can(actor.grants, 'channels.manage', connection.propertyId)) return { feeds };
      return { feeds: feeds.map((f) => ({ ...f, exportUrl: null, importUrl: null })) };
    },
  );

  r.put(
    '/channels/connections/:id/ical/feeds',
    {
      schema: {
        tags: ['channels'],
        summary: 'Replace the calendars of a connection',
        params: idParams,
        body: z.object({ feeds: z.array(icalFeedInput).max(200) }),
      },
    },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      return { feeds: await saveIcalFeeds(app.db, actor, req.params.id, req.body.feeds, app.env) };
    },
  );

  // The address given to a channel. Whoever holds it can read which nights are taken, nothing else.
  app.get(
    '/ical/:feedId/:file',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { tags: ['ical'], summary: 'Availability calendar for one listing (iCalendar)' },
    },
    async (req, reply) => {
      const { feedId, file } = req.params as { feedId: string; file: string };
      const calendar = await exportCalendar(app.db, feedId, file.replace(/\.ics$/i, ''));
      if (!calendar) return reply.status(404).type('text/plain').send('Not found');
      void reply.header('etag', calendar.etag).header('cache-control', 'private, max-age=60');
      if (req.headers['if-none-match'] === calendar.etag) return reply.status(304).send();
      return reply.type('text/calendar; charset=utf-8').send(calendar.body);
    },
  );
}

/** The reservations mailbox: where a property's booking emails are read from. */
export async function mailboxRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/channels/connections/:id/email/mailbox',
    { schema: { tags: ['channels'], summary: 'Reservations mailbox settings', params: idParams } },
    async (req) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      const [row] = await app.db
        .select()
        .from(channelConnections)
        .where(
          and(eq(channelConnections.id, req.params.id), eq(channelConnections.orgId, actor.orgId)),
        );
      if (!row || row.adapter !== 'email') throw notFound('Mailbox connection', req.params.id);
      const config = row.config as EmailConnectionConfig;
      return {
        host: config.mailbox?.host ?? null,
        port: config.mailbox?.port ?? null,
        user: config.mailbox?.user ?? null,
        folder: config.mailbox?.folder ?? null,
        recipient: config.recipient ?? null,
        trustUnverifiedSenders: config.trustUnverifiedSenders ?? false,
        // Whether a password is stored; the password itself is never sent back.
        hasPassword: row.secretsEnc !== null,
        // Mail services that hand over email by HTTP post it here, with the shared secret.
        forwardingUrl: app.env.INBOUND_EMAIL_SECRET
          ? `${app.env.API_PUBLIC_URL.replace(/\/+$/, '')}/webhooks/inbound-email/${row.id}`
          : null,
      };
    },
  );

  r.put(
    '/channels/connections/:id/email/mailbox',
    {
      schema: {
        tags: ['channels'],
        summary: 'Set how the reservations mailbox is read',
        params: idParams,
        body: z.object({
          host: z.string().trim().max(200).nullable().optional(),
          port: z.number().int().min(1).max(65535).nullable().optional(),
          user: z.string().trim().max(200).nullable().optional(),
          password: z.string().min(1).max(500).nullable().optional(),
          folder: z.string().trim().max(200).nullable().optional(),
          recipient: z.email().nullable().optional(),
          trustUnverifiedSenders: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeConnection(app.db, req, req.params.id, 'channels.manage');
      await saveMailbox(app.db, actor, req.params.id, req.body);
      return reply.status(204).send();
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
  for (const type of ['application/json', 'message/rfc822', 'text/plain']) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

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

  // A mail service hands over one email: forwarded reservations mail, without a mailbox to read.
  app.post(
    '/webhooks/inbound-email/:connectionId',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: {
        tags: ['webhooks'],
        summary: 'One reservation email, handed over by a mail service',
      },
    },
    async (req, reply) => {
      const secret = app.env.INBOUND_EMAIL_SECRET;
      const { connectionId } = req.params as { connectionId: string };
      const given =
        (req.headers['x-inbound-email-secret'] as string | undefined) ??
        (req.query as { secret?: string }).secret ??
        '';
      const expected = Buffer.from(secret ?? '');
      const supplied = Buffer.from(given);
      if (!secret || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        throw new DomainError(
          'unauthenticated',
          'Inbound email is not set up, or the secret is wrong',
        );
      }
      if (!/^[0-9a-f-]{36}$/i.test(connectionId))
        throw notFound('Mailbox connection', connectionId);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      let source: Buffer | string = body;
      if ((req.headers['content-type'] ?? '').includes('application/json')) {
        // Services differ in what they call the raw message.
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw validationError('The body is not valid JSON');
        }
        const raw = json.raw ?? json.RawEmail ?? json.email ?? json.mime ?? json['body-mime'];
        if (typeof raw !== 'string' || !raw.trim()) {
          throw validationError('The raw message is missing: send it as "raw"');
        }
        source = raw;
      }
      if (source.length === 0) throw validationError('The message is empty');
      const outcome = await ingestInboundEmail(app.db, connectionId, source);
      return reply
        .status(200)
        .send(
          outcome.handled
            ? { received: true, status: outcome.result.status, duplicate: outcome.result.duplicate }
            : { received: true, ignored: outcome.reason },
        );
    },
  );
}
