import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLES } from '@pms/db';
import { deleteOidcProvider, listOidcProviders, saveOidcProvider } from '@pms/domain';
import { authorize } from '../plugins/auth';

const providerBody = z.object({
  slug: z.string().min(2).max(41),
  name: z.string().min(1).max(80),
  issuer: z.string().min(1).max(300),
  clientId: z.string().min(1).max(300),
  clientSecret: z.string().max(500).nullable().optional(),
  scopes: z.string().max(300).optional(),
  allowedEmailDomains: z.array(z.string().max(120)).max(50),
  autoProvision: z.boolean().optional(),
  defaultRole: z.enum(ROLES).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/sso/providers', { schema: { tags: ['sso'] } }, async (req) => {
    const actor = authorize(req, 'org.manage');
    return { providers: await listOidcProviders(app.db, actor.orgId) };
  });

  r.post(
    '/sso/providers',
    { schema: { tags: ['sso'], body: providerBody } },
    async (req, reply) => {
      const actor = authorize(req, 'org.manage');
      return reply.status(201).send(await saveOidcProvider(app.db, actor, req.body));
    },
  );

  r.put(
    '/sso/providers/:id',
    { schema: { tags: ['sso'], params: z.object({ id: z.uuid() }), body: providerBody } },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      return saveOidcProvider(app.db, actor, req.body, req.params.id);
    },
  );

  r.delete(
    '/sso/providers/:id',
    { schema: { tags: ['sso'], params: z.object({ id: z.uuid() }) } },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      await deleteOidcProvider(app.db, actor, req.params.id);
      return { status: 'ok' };
    },
  );
}
