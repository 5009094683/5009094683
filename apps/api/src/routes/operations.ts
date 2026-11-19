import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  COMPANY_KINDS,
  HOUSEKEEPING_TASK_KINDS,
  INVOICE_TYPES,
  MAINTENANCE_STATUSES,
  PAYMENT_METHODS,
  PRIORITIES,
  TASK_STATUSES,
  TAX_CATEGORIES,
  folioLines,
  folios,
  housekeepingTasks,
  invoices,
  maintenanceIssues,
  payments,
  properties,
  roleAssignments,
  users,
  type Database,
} from '@pms/db';
import {
  CHARGE_KINDS,
  ROLE_PERMISSIONS,
  can,
  checkIn,
  checkOut,
  closeFolio,
  companyStatement,
  conflict,
  createCompany,
  createFolio,
  createHousekeepingTask,
  DomainError,
  freeUnitsFor,
  frontDeskBoard,
  getFolio,
  getInvoice,
  housekeepingBoard,
  invalidState,
  issueCreditNote,
  issueInvoice,
  listCompanies,
  listFolios,
  listInvoices,
  listIssues,
  listNightAudits,
  moveLines,
  nightAuditStatus,
  notFound,
  postCharge,
  propertyScope,
  recordPayment,
  refreshHousekeepingTasks,
  refundOnline,
  refundPayment,
  reopenFolio,
  reportIssue,
  reservationBalance,
  runNightAudit,
  saveTaxRule,
  setHousekeepingStatus,
  taxRulesFor,
  transferToCompany,
  undoCheckIn,
  updateCompany,
  updateHousekeepingTask,
  updateIssue,
  voidLine,
  type Actor,
  type Permission,
} from '@pms/domain';
import { dateString, idParams, money, propertyParams, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty, authorizeReservation, scopedProperties } from '../lib/scope';
import { authorize } from '../plugins/auth';

/** Authorises an action on something that belongs to a property, found by a lookup. */
async function authorizeVia(
  req: FastifyRequest,
  what: string,
  id: string,
  permission: Permission,
  lookup: (orgId: string) => Promise<string | undefined>,
): Promise<{ actor: Actor; propertyId: string }> {
  const session = authorize(req);
  const propertyId = await lookup(session.orgId);
  if (!propertyId) throw notFound(what, id);
  return { actor: authorize(req, permission, propertyId), propertyId };
}

function folioProperty(db: Database, folioId: string) {
  return async (orgId: string): Promise<string | undefined> => {
    const [row] = await db
      .select({ propertyId: folios.propertyId })
      .from(folios)
      .innerJoin(properties, eq(properties.id, folios.propertyId))
      .where(and(eq(folios.id, folioId), eq(properties.orgId, orgId)));
    return row?.propertyId;
  };
}

const billTo = z.object({
  name: z.string().trim().min(1).max(200),
  addressLine1: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  stateCode: z.string().max(4).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(60).nullable().optional(),
  gstin: z.string().max(20).nullable().optional(),
  email: z.email().nullable().optional(),
});

const chargeBody = z.object({
  kind: z.enum(CHARGE_KINDS),
  description: z.string().trim().min(1).max(300),
  unitAmount: money,
  quantity: z.number().int().min(1).max(1000).optional(),
  discountOn: z.enum(['room', 'food', 'service', 'extra', 'fee']).optional(),
});

const offSale = z.object({ from: dateString, to: dateString });

const companyBody = z.object({
  kind: z.enum(COMPANY_KINDS).optional(),
  name: z.string().trim().min(1).max(200),
  legalName: z.string().max(200).nullable().optional(),
  gstin: z.string().max(20).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  stateCode: z.string().max(4).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().max(60).optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  contactName: z.string().max(160).nullable().optional(),
  creditLimit: money.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  commissionBp: z.number().int().min(0).max(5000).optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
});

export async function operationsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------------
  // Front desk

  r.get(
    '/properties/:propertyId/front-desk',
    {
      schema: {
        tags: ['front desk'],
        summary: 'Arrivals, departures and guests in house for a hotel day',
        params: propertyParams,
        querystring: z.object({ date: dateString.optional() }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'reservations.read',
      );
      return frontDeskBoard(app.db, actor.orgId, req.params.propertyId, req.query.date, {
        hideBalances: !can(actor.grants, 'folio.read', req.params.propertyId),
      });
    },
  );

  r.get(
    '/reservations/:id/rooms/:roomId/free-units',
    {
      schema: {
        tags: ['front desk'],
        summary: 'Units free for the whole stay, for choosing a room',
        params: z.object({ id: uuid, roomId: uuid }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'reservations.read');
      return { units: await freeUnitsFor(app.db, actor.orgId, req.params.id, req.params.roomId) };
    },
  );

  r.post(
    '/reservations/:id/check-in',
    {
      schema: {
        tags: ['front desk'],
        params: idParams,
        body: z.object({
          roomIds: z.array(uuid).max(60).optional(),
          units: z.record(uuid, uuid).optional().describe('Unit to give each room, by room id'),
          allowDirty: z.boolean().optional().describe('Check in although the unit is not clean'),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'frontdesk.operate');
      return checkIn(app.db, actor, req.params.id, req.body);
    },
  );

  r.post(
    '/reservations/:id/undo-check-in',
    {
      schema: {
        tags: ['front desk'],
        params: idParams,
        body: z.object({ roomIds: z.array(uuid).max(60).optional() }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'frontdesk.operate');
      return undoCheckIn(app.db, actor, req.params.id, req.body.roomIds);
    },
  );

  r.post(
    '/reservations/:id/check-out',
    {
      schema: {
        tags: ['front desk'],
        summary: 'Check out; unsettled money is refused, billed to the company, or left open',
        params: idParams,
        body: z.object({
          roomIds: z.array(uuid).max(60).optional(),
          balance: z.enum(['require_settled', 'bill_company', 'leave_open']).optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'frontdesk.operate');
      return checkOut(app.db, actor, req.params.id, req.body);
    },
  );

  // ---------------------------------------------------------------------------
  // Folios, payments, invoices

  r.get(
    '/reservations/:id/folios',
    { schema: { tags: ['folios'], params: idParams } },
    async (req) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'folio.read');
      const list = await listFolios(app.db, actor.orgId, req.params.id);
      const issued =
        list.length > 0
          ? await app.db
              .select()
              .from(invoices)
              .where(
                inArray(
                  invoices.folioId,
                  list.map((f) => f.id),
                ),
              )
          : [];
      return {
        folios: list,
        balance: await reservationBalance(app.db, req.params.id),
        invoices: issued.sort((a, b) => a.number.localeCompare(b.number)),
      };
    },
  );

  r.post(
    '/reservations/:id/folios',
    {
      schema: {
        tags: ['folios'],
        summary: 'Add a folio to split the bill',
        params: idParams,
        body: z.object({
          label: z.string().trim().min(1).max(80),
          companyId: uuid.nullable().optional(),
          billTo: billTo.optional(),
          routes: z.array(z.enum(CHARGE_KINDS)).max(6).optional(),
        }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'folio.write');
      return reply.status(201).send(await createFolio(app.db, actor, req.params.id, req.body));
    },
  );

  r.post(
    '/reservations/:id/charges',
    {
      schema: {
        tags: ['folios'],
        summary: 'Post a charge to whichever of the reservation’s folios takes that kind',
        params: idParams,
        body: chargeBody,
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeReservation(app.db, req, req.params.id, 'folio.write');
      const line = await postCharge(app.db, actor, { ...req.body, reservationId: req.params.id });
      return reply.status(201).send(line);
    },
  );

  r.get('/folios/:id', { schema: { tags: ['folios'], params: idParams } }, async (req) => {
    const { actor } = await authorizeVia(
      req,
      'Folio',
      req.params.id,
      'folio.read',
      folioProperty(app.db, req.params.id),
    );
    return getFolio(app.db, actor.orgId, req.params.id);
  });

  r.post(
    '/folios/:id/charges',
    { schema: { tags: ['folios'], params: idParams, body: chargeBody } },
    async (req, reply) => {
      const { actor } = await authorizeVia(
        req,
        'Folio',
        req.params.id,
        'folio.write',
        folioProperty(app.db, req.params.id),
      );
      const line = await postCharge(app.db, actor, { ...req.body, folioId: req.params.id });
      return reply.status(201).send(line);
    },
  );

  r.post(
    '/folios/:id/payments',
    {
      schema: {
        tags: ['folios'],
        summary: 'Record money received',
        params: idParams,
        body: z.object({
          method: z.enum(PAYMENT_METHODS),
          amount: money.refine((v) => v > 0, 'The amount must be above zero'),
          reference: z.string().max(120).nullable().optional(),
          note: z.string().max(500).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeVia(
        req,
        'Folio',
        req.params.id,
        'folio.write',
        folioProperty(app.db, req.params.id),
      );
      const result = await recordPayment(app.db, actor, { ...req.body, folioId: req.params.id });
      return reply.status(201).send(result);
    },
  );

  r.post(
    '/payments/:id/refund',
    {
      schema: {
        tags: ['folios'],
        params: idParams,
        body: z.object({
          amount: money.optional(),
          reason: z.string().trim().min(1).max(500),
          method: z.enum(PAYMENT_METHODS).optional(),
          reference: z.string().max(120).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeVia(
        req,
        'Payment',
        req.params.id,
        'payments.refund',
        async (orgId) => {
          const [row] = await app.db
            .select({ propertyId: payments.propertyId })
            .from(payments)
            .innerJoin(properties, eq(properties.id, payments.propertyId))
            .where(and(eq(payments.id, req.params.id), eq(properties.orgId, orgId)));
          return row?.propertyId;
        },
      );
      const [payment] = await app.db.select().from(payments).where(eq(payments.id, req.params.id));
      // Money that came through the payment gateway goes back through it, unless staff say it was returned another way.
      const viaGateway =
        payment?.provider &&
        payment.providerPaymentId &&
        (req.body.method === undefined || req.body.method === 'online');
      if (viaGateway) {
        const gateway = app.gateway();
        if (payment.provider !== gateway.name) {
          throw invalidState(
            `This payment was taken through ${payment.provider}, which is not the gateway in use. Refund it there, then record the refund here with another method.`,
          );
        }
        const [left] = (
          await app.db.execute<{ left: string }>(sql`
            SELECT (p.amount + coalesce((SELECT sum(r.amount) FROM payments r
              WHERE r.refund_of_payment_id = p.id AND r.status = 'captured'), 0))::text AS left
            FROM payments p WHERE p.id = ${payment.id}`)
        ).rows;
        const amount = req.body.amount ?? Number(left?.left ?? 0);
        if (amount <= 0) throw conflict('This payment has already been refunded in full');
        const ok = await refundOnline(
          app.db,
          gateway,
          payment.id,
          { amount, reason: req.body.reason },
          actor,
        );
        if (!ok) {
          throw new DomainError(
            'upstream_failed',
            'The payment gateway did not accept the refund. Nothing was recorded; try again, or refund it in the gateway\u2019s own dashboard and record it here with another method.',
          );
        }
        const [refund] = await app.db
          .select()
          .from(payments)
          .where(eq(payments.refundOfPaymentId, payment.id))
          .orderBy(desc(payments.createdAt))
          .limit(1);
        const [line] = await app.db
          .select()
          .from(folioLines)
          .where(eq(folioLines.paymentId, refund!.id));
        return reply.status(201).send({ payment: refund!, line: line! });
      }
      return reply.status(201).send(await refundPayment(app.db, actor, req.params.id, req.body));
    },
  );

  r.post(
    '/folio-lines/:id/void',
    {
      schema: {
        tags: ['folios'],
        summary: 'Void a charge. It stays on record with the reason.',
        params: idParams,
        body: z.object({ reason: z.string().trim().min(1).max(300) }),
      },
    },
    async (req) => {
      const { actor } = await authorizeVia(
        req,
        'Folio entry',
        req.params.id,
        'folio.write',
        async (orgId) => {
          const [row] = await app.db
            .select({ propertyId: folioLines.propertyId })
            .from(folioLines)
            .innerJoin(properties, eq(properties.id, folioLines.propertyId))
            .where(and(eq(folioLines.id, req.params.id), eq(properties.orgId, orgId)));
          return row?.propertyId;
        },
      );
      return voidLine(app.db, actor, req.params.id, req.body.reason);
    },
  );

  r.post(
    '/folios/:id/move-lines',
    {
      schema: {
        tags: ['folios'],
        summary: 'Move charges to this folio from another folio of the same reservation',
        params: idParams,
        body: z.object({ lineIds: z.array(uuid).min(1).max(500) }),
      },
    },
    async (req) => {
      const { actor } = await authorizeVia(
        req,
        'Folio',
        req.params.id,
        'folio.write',
        folioProperty(app.db, req.params.id),
      );
      return { moved: await moveLines(app.db, actor, req.body.lineIds, req.params.id) };
    },
  );

  r.post(
    '/folios/:id/bill-company',
    {
      schema: {
        tags: ['folios'],
        summary: 'Move what is owed to a company’s account',
        params: idParams,
        body: z.object({ companyId: uuid }),
      },
    },
    async (req) => {
      const { actor } = await authorizeVia(
        req,
        'Folio',
        req.params.id,
        'folio.write',
        folioProperty(app.db, req.params.id),
      );
      return transferToCompany(app.db, actor, req.params.id, req.body.companyId);
    },
  );

  for (const action of ['close', 'reopen'] as const) {
    r.post(
      `/folios/:id/${action}`,
      { schema: { tags: ['folios'], params: idParams } },
      async (req) => {
        const { actor } = await authorizeVia(
          req,
          'Folio',
          req.params.id,
          'folio.write',
          folioProperty(app.db, req.params.id),
        );
        return action === 'close'
          ? closeFolio(app.db, actor, req.params.id)
          : reopenFolio(app.db, actor, req.params.id);
      },
    );
  }

  r.post(
    '/folios/:id/invoices',
    {
      schema: {
        tags: ['invoices'],
        summary: 'Issue a tax invoice for the folio’s charges that are not yet invoiced',
        params: idParams,
        body: z.object({ lineIds: z.array(uuid).max(1000).optional(), billTo: billTo.optional() }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeVia(
        req,
        'Folio',
        req.params.id,
        'folio.write',
        folioProperty(app.db, req.params.id),
      );
      return reply.status(201).send(await issueInvoice(app.db, actor, req.params.id, req.body));
    },
  );

  r.get(
    '/invoices',
    {
      schema: {
        tags: ['invoices'],
        querystring: z.object({
          propertyIds: uuidList,
          from: dateString.optional(),
          to: dateString.optional(),
          type: z.enum(INVOICE_TYPES).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(req, 'folio.read', req.query.propertyIds);
      return { invoices: await listInvoices(app.db, actor.orgId, { ...req.query, propertyIds }) };
    },
  );

  const invoiceProperty = (invoiceId: string) => async (orgId: string) => {
    const [row] = await app.db
      .select({ propertyId: invoices.propertyId })
      .from(invoices)
      .innerJoin(properties, eq(properties.id, invoices.propertyId))
      .where(and(eq(invoices.id, invoiceId), eq(properties.orgId, orgId)));
    return row?.propertyId;
  };

  r.get('/invoices/:id', { schema: { tags: ['invoices'], params: idParams } }, async (req) => {
    const { actor } = await authorizeVia(
      req,
      'Invoice',
      req.params.id,
      'folio.read',
      invoiceProperty(req.params.id),
    );
    return getInvoice(app.db, actor.orgId, req.params.id);
  });

  r.post(
    '/invoices/:id/credit-notes',
    {
      schema: {
        tags: ['invoices'],
        summary: 'Correct an invoice with a credit note',
        params: idParams,
        body: z.object({
          reason: z.string().trim().min(1).max(500),
          lines: z
            .array(z.object({ index: z.number().int().min(0), amount: money.optional() }))
            .max(1000)
            .optional(),
        }),
      },
    },
    async (req, reply) => {
      const { actor } = await authorizeVia(
        req,
        'Invoice',
        req.params.id,
        'accounting.manage',
        invoiceProperty(req.params.id),
      );
      return reply.status(201).send(await issueCreditNote(app.db, actor, req.params.id, req.body));
    },
  );

  // ---------------------------------------------------------------------------
  // Tax rules

  r.get(
    '/properties/:propertyId/tax-rules',
    { schema: { tags: ['tax'], params: propertyParams } },
    async (req) => {
      await authorizeProperty(app.db, req, req.params.propertyId, 'folio.read');
      return { rules: await taxRulesFor(app.db, req.params.propertyId) };
    },
  );

  r.put(
    '/properties/:propertyId/tax-rules/:category',
    {
      schema: {
        tags: ['tax'],
        summary: 'Replace how one kind of charge is taxed. Charges already posted are not changed.',
        params: z.object({ propertyId: uuid, category: z.enum(TAX_CATEGORIES) }),
        body: z.object({
          name: z.string().trim().min(1).max(120),
          serviceCode: z.string().max(20).nullable().optional(),
          slabs: z
            .array(
              z.object({ upTo: money.nullable(), rateBp: z.number().int().min(0).max(10_000) }),
            )
            .min(1)
            .max(10),
          components: z
            .array(
              z.object({
                code: z.string().trim().min(1).max(12),
                shareBp: z.number().int().min(1).max(10_000),
              }),
            )
            .min(1)
            .max(6),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'accounting.manage',
      );
      return saveTaxRule(app.db, actor, req.params.propertyId, {
        ...req.body,
        category: req.params.category,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Night audit

  r.get(
    '/properties/:propertyId/night-audit',
    { schema: { tags: ['night audit'], params: propertyParams } },
    async (req) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'folio.read');
      return {
        status: await nightAuditStatus(app.db, actor.orgId, req.params.propertyId),
        audits: await listNightAudits(app.db, actor.orgId, req.params.propertyId, 30),
      };
    },
  );

  r.post(
    '/properties/:propertyId/night-audit',
    {
      schema: {
        tags: ['night audit'],
        summary: 'Close the current hotel day: post room charges and move to the next day',
        params: propertyParams,
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'nightaudit.run');
      return reply.status(201).send(await runNightAudit(app.db, actor, req.params.propertyId));
    },
  );

  // ---------------------------------------------------------------------------
  // Housekeeping

  r.get(
    '/properties/:propertyId/housekeeping',
    {
      schema: {
        tags: ['housekeeping'],
        params: propertyParams,
        querystring: z.object({ date: dateString.optional() }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'housekeeping.read',
      );
      return housekeepingBoard(app.db, actor.orgId, req.params.propertyId, req.query.date);
    },
  );

  r.post(
    '/properties/:propertyId/housekeeping/refresh',
    {
      schema: {
        tags: ['housekeeping'],
        summary: 'Write today’s cleaning list from who is leaving and staying',
        params: propertyParams,
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'housekeeping.write',
      );
      return { added: await refreshHousekeepingTasks(app.db, actor, req.params.propertyId) };
    },
  );

  r.post(
    '/properties/:propertyId/housekeeping/status',
    {
      schema: {
        tags: ['housekeeping'],
        summary: 'Mark rooms clean, dirty or inspected',
        params: propertyParams,
        body: z.object({
          unitIds: z.array(uuid).min(1).max(500),
          status: z.enum(['clean', 'dirty', 'inspected']),
        }),
      },
    },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'housekeeping.write',
      );
      return {
        changed: await setHousekeepingStatus(app.db, actor, req.body.unitIds, req.body.status),
      };
    },
  );

  r.post(
    '/housekeeping/tasks',
    {
      schema: {
        tags: ['housekeeping'],
        body: z.object({
          propertyId: uuid,
          unitId: uuid,
          kind: z.enum(HOUSEKEEPING_TASK_KINDS),
          date: dateString.optional(),
          priority: z.enum(PRIORITIES).optional(),
          assignedTo: uuid.nullable().optional(),
          notes: z.string().max(1000).nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.body.propertyId, 'housekeeping.write');
      return reply.status(201).send(await createHousekeepingTask(app.db, actor, req.body));
    },
  );

  r.patch(
    '/housekeeping/tasks/:id',
    {
      schema: {
        tags: ['housekeeping'],
        params: idParams,
        body: z.object({
          status: z.enum(TASK_STATUSES).optional(),
          assignedTo: uuid.nullable().optional(),
          priority: z.enum(PRIORITIES).optional(),
          notes: z.string().max(1000).nullable().optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeVia(
        req,
        'Task',
        req.params.id,
        'housekeeping.write',
        async (orgId) => {
          const [row] = await app.db
            .select({ propertyId: housekeepingTasks.propertyId })
            .from(housekeepingTasks)
            .innerJoin(properties, eq(properties.id, housekeepingTasks.propertyId))
            .where(and(eq(housekeepingTasks.id, req.params.id), eq(properties.orgId, orgId)));
          return row?.propertyId;
        },
      );
      return updateHousekeepingTask(app.db, actor, req.params.id, req.body);
    },
  );

  /** People who can be given housekeeping or maintenance work at a property. */
  r.get(
    '/properties/:propertyId/staff',
    { schema: { tags: ['housekeeping'], params: propertyParams } },
    async (req) => {
      const actor = await authorizeProperty(
        app.db,
        req,
        req.params.propertyId,
        'housekeeping.read',
      );
      const rows = await app.db
        .select({ id: users.id, name: users.name, role: roleAssignments.role })
        .from(users)
        .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
        .where(
          and(
            eq(users.orgId, actor.orgId),
            eq(users.status, 'active'),
            or(
              eq(roleAssignments.propertyId, req.params.propertyId),
              isNull(roleAssignments.propertyId),
            ),
          ),
        );
      const staff = new Map<string, { id: string; name: string; roles: string[] }>();
      for (const row of rows) {
        const can = ROLE_PERMISSIONS[row.role];
        if (!can.includes('housekeeping.write') && !can.includes('maintenance.write')) continue;
        const entry = staff.get(row.id) ?? { id: row.id, name: row.name, roles: [] };
        entry.roles.push(row.role);
        staff.set(row.id, entry);
      }
      return { staff: [...staff.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
  );

  // ---------------------------------------------------------------------------
  // Maintenance

  r.get(
    '/maintenance',
    {
      schema: {
        tags: ['maintenance'],
        querystring: z.object({
          propertyIds: uuidList,
          status: z.enum(['open', 'done', 'all']).optional(),
          unitId: uuid.optional(),
        }),
      },
    },
    async (req) => {
      const { actor, propertyIds } = scopedProperties(
        req,
        'housekeeping.read',
        req.query.propertyIds,
      );
      return {
        issues: await listIssues(app.db, actor.orgId, {
          propertyIds,
          status: req.query.status,
          unitId: req.query.unitId,
        }),
      };
    },
  );

  r.post(
    '/maintenance',
    {
      schema: {
        tags: ['maintenance'],
        summary: 'Report something to fix, optionally taking the unit off sale meanwhile',
        body: z.object({
          propertyId: uuid,
          unitId: uuid.nullable().optional(),
          title: z.string().trim().min(1).max(200),
          description: z.string().max(4000).nullable().optional(),
          priority: z.enum(PRIORITIES).optional(),
          assignedTo: uuid.nullable().optional(),
          offSale: offSale.nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.body.propertyId, 'maintenance.write');
      return reply.status(201).send(await reportIssue(app.db, actor, req.body));
    },
  );

  r.patch(
    '/maintenance/:id',
    {
      schema: {
        tags: ['maintenance'],
        params: idParams,
        body: z.object({
          title: z.string().trim().min(1).max(200).optional(),
          description: z.string().max(4000).nullable().optional(),
          priority: z.enum(PRIORITIES).optional(),
          status: z.enum(MAINTENANCE_STATUSES).optional(),
          assignedTo: uuid.nullable().optional(),
          resolution: z.string().max(4000).nullable().optional(),
          offSale: offSale.nullable().optional(),
        }),
      },
    },
    async (req) => {
      const { actor } = await authorizeVia(
        req,
        'Maintenance issue',
        req.params.id,
        'maintenance.write',
        async (orgId) => {
          const [row] = await app.db
            .select({ propertyId: maintenanceIssues.propertyId })
            .from(maintenanceIssues)
            .innerJoin(properties, eq(properties.id, maintenanceIssues.propertyId))
            .where(and(eq(maintenanceIssues.id, req.params.id), eq(properties.orgId, orgId)));
          return row?.propertyId;
        },
      );
      return updateIssue(app.db, actor, req.params.id, req.body);
    },
  );

  // ---------------------------------------------------------------------------
  // Companies and travel agents

  r.get(
    '/companies',
    {
      schema: {
        tags: ['companies'],
        querystring: z.object({
          search: z.string().max(100).optional(),
          kind: z.enum(COMPANY_KINDS).optional(),
          includeInactive: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'reservations.read');
      return {
        companies: await listCompanies(app.db, actor.orgId, {
          search: req.query.search,
          kind: req.query.kind,
          includeInactive: req.query.includeInactive === 'true',
          // Money owed is shown only for the properties whose folios the caller may read.
          accounts: propertyScope(actor.grants, 'folio.read'),
        }),
      };
    },
  );

  r.post(
    '/companies',
    { schema: { tags: ['companies'], body: companyBody } },
    async (req, reply) => {
      const actor = authorize(req, 'accounting.manage');
      return reply.status(201).send(await createCompany(app.db, actor, req.body));
    },
  );

  r.patch(
    '/companies/:id',
    { schema: { tags: ['companies'], params: idParams, body: companyBody.partial() } },
    async (req) => {
      const actor = authorize(req, 'accounting.manage');
      return updateCompany(app.db, actor, req.params.id, req.body);
    },
  );

  r.get(
    '/companies/:id/statement',
    {
      schema: {
        tags: ['companies'],
        summary: 'What was billed to a company and what it has paid',
        params: idParams,
      },
    },
    async (req) => {
      const actor = authorize(req, 'folio.read');
      return companyStatement(
        app.db,
        actor.orgId,
        req.params.id,
        propertyScope(actor.grants, 'folio.read'),
      );
    },
  );
}
