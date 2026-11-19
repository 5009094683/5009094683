import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ROLES, users } from '@pms/db';
import {
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  createUser,
  disableTwoFactor,
  listUsers,
  notFound,
  requestPasswordReset,
  updateUser,
} from '@pms/domain';
import { authorize } from '../plugins/auth';

const grantSchema = z.object({
  role: z.enum(ROLES),
  propertyId: z.uuid().nullable(),
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/roles',
    { schema: { tags: ['users'], summary: 'Roles and the permissions each one carries' } },
    async (req) => {
      authorize(req);
      return {
        roles: ROLES.map((role) => ({
          role,
          label: ROLE_LABELS[role],
          permissions: ROLE_PERMISSIONS[role],
        })),
      };
    },
  );

  r.get('/users', { schema: { tags: ['users'] } }, async (req) => {
    const actor = authorize(req, 'org.manage');
    return { users: await listUsers(app.db, actor.orgId) };
  });

  r.post(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Create a user, or invite one when no password is given',
        body: z.object({
          email: z.email(),
          name: z.string().min(1).max(120),
          password: z.string().min(1).max(200).optional(),
          grants: z.array(grantSchema).max(100),
        }),
      },
    },
    async (req, reply) => {
      const actor = authorize(req, 'org.manage');
      const created = await createUser(app.db, actor, req.body);
      let inviteLink: string | undefined;
      let inviteEmailed = false;
      if (created.inviteToken) {
        inviteLink = `${app.env.WEB_URL}/reset-password?token=${encodeURIComponent(created.inviteToken)}&invite=1`;
        const result = await app.mailer.send({
          to: created.email,
          subject: 'You have been invited',
          text: `Hello ${created.name},\n\nAn account has been created for you. Use this link to choose your password. It works once and expires in three days.\n\n${inviteLink}`,
        });
        inviteEmailed = result.delivered;
      }
      return reply.status(201).send({
        id: created.id,
        email: created.email,
        name: created.name,
        status: created.status,
        // Returned so an admin can hand the link over when no mail server is configured.
        inviteLink,
        inviteEmailed,
      });
    },
  );

  r.patch(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          status: z.enum(['active', 'disabled']).optional(),
          grants: z.array(grantSchema).max(100).optional(),
        }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      await updateUser(app.db, actor, req.params.id, req.body);
      return { status: 'ok' };
    },
  );

  r.post(
    '/users/:id/reset-link',
    {
      schema: {
        tags: ['users'],
        summary: 'Issue a password-reset (or new invitation) link for a user',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      const [user] = await app.db.select().from(users).where(eq(users.id, req.params.id));
      if (!user || user.orgId !== actor.orgId) throw notFound('User', req.params.id);
      const reset = await requestPasswordReset(app.db, user.email, actor.userId);
      if (!reset) throw notFound('User', req.params.id);
      // Someone who has not yet accepted their invitation is still being invited, not reset.
      const invited = user.status === 'invited';
      const link = `${app.env.WEB_URL}/reset-password?token=${encodeURIComponent(reset.token)}${invited ? '&invite=1' : ''}`;
      const result = await app.mailer.send({
        to: reset.email,
        subject: invited ? 'You have been invited' : 'Choose a new password',
        text: invited
          ? `Hello ${reset.name},\n\nAn account has been created for you. Use this link to choose your password. It works once and expires in three days.\n\n${link}`
          : `Hello ${reset.name},\n\nAn administrator created a link for you to choose a new password. It works once.\n\n${link}`,
      });
      return { link, emailed: result.delivered };
    },
  );

  r.post(
    '/users/:id/2fa/disable',
    { schema: { tags: ['users'], params: z.object({ id: z.uuid() }) } },
    async (req) => {
      const actor = authorize(req, 'org.manage');
      await disableTwoFactor(app.db, actor, req.params.id);
      return { status: 'ok' };
    },
  );
}
