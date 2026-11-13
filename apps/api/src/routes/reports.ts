import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { REPORT_FREQUENCIES, REPORT_KINDS, REPORT_PERIODS, reportSchedules } from '@pms/db';
import {
  PERFORMANCE_GROUPINGS,
  agentCommissionReport,
  canAcrossOrganisation,
  channelMixReport,
  createReportSchedule,
  deleteReportSchedule,
  forbidden,
  guestRegister,
  guestRegisterCsv,
  listReportSchedules,
  notFound,
  paceReport,
  performanceReport,
  propertyScope,
  reportCsv,
  revenueReport,
  sendReportNow,
  taxRegister,
  taxRegisterCsv,
  updateReportSchedule,
  type Actor,
  type ReportScheduleRow,
  type ReportWindow,
} from '@pms/domain';
import { perUser } from '../lib/limits';
import { dateString, idParams, propertyParams, uuid, uuidList } from '../lib/schemas';
import { authorizeProperty, scopedProperties } from '../lib/scope';
import { authorize } from '../plugins/auth';

const windowQuery = z.object({
  propertyIds: uuidList,
  from: dateString,
  to: dateString,
  format: z.enum(['json', 'csv']).optional(),
});

/** A spreadsheet file as the answer to a request. */
function sendCsv(reply: FastifyReply, file: { filename: string; csv: string }): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${file.filename}"`)
    .header('cache-control', 'private, no-store')
    .send(`\uFEFF${file.csv}`);
}

const REPORTS_A_MINUTE = 90;

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** The properties and dates a report request covers, limited to what the caller may see. */
  const windowOf = (
    req: FastifyRequest,
    query: { propertyIds?: string[]; from: string; to: string },
  ): { actor: Actor; window: ReportWindow } => {
    const { actor, propertyIds } = scopedProperties(req, 'reports.read', query.propertyIds);
    return { actor, window: { propertyIds, from: query.from, to: query.to } };
  };

  r.get(
    '/reports/performance',
    {
      // A report over a long period is real work for the database: enough for a person
      // changing filters, too few for a script to lean on.
      config: perUser(REPORTS_A_MINUTE),
      schema: {
        tags: ['reports'],
        summary: 'Occupancy, average rate and revenue per available room',
        querystring: windowQuery.extend({ groupBy: z.enum(PERFORMANCE_GROUPINGS).optional() }),
      },
    },
    async (req, reply) => {
      const { actor, window } = windowOf(req, req.query);
      const input = { ...window, groupBy: req.query.groupBy };
      if (req.query.format === 'csv') {
        return sendCsv(reply, await reportCsv(app.db, actor.orgId, 'performance', input));
      }
      return performanceReport(app.db, actor.orgId, input);
    },
  );

  r.get(
    '/reports/channel-mix',
    {
      // A report over a long period is real work for the database: enough for a person
      // changing filters, too few for a script to lean on.
      config: perUser(REPORTS_A_MINUTE),
      schema: {
        tags: ['reports'],
        summary: 'Room nights, revenue and commission by booking site and source',
        querystring: windowQuery,
      },
    },
    async (req, reply) => {
      const { actor, window } = windowOf(req, req.query);
      if (req.query.format === 'csv') {
        return sendCsv(reply, await reportCsv(app.db, actor.orgId, 'channel_mix', window));
      }
      return channelMixReport(app.db, actor.orgId, window);
    },
  );

  r.get(
    '/reports/pace',
    {
      // A report over a long period is real work for the database: enough for a person
      // changing filters, too few for a script to lean on.
      config: perUser(REPORTS_A_MINUTE),
      schema: {
        tags: ['reports'],
        summary: 'How future dates are filling, against last week, last month and last year',
        querystring: windowQuery.extend({ groupBy: z.enum(['day', 'month']).optional() }),
      },
    },
    async (req, reply) => {
      const { actor, window } = windowOf(req, req.query);
      const input = { ...window, groupBy: req.query.groupBy };
      if (req.query.format === 'csv') {
        return sendCsv(reply, await reportCsv(app.db, actor.orgId, 'pace', input));
      }
      return paceReport(app.db, actor.orgId, input);
    },
  );

  r.get(
    '/reports/revenue',
    {
      // A report over a long period is real work for the database: enough for a person
      // changing filters, too few for a script to lean on.
      config: perUser(REPORTS_A_MINUTE),
      schema: {
        tags: ['reports'],
        summary: 'Charges by kind, tax, and money received by method, for each hotel day',
        querystring: windowQuery,
      },
    },
    async (req, reply) => {
      const { actor, window } = windowOf(req, req.query);
      if (req.query.format === 'csv') {
        return sendCsv(reply, await reportCsv(app.db, actor.orgId, 'revenue', window));
      }
      return revenueReport(app.db, actor.orgId, window);
    },
  );

  r.get(
    '/reports/agent-commission',
    {
      // A report over a long period is real work for the database: enough for a person
      // changing filters, too few for a script to lean on.
      config: perUser(REPORTS_A_MINUTE),
      schema: {
        tags: ['reports'],
        summary: 'What each travel agent earned on stays in the period',
        querystring: windowQuery,
      },
    },
    async (req, reply) => {
      const { actor, window } = windowOf(req, req.query);
      if (req.query.format === 'csv') {
        return sendCsv(reply, await reportCsv(app.db, actor.orgId, 'agent_commission', window));
      }
      return agentCommissionReport(app.db, actor.orgId, window);
    },
  );

  // ---------------------------------------------------------------------------
  // Reports sent by email on a schedule

  /**
   * A schedule sends figures to people outside the system, so it may only
   * cover properties whose reports its author may read: "every property"
   * takes a role that is not tied to one.
   */
  // ---------------------------------------------------------------------------
  // Registers for the authorities

  r.get(
    '/reports/tax-register',
    {
      config: perUser(30),
      schema: {
        tags: ['reports'],
        summary:
          'Every invoice and credit note issued in a period by service code and tax rate, for the tax return',
        querystring: windowQuery,
      },
    },
    async (req, reply) => {
      // It names customers and what they were billed: for those who may see bills.
      const { actor, propertyIds } = scopedProperties(req, 'folio.read', req.query.propertyIds);
      const register = await taxRegister(app.db, actor.orgId, {
        propertyIds,
        from: req.query.from,
        to: req.query.to,
      });
      return req.query.format === 'csv' ? sendCsv(reply, taxRegisterCsv(register)) : register;
    },
  );

  r.get(
    '/properties/:propertyId/guest-register',
    {
      config: perUser(10),
      schema: {
        tags: ['reports'],
        summary:
          'Everyone who arrived in a period with their identity and travel details, for the police or the foreigners\u2019 registration portal (recorded in the audit log)',
        params: propertyParams,
        querystring: z.object({
          from: dateString,
          to: dateString,
          foreignOnly: z
            .enum(['true', 'false'])
            .optional()
            .describe('Only guests from another country'),
          format: z.enum(['json', 'csv']).optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = await authorizeProperty(app.db, req, req.params.propertyId, 'guests.pii');
      const register = await guestRegister(app.db, actor, {
        propertyId: req.params.propertyId,
        from: req.query.from,
        to: req.query.to,
        foreignOnly: req.query.foreignOnly === 'true',
      });
      return req.query.format === 'csv'
        ? sendCsv(reply, guestRegisterCsv(register))
        : reply.header('cache-control', 'private, no-store').send(register);
    },
  );

  const mayCover = (actor: Actor, propertyIds: string[] | null | undefined): void => {
    if (!propertyIds || propertyIds.length === 0) {
      if (!canAcrossOrganisation(actor.grants, 'reports.read')) {
        throw forbidden(
          'Choose the properties this report covers: your role is for particular properties',
        );
      }
      return;
    }
    const scope = propertyScope(actor.grants, 'reports.read');
    if (scope !== 'all' && propertyIds.some((id) => !scope.includes(id))) throw forbidden();
  };

  const ownSchedule = async (req: FastifyRequest, id: string) => {
    const actor = authorize(req, 'reports.read');
    const [schedule] = await app.db
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, actor.orgId)));
    if (!schedule) throw notFound('Report schedule', id);
    mayCover(actor, schedule.propertyIds);
    return { actor, schedule };
  };

  const scheduleBody = z.object({
    name: z.string().trim().min(1).max(120),
    report: z.enum(REPORT_KINDS),
    groupBy: z.string().max(20).nullable().optional(),
    propertyIds: z.array(uuid).max(200).nullable().optional(),
    period: z.enum(REPORT_PERIODS),
    frequency: z.enum(REPORT_FREQUENCIES),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    recipients: z.array(z.string().trim().max(254)).min(1).max(20),
    active: z.boolean().optional(),
  });

  r.get('/reports/schedules', { schema: { tags: ['reports'] } }, async (req) => {
    const actor = authorize(req, 'reports.read');
    const scope = propertyScope(actor.grants, 'reports.read');
    const visible = (schedule: ReportScheduleRow): boolean =>
      scope === 'all' ||
      (schedule.propertyIds !== null && schedule.propertyIds.every((id) => scope.includes(id)));
    return {
      schedules: (await listReportSchedules(app.db, actor.orgId)).filter(visible),
      mailConfigured: app.mailer.configured,
    };
  });

  r.post(
    '/reports/schedules',
    {
      schema: {
        tags: ['reports'],
        summary: 'Send a report by email every day, week or month',
        body: scheduleBody,
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'reports.read');
      mayCover(actor, req.body.propertyIds);
      return reply.status(201).send(await createReportSchedule(app.db, actor, req.body));
    },
  );

  r.patch(
    '/reports/schedules/:id',
    { schema: { tags: ['reports'], params: idParams, body: scheduleBody.partial() } },
    async (req) => {
      const { actor } = await ownSchedule(req, req.params.id);
      if (req.body.propertyIds !== undefined) mayCover(actor, req.body.propertyIds);
      return updateReportSchedule(app.db, actor, req.params.id, req.body);
    },
  );

  r.delete(
    '/reports/schedules/:id',
    { schema: { tags: ['reports'], params: idParams } },
    async (req, reply) => {
      const { actor } = await ownSchedule(req, req.params.id);
      await deleteReportSchedule(app.db, actor, req.params.id);
      return reply.status(204).send();
    },
  );

  r.post(
    '/reports/schedules/:id/send',
    {
      config: perUser(10),
      schema: {
        tags: ['reports'],
        summary: 'Send the report now, without changing when it is next due',
        params: idParams,
      },
    },
    async (req) => {
      const { schedule } = await ownSchedule(req, req.params.id);
      return sendReportNow(app.db, app.mailer, schedule);
    },
  );
}
