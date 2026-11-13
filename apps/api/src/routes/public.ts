import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { paymentOrders, properties, reservations } from '@pms/db';
import {
  addCheckinDocument,
  cancelGuestBooking,
  createBooking,
  getGuestBooking,
  getGuestCheckin,
  getPublicProperty,
  guestBookingUrl,
  ID_TYPES,
  listPublicProperties,
  MockGateway,
  notFound,
  publicOrganization,
  removeCheckinDocument,
  reservationForGuestToken,
  searchStay,
  submitGuestCheckin,
  syncGuestPayments,
  validationError,
} from '@pms/domain';
import { dateString, uuid } from '../lib/schemas';

/** Guest links are about 53 characters; anything far from that is not one. */
const token = z.string().min(20).max(120);
const tokenParams = z.object({ token });
const org = z.string().max(80).optional();
const propertyCode = z.string().min(1).max(20);

const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * What the booking site calls: no sign-in, every route rate limited. Prices
 * are worked out on the server from the rates on file; a guest's own booking
 * is opened with the signed link they were given, never by its code.
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const orgOf = async (slug: string | undefined) => (await publicOrganization(app.db, slug)).id;

  r.get(
    '/public/properties',
    {
      ...limit(120),
      schema: {
        tags: ['booking site'],
        summary: 'Properties that take bookings on the website',
        querystring: z.object({ org }),
      },
    },
    async (req) => {
      const organisation = await publicOrganization(app.db, req.query.org);
      return {
        organisation: { name: organisation.name, slug: organisation.slug },
        properties: await listPublicProperties(app.db, organisation.id),
      };
    },
  );

  r.get(
    '/public/properties/:code',
    {
      ...limit(120),
      schema: {
        tags: ['booking site'],
        params: z.object({ code: propertyCode }),
        querystring: z.object({ org }),
      },
    },
    async (req) => getPublicProperty(app.db, await orgOf(req.query.org), req.params.code),
  );

  r.get(
    '/public/properties/:code/availability',
    {
      ...limit(90),
      schema: {
        tags: ['booking site'],
        summary: 'Rooms free for the dates, with the price of each rate',
        params: z.object({ code: propertyCode }),
        querystring: z.object({
          org,
          checkIn: dateString,
          checkOut: dateString,
          adults: z.coerce.number().int().min(1).max(30).default(2),
          children: z.coerce.number().int().min(0).max(30).default(0),
          promo: z.string().max(30).optional(),
        }),
      },
    },
    async (req) =>
      searchStay(app.db, await orgOf(req.query.org), {
        propertyCode: req.params.code,
        checkIn: req.query.checkIn,
        checkOut: req.query.checkOut,
        adults: req.query.adults,
        children: req.query.children,
        promoCode: req.query.promo,
      }),
  );

  r.post(
    '/public/bookings',
    {
      // Each booking holds rooms for a while, so this is the route worth limiting hardest.
      ...limit(10),
      schema: {
        tags: ['booking site'],
        summary: 'Hold the rooms and get the address of the payment page',
        body: z.object({
          org,
          propertyCode,
          checkIn: dateString,
          checkOut: dateString,
          rooms: z
            .array(
              z.object({
                roomTypeId: uuid,
                ratePlanId: uuid,
                adults: z.number().int().min(1).max(30),
                children: z.number().int().min(0).max(30).optional(),
              }),
            )
            .min(1)
            .max(8),
          guest: z.object({
            firstName: z.string().trim().min(1).max(120),
            lastName: z.string().trim().max(120).default(''),
            email: z.string().trim().max(254),
            phone: z.string().trim().max(40).nullable().optional(),
            country: z.string().trim().max(60).nullable().optional(),
          }),
          arrivalTime: z.string().max(20).nullable().optional(),
          specialRequests: z.string().max(2000).nullable().optional(),
          promoCode: z.string().max(30).nullable().optional(),
          acceptTerms: z.boolean(),
          marketingConsent: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { org: slug, ...request } = req.body;
      const booked = await createBooking(app.db, app.gateway(), await orgOf(slug), request);
      return reply.status(201).send(booked);
    },
  );

  r.get(
    '/public/bookings/:token',
    { ...limit(120), schema: { tags: ['booking site'], params: tokenParams } },
    async (req) => getGuestBooking(app.db, req.params.token),
  );

  r.post(
    '/public/bookings/:token/sync',
    {
      ...limit(30),
      schema: {
        tags: ['booking site'],
        summary: 'Back from the payment page: find out whether the payment went through',
        params: tokenParams,
      },
    },
    async (req) => syncGuestPayments(app.db, app.gateway(), req.params.token),
  );

  r.post(
    '/public/bookings/:token/cancel',
    { ...limit(10), schema: { tags: ['booking site'], params: tokenParams } },
    async (req) => cancelGuestBooking(app.db, app.gateway(), req.params.token),
  );

  r.get(
    '/public/bookings/:token/pay/:orderId',
    {
      ...limit(60),
      schema: {
        tags: ['booking site'],
        summary: 'A payment link sent by the property',
        params: tokenParams.extend({ orderId: uuid }),
      },
    },
    async (req) => {
      const { reservation, property } = await reservationForGuestToken(app.db, req.params.token);
      const [order] = await app.db
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.id, req.params.orderId),
            eq(paymentOrders.reservationId, reservation.id),
          ),
        );
      if (!order) throw notFound('Payment link');
      const lapsed = order.status === 'created' && order.expiresAt.getTime() <= Date.now();
      return {
        bookingCode: reservation.code,
        guestName: reservation.guestName,
        propertyName: property.name,
        amount: order.amount,
        currency: order.currency,
        description: order.description,
        status: lapsed ? ('expired' as const) : order.status,
        checkoutUrl: order.status === 'created' && !lapsed ? order.checkoutUrl : null,
        expiresAt: order.expiresAt,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Online check-in

  const checkinGuest = z.object({
    name: z.string().trim().min(1).max(160),
    nationality: z.string().trim().length(2).nullable().optional(),
    dateOfBirth: dateString.nullable().optional(),
    idType: z.enum(ID_TYPES).nullable().optional(),
    idNumber: z.string().trim().max(60).nullable().optional(),
    idExpiry: dateString.nullable().optional(),
    address: z.string().max(400).nullable().optional(),
    visaNumber: z.string().trim().max(60).nullable().optional(),
    visaExpiry: dateString.nullable().optional(),
    arrivedInCountryOn: dateString.nullable().optional(),
    arrivingFrom: z.string().max(120).nullable().optional(),
    nextDestination: z.string().max(120).nullable().optional(),
  });

  r.get(
    '/public/bookings/:token/check-in',
    { ...limit(120), schema: { tags: ['booking site'], params: tokenParams } },
    async (req) => getGuestCheckin(app.db, req.params.token),
  );

  r.post(
    '/public/bookings/:token/check-in',
    {
      ...limit(20),
      schema: {
        tags: ['booking site'],
        summary: 'Save the guests\u2019 details before arrival',
        params: tokenParams,
        body: z.object({
          arrivalTime: z.string().max(20).nullable().optional(),
          guests: z.array(checkinGuest).min(1).max(30),
          signatureName: z.string().trim().min(1).max(160),
          acceptTerms: z.boolean(),
        }),
      },
    },
    async (req) =>
      submitGuestCheckin(app.db, req.params.token, req.body, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
  );

  r.delete(
    '/public/bookings/:token/check-in/documents/:id',
    {
      ...limit(30),
      schema: { tags: ['booking site'], params: tokenParams.extend({ id: uuid }) },
    },
    async (req, reply) => {
      await removeCheckinDocument(app.db, app.files, req.params.token, req.params.id);
      return reply.status(204).send();
    },
  );

  // Uploads arrive as the file itself, not as JSON, so they get their own body parser.
  await app.register(async (upload) => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      upload.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) =>
        done(null, body),
      );
    }
    upload.post(
      '/public/bookings/:token/check-in/documents',
      {
        ...limit(20),
        bodyLimit: 9 * 1024 * 1024,
        schema: {
          tags: ['booking site'],
          summary: 'Add a photo or scan of an identity document (the request body is the file)',
        },
      },
      async (req: FastifyRequest, reply) => {
        const params = tokenParams.safeParse(req.params);
        if (!params.success) throw notFound('Booking');
        if (!Buffer.isBuffer(req.body)) throw validationError('Send the file as the request body');
        const header = req.headers['x-file-name'];
        const name = typeof header === 'string' ? decodeURIComponent(header) : 'document';
        const document = await addCheckinDocument(app.db, app.files, params.data.token, {
          fileName: name,
          data: req.body,
        });
        return reply.status(201).send(document);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // The stand-in payment page, served only when no real gateway is configured

  if (app.env.PAYMENT_PROVIDER === 'mock') {
    const mock = new MockGateway(app.db, app.env.API_PUBLIC_URL);
    const find = async (providerOrderId: string) => {
      const [row] = await app.db
        .select({ order: paymentOrders, propertyName: properties.name })
        .from(paymentOrders)
        .innerJoin(properties, eq(properties.id, paymentOrders.propertyId))
        .where(
          and(
            eq(paymentOrders.provider, 'mock'),
            eq(paymentOrders.providerOrderId, providerOrderId),
          ),
        );
      if (!row) throw notFound('Payment');
      return row;
    };
    const orderParams = z.object({ orderId: z.string().regex(/^mock_[\w-]{8,40}$/) });

    r.get(
      '/public/mock-pay/:orderId',
      { ...limit(60), schema: { hide: true, params: orderParams } },
      async (req, reply) => {
        const { order, propertyName } = await find(req.params.orderId);
        const state = await mock.fetchOrder(order.providerOrderId);
        const amount = new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: order.currency,
        }).format(order.amount / 100);
        const open = state.status === 'open' && order.status === 'created';
        const action = `${app.env.API_PUBLIC_URL.replace(/\/+$/, '')}/public/mock-pay/${order.providerOrderId}`;
        return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Test payment</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1c2430;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:28px;max-width:380px;width:calc(100% - 32px)}
h1{font-size:18px;margin:0 0 4px}p{margin:6px 0;color:#566173}.amount{font-size:30px;font-weight:650;color:#1c2430;margin:14px 0}
.note{background:#fff7e0;border:1px solid #f0d58a;border-radius:8px;padding:10px 12px;font-size:14px;color:#6a5200;margin:14px 0}
button{font:inherit;border-radius:8px;padding:11px 14px;border:1px solid #c8ced8;background:#fff;cursor:pointer;width:100%;margin-top:8px}
button.pay{background:#0f766e;border-color:#0f766e;color:#fff;font-weight:600}
</style></head><body><main>
<h1>${esc(propertyName)}</h1><p>${esc(order.description ?? 'Payment')}</p>
<div class="amount">${esc(amount)}</div>
<div class="note">This is a stand-in payment page for testing. No money moves and no card is asked for. A real gateway replaces it once its keys are set.</div>
${
  open
    ? `<form method="post" action="${esc(action)}"><button class="pay" name="outcome" value="paid">Pay ${esc(amount)}</button><button name="outcome" value="cancelled">Cancel</button></form>`
    : `<p>This payment is ${state.status === 'paid' ? 'already made' : 'no longer open'}.</p>`
}
</main></body></html>`);
      },
    );

    await app.register(async (form) => {
      form.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
      );
      form.post(
        '/public/mock-pay/:orderId',
        { ...limit(30), schema: { hide: true } },
        async (req: FastifyRequest, reply) => {
          const params = orderParams.safeParse(req.params);
          if (!params.success) throw notFound('Payment');
          const outcome = (req.body as { outcome?: string } | undefined)?.outcome;
          const { order } = await find(params.data.orderId);
          await mock.complete(order.providerOrderId, outcome === 'paid' ? 'paid' : 'cancelled');
          // Back to where a real gateway would send the guest: their booking on the booking site.
          const [reservation] = await app.db
            .select()
            .from(reservations)
            .where(eq(reservations.id, order.reservationId));
          if (!reservation) throw notFound('Booking');
          return reply.redirect(
            guestBookingUrl(
              reservation,
              order.purpose === 'payment_link' ? `/pay/${order.id}?paid=1` : '?paid=1',
            ),
            303,
          );
        },
      );
    });
  }
}
