import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  OWNER_CONTRACT_MODELS,
  OWNER_EXPENSE_CATEGORIES,
  OWNER_FEE_BASES,
  OWNER_STATEMENT_STATUSES,
  ownerContracts,
  ownerExpenses,
  ownerStatements,
} from '@pms/db';
import {
  addDays,
  addOwnerExpense,
  cancelOwnerStay,
  createContract,
  createOwner,
  createUser,
  deleteOwnerStatement,
  displayMoney,
  draftOwnerStatement,
  getOwner,
  getOwnerStatement,
  invalidState,
  issueOwnerStatement,
  listOwnerExpenses,
  listOwners,
  listOwnerStatements,
  markOwnerStatementPaid,
  notFound,
  ownerCalendar,
  ownerOverview,
  ownerStatementCsv,
  ownerStatementFor,
  ownerStatementsFor,
  propertyScope,
  removeOwnerExpense,
  requestOwnerStay,
  updateContract,
  updateOwner,
  updateOwnerStatement,
  validationError,
  type Actor,
  type StatementView,
} from '@pms/domain';
import { perUser } from '../lib/limits';
import { dateString, idParams, money, uuid } from '../lib/schemas';
import { authorize } from '../plugins/auth';

function sendCsv(reply: FastifyReply, statement: StatementView): FastifyReply {
  const name = `owner-statement-${statement.periodStart.slice(0, 7)}.csv`;
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('cache-control', 'private, no-store')
    .send(`\uFEFF${ownerStatementCsv(statement)}`);
}

export async function ownerRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------------
  // For the accounts team: owners, their contracts, costs and statements

  const ownerBody = z.object({
    name: z.string().trim().min(1).max(200),
    legalName: z.string().max(200).nullable().optional(),
    email: z.string().max(254).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    addressLine1: z.string().max(200).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    state: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    country: z.string().max(60).optional(),
    gstin: z.string().max(20).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    active: z.boolean().optional(),
    userId: uuid.nullable().optional(),
  });

  /** Authorises work on a contract by the property it is for. */
  const forContract = async (req: FastifyRequest, contractId: string): Promise<Actor> => {
    const session = authorize(req);
    const [row] = await app.db
      .select({ propertyId: ownerContracts.propertyId })
      .from(ownerContracts)
      .where(and(eq(ownerContracts.id, contractId), eq(ownerContracts.orgId, session.orgId)));
    if (!row) throw notFound('Contract', contractId);
    return authorize(req, 'accounting.manage', row.propertyId);
  };

  const forStatement = async (req: FastifyRequest, statementId: string): Promise<Actor> => {
    const session = authorize(req);
    const [row] = await app.db
      .select({ propertyId: ownerStatements.propertyId })
      .from(ownerStatements)
      .where(and(eq(ownerStatements.id, statementId), eq(ownerStatements.orgId, session.orgId)));
    if (!row) throw notFound('Statement', statementId);
    return authorize(req, 'accounting.manage', row.propertyId);
  };

  r.get('/owners', { schema: { tags: ['owners'] } }, async (req) => {
    const actor = authorize(req, 'accounting.manage');
    const scope = propertyScope(actor.grants, 'accounting.manage');
    const owners = await listOwners(app.db, actor.orgId);
    if (scope === 'all') return { owners };
    // Someone who keeps the accounts of particular properties sees the owners of those.
    return {
      owners: owners
        .map((o) => ({ ...o, contracts: o.contracts.filter((c) => scope.includes(c.propertyId)) }))
        .filter((o) => o.contracts.length > 0),
    };
  });

  r.post('/owners', { schema: { tags: ['owners'], body: ownerBody } }, async (req, reply) => {
    const actor = authorize(req, 'accounting.manage');
    return reply.status(201).send(await createOwner(app.db, actor, req.body));
  });

  r.get('/owners/:id', { schema: { tags: ['owners'], params: idParams } }, async (req) => {
    const actor = authorize(req, 'accounting.manage');
    const scope = propertyScope(actor.grants, 'accounting.manage');
    const owner = await getOwner(app.db, actor.orgId, req.params.id);
    if (scope === 'all') return owner;
    const contracts = owner.contracts.filter((c) => scope.includes(c.propertyId));
    if (contracts.length === 0 && owner.contracts.length > 0) {
      throw notFound('Owner', req.params.id);
    }
    return { ...owner, contracts };
  });

  r.patch(
    '/owners/:id',
    { schema: { tags: ['owners'], params: idParams, body: ownerBody.partial() } },
    async (req) => {
      const actor = authorize(req, 'accounting.manage');
      return updateOwner(app.db, actor, req.params.id, req.body);
    },
  );

  r.post(
    '/owners/:id/portal-access',
    {
      schema: {
        tags: ['owners'],
        summary: 'Invite the owner to the owner portal, with access to their own properties only',
        params: idParams,
      },
    },
    async (req, reply) => {
      // Creating a sign-in is for those who manage users.
      const actor = authorize(req, 'org.manage');
      const owner = await getOwner(app.db, actor.orgId, req.params.id);
      if (owner.user)
        throw invalidState(`${owner.name} already has a sign-in: ${owner.user.email}`);
      if (!owner.email) throw validationError('Add the owner\u2019s email address first');
      const propertyIds = [...new Set(owner.contracts.map((c) => c.propertyId))];
      if (propertyIds.length === 0) {
        throw validationError('Add a contract first, so the portal has something to show');
      }
      const created = await createUser(app.db, actor, {
        email: owner.email,
        name: owner.name,
        grants: propertyIds.map((propertyId) => ({ role: 'villa_owner' as const, propertyId })),
      });
      await updateOwner(app.db, actor, owner.id, { userId: created.id });
      const inviteLink = created.inviteToken
        ? `${app.env.WEB_URL}/reset-password?token=${encodeURIComponent(created.inviteToken)}&invite=1`
        : undefined;
      let inviteEmailed = false;
      if (inviteLink) {
        const result = await app.mailer.send({
          to: created.email,
          subject: 'Your owner portal',
          text: `Hello ${created.name},\n\nYou can now see the bookings and monthly statements for your property online. Use this link to choose your password. It works once and expires in three days.\n\n${inviteLink}`,
        });
        inviteEmailed = result.delivered;
      }
      // The link is returned so it can be handed over when no mail server is configured.
      return reply.status(201).send({ userId: created.id, inviteLink, inviteEmailed });
    },
  );

  const contractBody = z.object({
    ownerId: uuid,
    propertyId: uuid,
    unitId: uuid.nullable().optional(),
    startsOn: dateString,
    endsOn: dateString.nullable().optional(),
    model: z.enum(OWNER_CONTRACT_MODELS).optional(),
    managementFeeBp: z.number().int().min(0).max(10_000).optional(),
    feeBasis: z.enum(OWNER_FEE_BASES).optional(),
    feeTaxBp: z.number().int().min(0).max(10_000).optional(),
    commissionOnOwner: z.boolean().optional(),
    fixedRent: money.nullable().optional(),
    ownerNightsPerYear: z.number().int().min(0).max(366).nullable().optional(),
    ownerStayNoticeDays: z.number().int().min(0).max(365).optional(),
    notes: z.string().max(2000).nullable().optional(),
  });

  r.post(
    '/owner-contracts',
    { schema: { tags: ['owners'], body: contractBody } },
    async (req, reply) => {
      const actor = authorize(req, 'accounting.manage', req.body.propertyId);
      return reply.status(201).send(await createContract(app.db, actor, req.body));
    },
  );

  r.patch(
    '/owner-contracts/:id',
    {
      schema: {
        tags: ['owners'],
        params: idParams,
        body: contractBody.omit({ ownerId: true, propertyId: true, unitId: true }).partial(),
      },
    },
    async (req) => {
      const actor = await forContract(req, req.params.id);
      return updateContract(app.db, actor, req.params.id, req.body);
    },
  );

  r.get(
    '/owner-contracts/:id/expenses',
    {
      schema: {
        tags: ['owners'],
        params: idParams,
        querystring: z.object({ from: dateString.optional(), to: dateString.optional() }),
      },
    },
    async (req) => {
      const actor = await forContract(req, req.params.id);
      return {
        expenses: await listOwnerExpenses(app.db, actor.orgId, {
          contractId: req.params.id,
          ...req.query,
        }),
      };
    },
  );

  r.post(
    '/owner-contracts/:id/expenses',
    {
      schema: {
        tags: ['owners'],
        summary: 'Record a cost the owner bears. It is taken off the statement of its month.',
        params: idParams,
        body: z.object({
          date: dateString,
          category: z.enum(OWNER_EXPENSE_CATEGORIES).optional(),
          description: z.string().trim().min(1).max(300),
          amount: money.min(1),
          maintenanceIssueId: uuid.nullable().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await forContract(req, req.params.id);
      return reply
        .status(201)
        .send(await addOwnerExpense(app.db, actor, { ...req.body, contractId: req.params.id }));
    },
  );

  r.delete(
    '/owner-expenses/:id',
    { schema: { tags: ['owners'], params: idParams } },
    async (req, reply) => {
      const session = authorize(req);
      const [row] = await app.db
        .select({ contractId: ownerExpenses.contractId })
        .from(ownerExpenses)
        .where(and(eq(ownerExpenses.id, req.params.id), eq(ownerExpenses.orgId, session.orgId)));
      if (!row) throw notFound('Expense', req.params.id);
      const actor = await forContract(req, row.contractId);
      await removeOwnerExpense(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  r.post(
    '/owner-contracts/:id/statements',
    {
      schema: {
        tags: ['owners'],
        summary: 'Work out the statement for a month as a draft, or work a draft out again',
        params: idParams,
        body: z.object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM'),
        }),
      },
    },
    async (req) => {
      const actor = await forContract(req, req.params.id);
      const draft = await draftOwnerStatement(app.db, actor, req.params.id, req.body.month);
      return getOwnerStatement(app.db, actor.orgId, draft.id);
    },
  );

  r.get(
    '/owner-statements',
    {
      schema: {
        tags: ['owners'],
        querystring: z.object({
          ownerId: uuid.optional(),
          contractId: uuid.optional(),
          status: z.enum(OWNER_STATEMENT_STATUSES).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'accounting.manage');
      const scope = propertyScope(actor.grants, 'accounting.manage');
      const statements = await listOwnerStatements(app.db, actor.orgId, req.query);
      return {
        statements:
          scope === 'all' ? statements : statements.filter((s) => scope.includes(s.propertyId)),
      };
    },
  );

  r.get(
    '/owner-statements/:id',
    {
      schema: {
        tags: ['owners'],
        params: idParams,
        querystring: z.object({ format: z.enum(['json', 'csv']).optional() }),
      },
    },
    async (req, reply) => {
      const actor = await forStatement(req, req.params.id);
      const statement = await getOwnerStatement(app.db, actor.orgId, req.params.id);
      return req.query.format === 'csv' ? sendCsv(reply, statement) : statement;
    },
  );

  r.patch(
    '/owner-statements/:id',
    {
      schema: {
        tags: ['owners'],
        summary: 'Set the adjustments and the note on a draft',
        params: idParams,
        body: z.object({
          adjustments: z
            .array(
              z.object({
                description: z.string().trim().min(1).max(200),
                amount: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
              }),
            )
            .max(50)
            .optional(),
          notes: z.string().max(2000).nullable().optional(),
        }),
      },
    },
    async (req) => {
      const actor = await forStatement(req, req.params.id);
      await updateOwnerStatement(app.db, actor, req.params.id, req.body);
      return getOwnerStatement(app.db, actor.orgId, req.params.id);
    },
  );

  r.delete(
    '/owner-statements/:id',
    {
      schema: { tags: ['owners'], summary: 'Discard a draft', params: idParams },
    },
    async (req, reply) => {
      const actor = await forStatement(req, req.params.id);
      await deleteOwnerStatement(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  r.post(
    '/owner-statements/:id/issue',
    {
      schema: {
        tags: ['owners'],
        summary:
          'Issue a draft: it gets its number, the owner can see it, and it no longer changes',
        params: idParams,
      },
    },
    async (req) => {
      const actor = await forStatement(req, req.params.id);
      await issueOwnerStatement(app.db, actor, req.params.id);
      const statement = await getOwnerStatement(app.db, actor.orgId, req.params.id);
      const owner = await getOwner(app.db, actor.orgId, statement.ownerId);
      let ownerEmailed = false;
      if (owner.email) {
        const span = `${statement.periodStart} to ${addDays(statement.periodEnd, -1)}`;
        const result = await app.mailer
          .send({
            to: owner.email,
            subject: `Your statement for ${statement.propertyName}, ${span}`,
            text: [
              `Hello ${owner.name},`,
              '',
              `Your statement ${statement.number} for ${statement.propertyName} (${span}) is ready.`,
              `Payable to you: ${displayMoney(statement.payout, statement.currency)}.`,
              '',
              owner.user
                ? `See it in full in the owner portal: ${app.env.WEB_URL}/owner/statements/${statement.id}`
                : 'The statement is attached.',
            ].join('\n'),
            attachments: [
              {
                filename: `owner-statement-${statement.periodStart.slice(0, 7)}.csv`,
                content: ownerStatementCsv(statement),
                contentType: 'text/csv; charset=utf-8',
              },
            ],
          })
          .catch(() => ({ delivered: false }));
        ownerEmailed = result.delivered;
      }
      return { ...statement, ownerEmailed };
    },
  );

  r.post(
    '/owner-statements/:id/paid',
    {
      schema: {
        tags: ['owners'],
        summary: 'Record that the owner has been paid',
        params: idParams,
        body: z.object({ reference: z.string().max(120).nullable().optional() }),
      },
    },
    async (req) => {
      const actor = await forStatement(req, req.params.id);
      await markOwnerStatementPaid(app.db, actor, req.params.id, req.body);
      return getOwnerStatement(app.db, actor.orgId, req.params.id);
    },
  );

  // ---------------------------------------------------------------------------
  // The owner portal: an owner's own units, stays and statements

  r.get(
    '/owner/overview',
    { schema: { tags: ['owner portal'], summary: 'The owner\u2019s units and latest statements' } },
    async (req) => ownerOverview(app.db, authorize(req, 'owner.portal')),
  );

  r.get(
    '/owner/calendar',
    {
      schema: {
        tags: ['owner portal'],
        summary: 'Guest stays and closed dates on the owner\u2019s units. Guests are not named.',
        querystring: z.object({ from: dateString, to: dateString }),
      },
    },
    async (req) => ownerCalendar(app.db, authorize(req, 'owner.portal'), req.query),
  );

  r.post(
    '/owner/stays',
    {
      config: perUser(20),
      schema: {
        tags: ['owner portal'],
        summary: 'Take free dates for the owner\u2019s own use',
        body: z.object({
          contractId: uuid,
          unitId: uuid.nullable().optional(),
          from: dateString,
          to: dateString,
        }),
      },
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(await requestOwnerStay(app.db, authorize(req, 'owner.portal'), req.body)),
  );

  r.delete(
    '/owner/stays/:id',
    { schema: { tags: ['owner portal'], params: idParams } },
    async (req, reply) => {
      await cancelOwnerStay(app.db, authorize(req, 'owner.portal'), req.params.id);
      return reply.status(204).send();
    },
  );

  r.get('/owner/statements', { schema: { tags: ['owner portal'] } }, async (req) => ({
    statements: await ownerStatementsFor(app.db, authorize(req, 'owner.portal')),
  }));

  r.get(
    '/owner/statements/:id',
    {
      schema: {
        tags: ['owner portal'],
        params: idParams,
        querystring: z.object({ format: z.enum(['json', 'csv']).optional() }),
      },
    },
    async (req, reply) => {
      const statement = await ownerStatementFor(
        app.db,
        authorize(req, 'owner.portal'),
        req.params.id,
      );
      return req.query.format === 'csv' ? sendCsv(reply, statement) : statement;
    },
  );
}
