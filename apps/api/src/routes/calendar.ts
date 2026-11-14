import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { BLOCK_KINDS, properties } from '@pms/db';
import {
  can,
  createBlock,
  forbidden,
  getCalendar,
  listAlerts,
  listBlocks,
  propertyScope,
  releaseBlock,
  setAlertStatus,
  updateBlock,
  type Actor,
} from '@pms/domain';
import { dateRangeQuery, dateString, idParams, uuid, uuidList } from '../lib/schemas';
import { authorizeBlock, authorizeProperty, scopedProperties } from '../lib/scope';
import { authorize } from '../plugins/auth';

function blockOptions(
  actor: Actor,
  propertyId: string,
  flags: { force?: boolean; relocate?: boolean },
): { allowOverbooking: boolean; relocateStays: boolean } {
  if (flags.force && !can(actor.grants, 'reservations.override', propertyId)) {
    throw forbidden('You do not have permission to block dates that are already sold');
  }
  // Moving a stay to another room is a reservation change, so it needs that permission too.
  if (flags.relocate && !can(actor.grants, 'reservations.write', propertyId)) {
    throw forbidden('You do not have permission to move reservations');
  }
  return { allowOverbooking: Boolean(flags.force), relocateStays: Boolean(flags.relocate) };
}

export async function calendarRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Resolves 'all' to the organisation's property ids. */
  async function resolveIds(orgId: string, scope: string[] | 'all'): Promise<string[]> {
    if (scope !== 'all') {
      if (scope.length === 0) return [];
      const rows = await app.db
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.orgId, orgId), inArray(properties.id, scope)));
      return rows.map((p) => p.id);
    }
    const rows = await app.db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.orgId, orgId));
    return rows.map((p) => p.id);
  }

  r.get(
    '/calendar',
    {
      schema: {
        tags: ['calendar'],
        summary: 'Units, nightly availability, stays and blocks for the calendar grid',
        querystring: dateRangeQuery.extend({ propertyIds: uuidList }),
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(
        req,
        'reservations.read',
        req.query.propertyIds,
      );
      return getCalendar(app.db, actor.orgId, {
        propertyIds: await resolveIds(actor.orgId, propertyIds),
        range: { from: req.query.from, to: req.query.to },
      });
    },
  );

  r.get(
    '/blocks',
    { schema: { tags: ['blocks'], querystring: dateRangeQuery.extend({ propertyIds: uuidList }) } },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(
        req,
        'reservations.read',
        req.query.propertyIds,
      );
      return {
        blocks: await listBlocks(app.db, {
          propertyIds: await resolveIds(actor.orgId, propertyIds),
          range: { from: req.query.from, to: req.query.to },
        }),
      };
    },
  );

  r.post(
    '/blocks',
    {
      schema: {
        tags: ['blocks'],
        summary: 'Take dates out of sale on a unit, or a number of rooms of a type',
        body: z.object({
          propertyId: uuid,
          unitId: uuid.nullable().optional(),
          roomTypeId: uuid.optional(),
          quantity: z.number().int().min(1).max(500).optional(),
          kind: z.enum(BLOCK_KINDS),
          startDate: dateString,
          endDate: dateString,
          reason: z.string().max(200).nullable().optional(),
          notes: z.string().max(2000).nullable().optional(),
          force: z.boolean().optional(),
          relocate: z
            .boolean()
            .optional()
            .describe('Move upcoming stays on the unit to another free room instead of refusing.'),
        }),
      },
    },
    async (req, reply) => {
      const { force, relocate, ...input } = req.body;
      const permission = input.kind === 'maintenance' ? 'maintenance.write' : 'blocks.write';
      const actor = await authorizeProperty(app.db, req, input.propertyId, permission);
      const block = await createBlock(
        app.db,
        actor,
        input,
        blockOptions(actor, input.propertyId, { force, relocate }),
      );
      return reply.status(201).send(block);
    },
  );

  r.patch(
    '/blocks/:id',
    {
      schema: {
        tags: ['blocks'],
        params: idParams,
        body: z.object({
          startDate: dateString.optional(),
          endDate: dateString.optional(),
          kind: z.enum(BLOCK_KINDS).optional(),
          reason: z.string().max(200).nullable().optional(),
          notes: z.string().max(2000).nullable().optional(),
          quantity: z.number().int().min(1).max(500).optional(),
          force: z.boolean().optional(),
          relocate: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeBlock(
        app.db,
        req,
        req.params.id,
        'blocks.write',
      );
      const { force, relocate, ...patch } = req.body;
      return updateBlock(
        app.db,
        actor,
        req.params.id,
        patch,
        blockOptions(actor, propertyId, { force, relocate }),
      );
    },
  );

  r.post('/blocks/:id/release', { schema: { tags: ['blocks'], params: idParams } }, async (req) => {
    const { actor } = await authorizeBlock(app.db, req, req.params.id, 'blocks.write');
    return releaseBlock(app.db, actor, req.params.id);
  });

  r.get(
    '/alerts',
    {
      schema: {
        tags: ['alerts'],
        querystring: z.object({
          status: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'property.read');
      const status = req.query.status ?? 'active';
      return {
        alerts: await listAlerts(app.db, actor.orgId, {
          status: status === 'active' ? ['open', 'acknowledged'] : [status],
          propertyIds: propertyScope(actor.grants, 'property.read'),
          limit: req.query.limit,
        }),
      };
    },
  );

  r.post(
    '/alerts/:id/:action',
    {
      schema: {
        tags: ['alerts'],
        params: idParams.extend({ action: z.enum(['acknowledge', 'resolve']) }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'property.read');
      const visible = await listAlerts(app.db, actor.orgId, {
        propertyIds: propertyScope(actor.grants, 'property.read'),
        limit: 500,
      });
      if (!visible.some((a) => a.id === req.params.id)) throw forbidden();
      return setAlertStatus(
        app.db,
        actor,
        req.params.id,
        req.params.action === 'acknowledge' ? 'acknowledged' : 'resolved',
      );
    },
  );
}
