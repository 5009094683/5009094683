import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can, getOrganization, updateOrganization } from '@pms/domain';
import { authorize } from '../plugins/auth';

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/org', { schema: { tags: ['organisation'] } }, async (req) => {
    const actor = authorize(req);
    const org = await getOrganization(app.db, actor.orgId);
    if (can(actor.grants, 'org.manage')) return org;
    // Who is told about alerts and how long guest data is kept are for administrators.
    return { ...org, settings: { requireTwoFactor: org.settings.requireTwoFactor } };
  });

  r.patch(
    '/org',
    {
      schema: {
        tags: ['organisation'],
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          defaultCurrency: z.string().length(3).optional(),
          defaultTimezone: z.string().max(64).optional(),
          settings: z
            .object({
              requireTwoFactor: z.boolean().optional(),
              guestIdRetentionDays: z.number().int().optional(),
              guestProfileRetentionDays: z.number().int().optional(),
              alertEmails: z.array(z.email()).max(20).optional(),
            })
            .optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      return updateOrganization(app.db, actor, req.body);
    },
  );
}
