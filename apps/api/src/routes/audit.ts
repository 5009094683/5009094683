import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listAuditLog } from '@pms/domain';
import { authorize } from '../plugins/auth';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/audit',
    {
      schema: {
        tags: ['audit'],
        summary: 'Who changed what, newest first',
        querystring: z.object({
          entityType: z.string().max(60).optional(),
          entityId: z.string().max(60).optional(),
          actorUserId: z.uuid().optional(),
          propertyId: z.uuid().optional(),
          actionPrefix: z.string().max(60).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          beforeId: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'audit.read');
      const { from, to, ...rest } = req.query;
      return listAuditLog(app.db, actor.orgId, {
        ...rest,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      });
    },
  );
}
