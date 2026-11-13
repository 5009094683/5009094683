import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEAL_PLANS, PROPERTY_KINDS, UNIT_ASSIGNMENT_MODES } from '@pms/db';
import {
  canAcrossOrganisation,
  createProperty,
  createRatePlan,
  createRoomType,
  createUnit,
  forbidden,
  getAvailability,
  getPropertyConfig,
  getRateCalendar,
  listProperties,
  quoteStay,
  setRates,
  setRatesBatch,
  updateProperty,
  updateRatePlan,
  updateRoomType,
  updateUnit,
} from '@pms/domain';
import { dateRangeQuery, dateString, money, propertyParams, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty } from '../lib/scope';
import { authorize } from '../plugins/auth';

const propertySettings = z
  .object({
    nightAuditHour: z.number().int().min(0).max(23).nullable().optional(),
    autoNoShow: z.boolean().optional(),
    invoicePrefix: z
      .string()
      .regex(/^[A-Za-z0-9]{1,4}$/, 'Up to four letters or digits')
      .optional(),
    specifiedPremises: z.boolean().optional(),
    bookingHoldMinutes: z.number().int().min(5).max(120).optional(),
    bookingEngineEnabled: z.boolean().optional(),
    bookingPayment: z.enum(['full', 'deposit', 'none']).optional(),
    depositPercent: z.number().int().min(1).max(100).optional(),
    bookingTerms: z.string().max(10_000).optional(),
    arrivalInstructions: z.string().max(4000).optional(),
    childMaxAge: z.number().int().min(0).max(17).optional(),
    departureCleanMinutes: z.number().int().min(5).max(480).optional(),
    stayoverCleanMinutes: z.number().int().min(5).max(480).optional(),
    brandColor: z.string().max(20).optional(),
    description: z.string().max(4000).optional(),
    amenities: z.array(z.string().max(80)).max(100).optional(),
    photos: z.array(z.string().max(500)).max(60).optional(),
  })
  .optional();

const propertyFields = {
  name: z.string().min(1).max(160),
  timezone: z.string().max(64).optional(),
  currency: z.string().length(3).optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  stateCode: z.string().max(2).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(2).optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.email().nullable().optional(),
  legalName: z.string().max(200).nullable().optional(),
  gstin: z.string().max(15).nullable().optional(),
  checkInTime: z.string().max(5).optional(),
  checkOutTime: z.string().max(5).optional(),
  inventoryHorizonDays: z.number().int().optional(),
  settings: propertySettings,
};

const roomTypeFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable().optional(),
  baseOccupancy: z.number().int().min(1).max(30).optional(),
  maxAdults: z.number().int().min(1).max(30).optional(),
  maxChildren: z.number().int().min(0).max(30).optional(),
  maxOccupancy: z.number().int().min(1).max(60).optional(),
  assignment: z.enum(UNIT_ASSIGNMENT_MODES).optional(),
  autoAssign: z.boolean().optional(),
  amenities: z.array(z.string().max(80)).max(100).optional(),
  photos: z.array(z.string().max(500)).max(60).optional(),
  sortOrder: z.number().int().optional(),
};

const cancellationPolicy = z
  .object({
    nonRefundable: z.boolean().optional(),
    freeCancelDays: z.number().int().min(0).max(365).optional(),
    penalty: z.enum(['first_night', 'percent', 'full']).optional(),
    penaltyPercent: z.number().min(0).max(100).optional(),
  })
  .optional();

const ratePlanFields = {
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  baseRate: money,
  includedOccupancy: z.number().int().min(1).max(30).optional(),
  extraAdultRate: money.optional(),
  extraChildRate: money.optional(),
  mealPlan: z.enum(MEAL_PLANS).optional(),
  cancellationPolicy,
  minStay: z.number().int().min(1).max(365).optional(),
  maxStay: z.number().int().min(1).max(365).nullable().optional(),
  parentRatePlanId: uuid.nullable().optional(),
  derivedPercentBp: z.number().int().min(-9999).max(100_000).optional(),
  derivedAmount: z.number().int().optional(),
  floorRate: money.nullable().optional(),
  ceilingRate: money.nullable().optional(),
  isDefault: z.boolean().optional(),
  publicBookable: z.boolean().optional(),
};

export async function propertyRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/properties',
    { schema: { tags: ['properties'], summary: 'Properties the caller can see' } },
    async (req) => {
      const actor = authorize(req);
      return { properties: await listProperties(app.db, actor) };
    },
  );

  r.post(
    '/properties',
    {
      schema: {
        tags: ['properties'],
        body: z.object({
          code: z.string().min(1).max(20),
          kind: z.enum(PROPERTY_KINDS),
          ...propertyFields,
        }),
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'property.manage');
      // A new property belongs to no existing grant, so only an organisation-wide role may add one.
      if (!canAcrossOrganisation(actor.grants, 'property.manage')) throw forbidden();
      return reply.status(201).send(await createProperty(app.db, actor, req.body));
    },
  );

  r.get(
    '/properties/:propertyId',
    {
      schema: {
        tags: ['properties'],
        summary: 'A property with its room types, units and rate plans',
        params: propertyParams,
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.read');
      return getPropertyConfig(app.db, actor.orgId, req.params.propertyId);
    },
  );

  r.patch(
    '/properties/:propertyId',
    {
      schema: {
        tags: ['properties'],
        params: propertyParams,
        body: z.object({
          ...propertyFields,
          name: propertyFields.name.optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.manage');
      return updateProperty(app.db, actor, req.params.propertyId, req.body);
    },
  );

  r.post(
    '/properties/:propertyId/room-types',
    {
      schema: {
        tags: ['properties'],
        params: propertyParams,
        body: z.object({ code: z.string().min(1).max(20), ...roomTypeFields }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.manage');
      return reply
        .status(201)
        .send(await createRoomType(app.db, actor, req.params.propertyId, req.body));
    },
  );

  r.patch(
    '/properties/:propertyId/room-types/:id',
    {
      schema: {
        tags: ['properties'],
        params: propertyParams.extend({ id: uuid }),
        body: z.object({
          ...roomTypeFields,
          name: roomTypeFields.name.optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.manage');
      return updateRoomType(app.db, actor, req.params.propertyId, req.params.id, req.body);
    },
  );

  r.post(
    '/properties/:propertyId/units',
    {
      schema: {
        tags: ['properties'],
        params: propertyParams,
        body: z.object({
          roomTypeId: uuid,
          name: z.string().min(1).max(80),
          floor: z.string().max(20).nullable().optional(),
          parentUnitId: uuid.nullable().optional(),
          sortOrder: z.number().int().optional(),
          notes: z.string().max(2000).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.manage');
      return reply
        .status(201)
        .send(await createUnit(app.db, actor, req.params.propertyId, req.body));
    },
  );

  r.patch(
    '/properties/:propertyId/units/:id',
    {
      schema: {
        tags: ['properties'],
        params: propertyParams.extend({ id: uuid }),
        body: z.object({
          name: z.string().min(1).max(80).optional(),
          floor: z.string().max(20).nullable().optional(),
          parentUnitId: uuid.nullable().optional(),
          sortOrder: z.number().int().optional(),
          notes: z.string().max(2000).nullable().optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'property.manage');
      return updateUnit(app.db, actor, req.params.propertyId, req.params.id, req.body);
    },
  );

  r.post(
    '/properties/:propertyId/rate-plans',
    {
      schema: {
        tags: ['rates'],
        params: propertyParams,
        body: z
          .object({
            roomTypeId: uuid,
            code: z.string().min(1).max(20),
            ...ratePlanFields,
            baseRate: money.optional(),
          })
          .refine((plan) => plan.baseRate !== undefined || !!plan.parentRatePlanId, {
            path: ['baseRate'],
            message: 'A rate plan needs a base rate unless it follows another plan',
          }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'rates.write');
      return reply.status(201).send(
        await createRatePlan(app.db, actor, req.params.propertyId, {
          ...req.body,
          baseRate: req.body.baseRate ?? 0,
        }),
      );
    },
  );

  r.patch(
    '/properties/:propertyId/rate-plans/:id',
    {
      schema: {
        tags: ['rates'],
        params: propertyParams.extend({ id: uuid }),
        body: z.object({
          ...ratePlanFields,
          name: ratePlanFields.name.optional(),
          baseRate: money.optional(),
          active: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'rates.write');
      return updateRatePlan(app.db, actor, req.params.propertyId, req.params.id, req.body);
    },
  );

  r.get(
    '/properties/:propertyId/rates',
    {
      schema: {
        tags: ['rates'],
        summary: 'Effective rate and restrictions per rate plan per day',
        params: propertyParams,
        querystring: dateRangeQuery.extend({ ratePlanIds: uuidList }),
      },
    },
    async (req) => {
      await authorizeProperty(app.db, req, req.params.propertyId, 'rates.read');
      return {
        days: await getRateCalendar(app.db, {
          propertyId: req.params.propertyId,
          range: { from: req.query.from, to: req.query.to },
          ratePlanIds: req.query.ratePlanIds,
        }),
      };
    },
  );

  const rateChange = z.object({
    ratePlanId: uuid,
    from: dateString,
    to: dateString,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    change: z.object({
      rate: money.nullable().optional(),
      minStayArrival: z.number().int().min(1).max(365).nullable().optional(),
      minStayThrough: z.number().int().min(1).max(365).nullable().optional(),
      maxStay: z.number().int().min(1).max(365).nullable().optional(),
      closedToArrival: z.boolean().optional(),
      closedToDeparture: z.boolean().optional(),
      stopSell: z.boolean().optional(),
    }),
  });

  r.post(
    '/properties/:propertyId/rates/batch',
    {
      schema: {
        tags: ['rates'],
        summary:
          'Save several rate and restriction changes as one: all or none, and the booking sites are told once',
        params: propertyParams,
        body: z.object({ changes: z.array(rateChange).min(1).max(200) }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'rates.write');
      return setRatesBatch(app.db, actor, {
        propertyId: req.params.propertyId,
        changes: req.body.changes.map(({ from, to, ...rest }) => ({
          ...rest,
          range: { from, to },
        })),
      });
    },
  );

  r.post(
    '/properties/:propertyId/rates',
    {
      schema: {
        tags: ['rates'],
        summary: 'Set rates and restrictions across a date range',
        params: propertyParams,
        body: rateChange,
      },
    },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'rates.write');
      const { from, to, ...rest } = req.body;
      return setRates(app.db, actor, {
        propertyId: req.params.propertyId,
        range: { from, to },
        ...rest,
      });
    },
  );

  r.get(
    '/properties/:propertyId/availability',
    {
      schema: {
        tags: ['inventory'],
        summary: 'Rooms left per room type per night',
        params: propertyParams,
        querystring: dateRangeQuery.extend({ roomTypeIds: uuidList }),
      },
    },
    async (req) => {
      await authorizeProperty(app.db, req, req.params.propertyId, 'reservations.read');
      return {
        days: await getAvailability(app.db, {
          propertyId: req.params.propertyId,
          range: { from: req.query.from, to: req.query.to },
          roomTypeIds: req.query.roomTypeIds,
        }),
      };
    },
  );

  r.post(
    '/properties/:propertyId/quote',
    {
      schema: {
        tags: ['rates'],
        summary: 'Price a stay and list any restrictions it breaks',
        params: propertyParams,
        body: z.object({
          ratePlanId: uuid,
          checkIn: dateString,
          checkOut: dateString,
          adults: z.number().int().min(1).max(30),
          children: z.number().int().min(0).max(30).optional(),
        }),
      },
    },
    async (req) => {
      await authorizeProperty(app.db, req, req.params.propertyId, 'reservations.read');
      return quoteStay(app.db, { propertyId: req.params.propertyId, ...req.body });
    },
  );
}
