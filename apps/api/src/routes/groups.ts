import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GROUP_STATUSES, RESERVATION_SOURCES } from '@pms/db';
import {
  addGroupHold,
  addRoomingList,
  can,
  cancelGroup,
  changeGroupHold,
  createGroup,
  forbidden,
  getGroup,
  groupPropertyId,
  listGroups,
  releaseGroupRooms,
  removeGroupHold,
  setReservationGroup,
  updateGroup,
  type Actor,
  type Permission,
} from '@pms/domain';
import { dateString, idParams, money, propertyParams, uuid } from '../lib/schemas';
import { authorize } from '../plugins/auth';
import { authorizeProperty, authorizeReservation } from '../lib/scope';

const hold = z.object({
  roomTypeId: uuid,
  from: dateString.describe('First night held'),
  to: dateString.describe('The morning the rooms are given up'),
  quantity: z.number().int().min(1).max(500),
});

const details = {
  name: z.string().trim().min(1).max(120),
  contactName: z.string().max(120).nullable().optional(),
  contactEmail: z.email().nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  cutoffDate: dateString
    .nullable()
    .optional()
    .describe('Rooms the group has not booked by the end of this day go back on sale'),
  companyId: uuid.nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
};

const force = z
  .boolean()
  .optional()
  .describe('Hold or book past capacity. Needs the override permission.');

const holdParams = z.object({ id: uuid, holdId: uuid });

function overrideOption(
  actor: Actor,
  propertyId: string,
  forced: boolean | undefined,
): { allowOverbooking: boolean } {
  if (forced && !can(actor.grants, 'reservations.override', propertyId)) {
    throw forbidden('You do not have permission to go past capacity');
  }
  return { allowOverbooking: Boolean(forced) };
}

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Authorises an action on a group by the property it belongs to. */
  async function authorizeGroup(
    req: FastifyRequest,
    groupId: string,
    ...permissions: Permission[]
  ): Promise<{ actor: Actor; propertyId: string }> {
    const session = authorize(req);
    const propertyId = await groupPropertyId(app.db, session.orgId, groupId);
    let actor = session;
    for (const permission of permissions) actor = authorize(req, permission, propertyId);
    return { actor, propertyId };
  }

  r.get(
    '/properties/:propertyId/groups',
    {
      schema: {
        tags: ['groups'],
        summary: 'Group bookings of a property, soonest first',
        params: propertyParams,
        querystring: z.object({
          status: z.enum([...GROUP_STATUSES, 'all']).optional(),
          search: z.string().max(120).optional(),
        }),
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
        groups: await listGroups(app.db, actor.orgId, {
          propertyId: req.params.propertyId,
          status: req.query.status,
          search: req.query.search,
        }),
      };
    },
  );

  r.post(
    '/properties/:propertyId/groups',
    {
      schema: {
        tags: ['groups'],
        summary: 'Start a group booking and hold its rooms',
        params: propertyParams,
        body: z.object({ ...details, holds: z.array(hold).max(40).default([]), force }),
      },
    },
    async (req, reply) => {
      const { force: forced, ...input } = req.body;
      const propertyId = req.params.propertyId;
      let actor = await authorizeProperty(app.db, req, propertyId, 'reservations.write');
      // Holding rooms takes them off sale, like any other block.
      if (input.holds.length > 0) actor = authorize(req, 'blocks.write', propertyId);
      const group = await createGroup(
        app.db,
        actor,
        { ...input, propertyId },
        overrideOption(actor, propertyId, forced),
      );
      return reply.status(201).send(group);
    },
  );

  r.get(
    '/groups/:id',
    {
      schema: {
        tags: ['groups'],
        summary: 'A group: rooms held, rooms booked night by night, and its bookings',
        params: idParams,
      },
    },
    async (req) => {
      const { actor } = await authorizeGroup(req, req.params.id, 'reservations.read');
      return getGroup(app.db, actor.orgId, req.params.id);
    },
  );

  r.patch(
    '/groups/:id',
    {
      schema: {
        tags: ['groups'],
        params: idParams,
        body: z.object({ ...details, name: details.name.optional() }),
      },
    },
    async (req) => {
      const { actor } = await authorizeGroup(req, req.params.id, 'reservations.write');
      return updateGroup(app.db, actor, req.params.id, req.body);
    },
  );

  r.post(
    '/groups/:id/holds',
    {
      schema: {
        tags: ['groups'],
        summary: 'Hold more rooms for the group',
        params: idParams,
        body: hold.extend({ force }),
      },
    },
    async (req, reply) => {
      const { actor, propertyId } = await authorizeGroup(req, req.params.id, 'blocks.write');
      const { force: forced, ...input } = req.body;
      const group = await addGroupHold(
        app.db,
        actor,
        req.params.id,
        input,
        overrideOption(actor, propertyId, forced),
      );
      return reply.status(201).send(group);
    },
  );

  r.patch(
    '/groups/:id/holds/:holdId',
    {
      schema: {
        tags: ['groups'],
        summary: 'Change how many rooms are held, or for which nights',
        params: holdParams,
        body: z.object({
          from: dateString.optional(),
          to: dateString.optional(),
          quantity: z.number().int().min(1).max(500).optional(),
          force,
        }),
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeGroup(req, req.params.id, 'blocks.write');
      const { force: forced, ...patch } = req.body;
      return changeGroupHold(
        app.db,
        actor,
        req.params.id,
        req.params.holdId,
        patch,
        overrideOption(actor, propertyId, forced),
      );
    },
  );

  r.delete(
    '/groups/:id/holds/:holdId',
    {
      schema: {
        tags: ['groups'],
        summary: 'Give up one set of held rooms',
        params: holdParams,
      },
    },
    async (req) => {
      const { actor } = await authorizeGroup(req, req.params.id, 'blocks.write');
      return removeGroupHold(app.db, actor, req.params.id, req.params.holdId);
    },
  );

  r.post(
    '/groups/:id/release',
    {
      schema: {
        tags: ['groups'],
        summary: 'Put the rooms nobody in the group has booked back on sale',
        params: idParams,
      },
    },
    async (req) => {
      const { actor } = await authorizeGroup(req, req.params.id, 'blocks.write');
      return releaseGroupRooms(app.db, actor, req.params.id);
    },
  );

  r.post(
    '/groups/:id/cancel',
    {
      schema: {
        tags: ['groups'],
        summary: 'Call the group off. Its bookings must be cancelled first.',
        params: idParams,
      },
    },
    async (req) => {
      const { actor } = await authorizeGroup(
        req,
        req.params.id,
        'reservations.write',
        'blocks.write',
      );
      return cancelGroup(app.db, actor, req.params.id);
    },
  );

  r.post(
    '/groups/:id/rooming-list',
    {
      schema: {
        tags: ['groups'],
        summary: 'Book a room for each guest of a list, all or none',
        params: idParams,
        body: z.object({
          roomTypeId: uuid,
          ratePlanId: uuid.nullable().optional(),
          checkIn: dateString,
          checkOut: dateString,
          adults: z.number().int().min(1).max(30).optional(),
          nightlyRate: money
            .optional()
            .describe('Per room per night before tax, in minor units. Omit to use the rate plan.'),
          source: z.enum(RESERVATION_SOURCES).optional(),
          guests: z
            .array(
              z.object({
                firstName: z.string().trim().min(1).max(120),
                lastName: z.string().max(120).optional(),
                email: z.email().nullable().optional(),
                phone: z.string().max(40).nullable().optional(),
              }),
            )
            .min(1)
            .max(100),
          force,
        }),
      },
    },
    async (req, reply) => {
      const { actor, propertyId } = await authorizeGroup(req, req.params.id, 'reservations.write');
      const { force: forced, ...input } = req.body;
      const result = await addRoomingList(
        app.db,
        actor,
        req.params.id,
        input,
        overrideOption(actor, propertyId, forced),
      );
      return reply.status(201).send(result);
    },
  );

  r.put(
    '/reservations/:id/group',
    {
      schema: {
        tags: ['groups'],
        summary: 'Move a reservation into a group, or out of it',
        params: idParams,
        body: z.object({ groupId: uuid.nullable(), force }),
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      return setReservationGroup(
        app.db,
        actor,
        req.params.id,
        req.body.groupId,
        overrideOption(actor, propertyId, req.body.force),
      );
    },
  );
}
