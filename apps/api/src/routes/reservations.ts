import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PAYMENT_COLLECT, RESERVATION_SOURCES, RESERVATION_STATUSES } from '@pms/db';
import {
  addReservationRoom,
  can,
  cancelReservation,
  confirmReservation,
  createReservation,
  forbidden,
  listReservations,
  loadReservation,
  markNoShow,
  reinstateReservation,
  updateReservation,
  updateReservationRoom,
  type Actor,
} from '@pms/domain';
import { dateString, guestInput, idParams, money, roomInput, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty, authorizeReservation, scopedProperties } from '../lib/scope';

/**
 * `force` books past capacity. It needs the override permission: without the
 * check, anyone who can create a reservation could overbook a property.
 */
function overrideOption(
  actor: Actor,
  propertyId: string,
  force: boolean | undefined,
): { allowOverbooking: boolean } {
  if (force && !can(actor.grants, 'reservations.override', propertyId)) {
    throw forbidden('You do not have permission to book past capacity');
  }
  return { allowOverbooking: Boolean(force) };
}

const statusList = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
  .pipe(z.array(z.enum(RESERVATION_STATUSES)).optional());

export async function reservationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/reservations',
    {
      schema: {
        tags: ['reservations'],
        summary: 'Search reservations',
        querystring: z.object({
          propertyIds: uuidList,
          statuses: statusList,
          from: dateString.optional(),
          to: dateString.optional(),
          arrivingOn: dateString.optional(),
          departingOn: dateString.optional(),
          channelCode: z.string().max(20).optional(),
          needsReview: z.enum(['true', 'false']).optional(),
          overbooked: z.enum(['true', 'false']).optional(),
          needsAttention: z.enum(['true']).optional(),
          search: z.string().max(120).optional(),
          sort: z.enum(['arrival', 'created']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const { actor, propertyIds } = scopedProperties(req, 'reservations.read', q.propertyIds);
      return listReservations(app.db, actor.orgId, {
        propertyIds,
        statuses: q.statuses,
        staying: q.from && q.to ? { from: q.from, to: q.to } : undefined,
        arrivingOn: q.arrivingOn,
        departingOn: q.departingOn,
        channelCode: q.channelCode,
        needsReview: q.needsReview === undefined ? undefined : q.needsReview === 'true',
        overbooked: q.overbooked === undefined ? undefined : q.overbooked === 'true',
        needsAttention: q.needsAttention === 'true',
        search: q.search,
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
      });
    },
  );

  r.post(
    '/reservations',
    {
      schema: {
        tags: ['reservations'],
        summary: 'Create a reservation of one or more rooms',
        body: z.object({
          propertyId: uuid,
          status: z
            .enum(['tentative', 'confirmed'])
            .optional()
            .describe(
              'tentative holds the rooms without confirming: the reservation is cancelled when the hold ends',
            ),
          holdUntil: z.iso
            .datetime({ offset: true })
            .optional()
            .describe(
              'With status tentative: when the hold ends, on the day of arrival at the latest. Left out, it ends after the hold time of the booking website.',
            ),
          source: z.enum(RESERVATION_SOURCES).default('direct'),
          guest: guestInput,
          rooms: z.array(roomInput).min(1).max(60),
          paymentCollect: z.enum(PAYMENT_COLLECT).optional(),
          arrivalTime: z.string().max(20).nullable().optional(),
          specialRequests: z.string().max(4000).nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
          groupId: uuid.nullable().optional(),
          companyId: uuid.nullable().optional(),
          force: z
            .boolean()
            .optional()
            .describe('Book past capacity. Needs the override permission.'),
        }),
      },
    },
    async (req, reply) => {
      const { force, holdUntil, ...input } = req.body;
      const actor = await authorizeProperty(app.db, req, input.propertyId, 'reservations.write');
      const options = overrideOption(actor, input.propertyId, force);
      const created = await createReservation(
        app.db,
        actor,
        { ...input, holdUntil: holdUntil ? new Date(holdUntil) : null },
        options,
      );
      return reply.status(201).send(created);
    },
  );

  r.get(
    '/reservations/:id',
    { schema: { tags: ['reservations'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'reservations.read');
      return loadReservation(app.db, actor.orgId, req.params.id);
    },
  );

  r.patch(
    '/reservations/:id',
    {
      schema: {
        tags: ['reservations'],
        summary: 'Change guest details, notes and other fields that do not affect inventory',
        params: idParams,
        body: z.object({
          guest: guestInput.optional(),
          arrivalTime: z.string().max(20).nullable().optional(),
          specialRequests: z.string().max(4000).nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
          commissionAmount: money.optional(),
          paymentCollect: z.enum(PAYMENT_COLLECT).optional(),
          needsReview: z.boolean().optional(),
          companyId: uuid.nullable().optional(),
          holdUntil: z.iso
            .datetime({ offset: true })
            .optional()
            .describe('Moves the end of the hold of a reservation that is still tentative'),
          expectedVersion: z.number().int().optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      const { expectedVersion, holdUntil, ...patch } = req.body;
      return updateReservation(
        app.db,
        actor,
        req.params.id,
        { ...patch, ...(holdUntil ? { holdUntil: new Date(holdUntil) } : {}) },
        { expectedVersion },
      );
    },
  );

  r.post(
    '/reservations/:id/rooms',
    {
      schema: {
        tags: ['reservations'],
        params: idParams,
        body: roomInput.extend({
          force: z.boolean().optional(),
          expectedVersion: z.number().int().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { actor, propertyId } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      const { force, expectedVersion, ...room } = req.body;
      const reservation = await addReservationRoom(app.db, actor, req.params.id, room, {
        ...overrideOption(actor, propertyId, force),
        expectedVersion,
      });
      return reply.status(201).send(reservation);
    },
  );

  r.patch(
    '/reservations/:id/rooms/:roomId',
    {
      schema: {
        tags: ['reservations'],
        summary: 'Move, extend, shorten, re-type or re-price one room',
        params: idParams.extend({ roomId: uuid }),
        body: z.object({
          roomTypeId: uuid.optional(),
          ratePlanId: uuid.nullable().optional(),
          unitId: uuid.nullable().optional(),
          checkIn: dateString.optional(),
          checkOut: dateString.optional(),
          adults: z.number().int().min(1).max(30).optional(),
          children: z.number().int().min(0).max(30).optional(),
          guestName: z.string().max(160).nullable().optional(),
          nightlyRates: z.array(money).max(400).optional(),
          force: z.boolean().optional(),
          expectedVersion: z.number().int().optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      const { force, expectedVersion, ...patch } = req.body;
      return updateReservationRoom(app.db, actor, req.params.id, req.params.roomId, patch, {
        ...overrideOption(actor, propertyId, force),
        expectedVersion,
      });
    },
  );

  r.post(
    '/reservations/:id/cancel',
    {
      schema: {
        tags: ['reservations'],
        params: idParams,
        body: z.object({
          reason: z.string().max(500).nullable().optional(),
          roomIds: z.array(uuid).max(60).optional(),
          expectedVersion: z.number().int().optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      return cancelReservation(app.db, actor, req.params.id, req.body);
    },
  );

  r.post(
    '/reservations/:id/no-show',
    { schema: { tags: ['reservations'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      return markNoShow(app.db, actor, req.params.id);
    },
  );

  r.post(
    '/reservations/:id/reinstate',
    {
      schema: {
        tags: ['reservations'],
        params: idParams,
        body: z.object({ force: z.boolean().optional() }),
      },
    },
    async (req) => {
      const { actor, propertyId } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      return reinstateReservation(
        app.db,
        actor,
        req.params.id,
        overrideOption(actor, propertyId, req.body.force),
      );
    },
  );

  r.post(
    '/reservations/:id/confirm',
    { schema: { tags: ['reservations'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(
        app.db,
        req,
        req.params.id,
        'reservations.write',
      );
      return confirmReservation(app.db, actor, req.params.id);
    },
  );
}
