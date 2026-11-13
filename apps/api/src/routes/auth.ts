import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DomainError,
  ROLE_LABELS,
  beginTwoFactorEnrollment,
  changePassword,
  completeTwoFactor,
  confirmTwoFactorEnrollment,
  decryptJson,
  disableTwoFactor,
  effectivePermissions,
  encryptJson,
  finishOidcLogin,
  isSetupComplete,
  listPublicOidcProviders,
  loginWithPassword,
  redeemUserToken,
  requestPasswordReset,
  revokeSession,
  setupOrganization,
  startOidcLogin,
  validationError,
  verifyPassword,
  type OidcFlowState,
  type SessionContext,
} from '@pms/domain';
import { eq } from 'drizzle-orm';
import { organizations, users } from '@pms/db';
import {
  actorFromSession,
  anySession,
  clearSessionCookie,
  clientInfo,
  fullSession,
  setSessionCookie,
} from '../plugins/auth';

const OIDC_COOKIE = 'pms_oidc';

const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

function safeReturnTo(value: string | undefined): string | undefined {
  // Only same-site paths: an absolute or protocol-relative URL would be an open redirect.
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return undefined;
  return value;
}

async function sessionView(app: FastifyInstance, session: SessionContext) {
  const [org] = await app.db
    .select({ id: organizations.id, name: organizations.name, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, session.user.orgId));
  return {
    user: session.user,
    organization: org ? { id: org.id, name: org.name } : null,
    grants: session.grants.map((g) => ({ ...g, roleLabel: ROLE_LABELS[g.role] })),
    permissions:
      session.mfaPending || session.mustEnrollTwoFactor ? [] : effectivePermissions(session.grants),
    authMethod: session.authMethod,
    mfaPending: session.mfaPending,
    mustEnrollTwoFactor: session.mustEnrollTwoFactor,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/setup/status', { schema: { tags: ['setup'] } }, async () => ({
    setupComplete: await isSetupComplete(app.db),
  }));

  r.post(
    '/setup',
    {
      ...loginLimit,
      schema: {
        tags: ['setup'],
        summary: 'Create the organisation and its first admin (once)',
        body: z.object({
          orgName: z.string().min(1).max(120),
          adminName: z.string().min(1).max(120),
          adminEmail: z.email(),
          adminPassword: z.string().min(1).max(200),
        }),
      },
    },
    async (req, reply) => {
      await setupOrganization(app.db, req.body);
      const login = await loginWithPassword(app.db, {
        email: req.body.adminEmail,
        password: req.body.adminPassword,
        ...clientInfo(req),
      });
      setSessionCookie(app, reply, login.token, login.expiresAt);
      return reply.status(201).send({ status: 'ok' });
    },
  );

  r.post(
    '/auth/login',
    {
      ...loginLimit,
      schema: {
        tags: ['auth'],
        body: z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(200) }),
      },
    },
    async (req, reply) => {
      const result = await loginWithPassword(app.db, { ...req.body, ...clientInfo(req) });
      setSessionCookie(app, reply, result.token, result.expiresAt);
      return { status: result.status };
    },
  );

  r.post(
    '/auth/2fa/verify',
    {
      ...loginLimit,
      schema: { tags: ['auth'], body: z.object({ code: z.string().min(6).max(20) }) },
    },
    async (req) => {
      if (!req.sessionToken) throw new DomainError('unauthenticated', 'Sign in again to continue');
      await completeTwoFactor(app.db, req.sessionToken, req.body.code, clientInfo(req));
      return { status: 'ok' };
    },
  );

  r.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.sessionToken) await revokeSession(app.db, req.sessionToken);
    clearSessionCookie(reply);
    return { status: 'ok' };
  });

  r.get(
    '/auth/me',
    { schema: { tags: ['auth'], summary: 'The signed-in user, roles and permissions' } },
    async (req) => sessionView(app, anySession(req)),
  );

  r.post(
    '/auth/password',
    {
      schema: {
        tags: ['auth'],
        body: z.object({
          currentPassword: z.string().max(200),
          newPassword: z.string().min(1).max(200),
        }),
      },
    },
    async (req) => {
      const session = anySession(req);
      if (session.mfaPending)
        throw new DomainError('unauthenticated', 'Enter your authenticator code to continue');
      await changePassword(
        app.db,
        session,
        req.body.currentPassword,
        req.body.newPassword,
        clientInfo(req),
      );
      return { status: 'ok' };
    },
  );

  r.post('/auth/2fa/enroll', { schema: { tags: ['auth'] } }, async (req) => {
    const session = anySession(req);
    if (session.mfaPending)
      throw new DomainError('unauthenticated', 'Enter your authenticator code to continue');
    return beginTwoFactorEnrollment(app.db, session.user.id);
  });

  r.post(
    '/auth/2fa/confirm',
    { schema: { tags: ['auth'], body: z.object({ code: z.string().min(6).max(10) }) } },
    async (req) => {
      const session = anySession(req);
      if (session.mfaPending)
        throw new DomainError('unauthenticated', 'Enter your authenticator code to continue');
      return confirmTwoFactorEnrollment(app.db, session.user.id, req.body.code, clientInfo(req));
    },
  );

  r.post(
    '/auth/2fa/disable',
    { schema: { tags: ['auth'], body: z.object({ password: z.string().min(1).max(200) }) } },
    async (req) => {
      const session = fullSession(req);
      const [user] = await app.db.select().from(users).where(eq(users.id, session.user.id));
      // Removing a second factor is sensitive: require the password again.
      if (!user?.passwordHash || !(await verifyPassword(req.body.password, user.passwordHash))) {
        throw validationError('Your password is not correct');
      }
      await disableTwoFactor(app.db, actorFromSession(req, session), session.user.id);
      return { status: 'ok' };
    },
  );

  r.post(
    '/auth/password-reset/request',
    {
      ...loginLimit,
      schema: { tags: ['auth'], body: z.object({ email: z.string().min(1).max(254) }) },
    },
    async (req) => {
      const reset = await requestPasswordReset(app.db, req.body.email);
      if (reset) {
        const link = `${app.env.WEB_URL}/reset-password?token=${encodeURIComponent(reset.token)}`;
        await app.mailer.send({
          to: reset.email,
          subject: 'Reset your password',
          text: `Hello ${reset.name},\n\nUse this link to choose a new password. It works once and expires in two hours.\n\n${link}\n\nIf you did not ask for this, you can ignore this message.`,
        });
      }
      // Same answer whether or not the account exists.
      return { status: 'ok' };
    },
  );

  r.post(
    '/auth/password-reset/redeem',
    {
      ...loginLimit,
      schema: {
        tags: ['auth'],
        summary: 'Set a password from an invitation or reset link',
        body: z.object({
          token: z.string().min(10).max(200),
          password: z.string().min(1).max(200),
        }),
      },
    },
    async (req) => {
      await redeemUserToken(app.db, req.body.token, req.body.password, clientInfo(req));
      return { status: 'ok' };
    },
  );

  r.get(
    '/auth/providers',
    { schema: { tags: ['auth'], summary: 'Single sign-on buttons for the sign-in page' } },
    async () => ({
      providers: await listPublicOidcProviders(app.db),
    }),
  );

  r.get(
    '/auth/oidc/:slug/start',
    {
      schema: {
        tags: ['auth'],
        params: z.object({ slug: z.string() }),
        querystring: z.object({ returnTo: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const { url, flow } = await startOidcLogin(
        app.db,
        req.params.slug,
        safeReturnTo(req.query.returnTo),
      );
      void reply.setCookie(OIDC_COOKIE, encryptJson(flow), {
        httpOnly: true,
        sameSite: 'lax',
        secure: app.env.isProduction,
        path: '/',
        maxAge: 600,
      });
      return reply.redirect(url);
    },
  );

  r.get(
    '/auth/oidc/:slug/callback',
    { schema: { tags: ['auth'], params: z.object({ slug: z.string() }) } },
    async (req, reply) => {
      const fail = (message: string): FastifyReply => {
        void reply.clearCookie(OIDC_COOKIE, { path: '/' });
        return reply.redirect(`${app.env.WEB_URL}/login?error=${encodeURIComponent(message)}`);
      };
      const stored = req.cookies[OIDC_COOKIE];
      if (!stored) return fail('The sign-in attempt expired. Start again.');
      let flow: OidcFlowState;
      try {
        flow = decryptJson<OidcFlowState>(stored);
      } catch {
        return fail('The sign-in attempt expired. Start again.');
      }
      try {
        // Rebuild the URL the provider redirected to. The query string carries
        // the code and state; the origin and path must equal the registered redirect URI.
        const callbackUrl = new URL(flow.redirectUri);
        callbackUrl.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const result = await finishOidcLogin(app.db, flow, callbackUrl, clientInfo(req));
        void reply.clearCookie(OIDC_COOKIE, { path: '/' });
        setSessionCookie(app, reply, result.token, result.expiresAt);
        return reply.redirect(`${app.env.WEB_URL}${safeReturnTo(result.returnTo) ?? '/'}`);
      } catch (err) {
        if (err instanceof DomainError) return fail(err.message);
        throw err;
      }
    },
  );
}
