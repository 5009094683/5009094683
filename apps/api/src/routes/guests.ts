import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { guests } from '@pms/db';
import {
  anonymiseGuest,
  canAcrossOrganisation,
  exportGuestData,
  forbidden,
  guestView,
  listReservations,
  notFound,
  propertyScope,
  revealGuestIdNumber,
  searchGuests,
  updateGuest,
} from '@pms/domain';
import { dateString, guestInput, idParams } from '../lib/schemas';
import { authorize } from '../plugins/auth';

export async function guestRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/guests',
    {
      schema: {
        tags: ['guests'],
        querystring: z.object({
          query: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'guests.read');
      const rows = await searchGuests(app.db, actor.orgId, req.query);
      return { guests: rows.map(guestView) };
    },
  );

  r.get(
    '/guests/:id',
    {
      schema: { tags: ['guests'], summary: 'A guest profile with stay history', params: idParams },
    },
    async (req) => {
      const actor = authorize(req, 'guests.read');
      const [guest] = await app.db
        .select()
        .from(guests)
        .where(and(eq(guests.id, req.params.id), eq(guests.orgId, actor.orgId)));
      if (!guest) throw notFound('Guest', req.params.id);
      // Stay history is limited to the properties the caller may see.
      const history = await listReservations(app.db, actor.orgId, {
        propertyIds: propertyScope(actor.grants, 'reservations.read'),
        guestId: guest.id,
        sort: 'created',
        limit: 100,
      });
      return { guest: guestView(guest), stays: history.reservations };
    },
  );

  r.patch(
    '/guests/:id',
    {
      schema: {
        tags: ['guests'],
        params: idParams,
        body: guestInput.omit({ id: true }).extend({
          dateOfBirth: dateString.nullable().optional(),
          idType: z.string().max(40).nullable().optional(),
          idNumber: z.string().max(60).nullable().optional(),
          idExpiry: dateString.nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
          tags: z.array(z.string().max(40)).max(30).optional(),
          vip: z.boolean().optional(),
          blacklisted: z.boolean().optional(),
          marketingConsent: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'guests.write');
      return guestView(await updateGuest(app.db, actor, req.params.id, req.body));
    },
  );

  r.post(
    '/guests/:id/reveal-id',
    {
      schema: {
        tags: ['guests'],
        summary: 'Show the identity document number (recorded in the audit log)',
        params: idParams,
      },
    },
    async (req) => {
      const actor = authorize(req, 'guests.pii');
      return { idNumber: await revealGuestIdNumber(app.db, actor, req.params.id) };
    },
  );

  r.get(
    '/guests/:id/export',
    {
      schema: {
        tags: ['guests'],
        summary:
          'Everything held about a guest, for a guest who asks for a copy of their data (recorded in the audit log)',
        params: idParams,
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'guests.pii');
      // A guest's stays and messages span properties, so the copy is for roles that do too.
      if (!canAcrossOrganisation(actor.grants, 'guests.pii')) throw forbidden();
      const data = await exportGuestData(app.db, actor, req.params.id);
      return reply
        .header('content-disposition', `attachment; filename="guest-data-${req.params.id}.json"`)
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );

  r.post(
    '/guests/:id/erase',
    {
      schema: {
        tags: ['guests'],
        summary:
          'Erase a guest\u2019s personal details. Their stays remain, without a name. Cannot be undone.',
        params: idParams,
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'property.manage');
      if (!canAcrossOrganisation(actor.grants, 'property.manage')) throw forbidden();
      await anonymiseGuest(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );
}
