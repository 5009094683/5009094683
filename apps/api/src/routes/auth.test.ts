import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations } from '@pms/db';
import { saveOidcProvider, totpCode } from '@pms/domain';
import {
  TEST_PASSWORD,
  createTestUser,
  startMockOidcProvider,
  type MockOidcProvider,
} from '@pms/domain/testing';
import { createTestApp, type TestApp } from '../testing';

let ctx: TestApp;
let idp: MockOidcProvider;

beforeAll(async () => {
  ctx = await createTestApp();
  idp = await startMockOidcProvider();
  await saveOidcProvider(ctx.t.db, ctx.org.admin, {
    slug: 'workspace',
    name: 'Company Workspace',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    allowedEmailDomains: ['seabreeze.example'],
  });
});
afterAll(async () => {
  await idp.close();
  await ctx.close();
});

describe('API basics', () => {
  it('answers health and readiness probes', async () => {
    const anon = ctx.anonymous();
    expect((await anon.get('/health')).json()).toEqual({ status: 'ok' });
    expect((await anon.get('/ready')).json()).toEqual({ status: 'ok' });
  });

  it('returns errors in one shape, with the request id', async () => {
    const anon = ctx.anonymous();
    const missing = await anon.request({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': 'trace-42' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: 'not_found', requestId: 'trace-42' });

    const invalid = await anon.post('/auth/login', { email: 'a@b.co' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('validation');
    expect(invalid.json().error.details.issues[0].path).toBe('password');
  });

  it('publishes an OpenAPI document', async () => {
    const res = await ctx.anonymous().get('/docs/json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(
      doc.paths['/auth/login'].post.requestBody.content['application/json'].schema.required,
    ).toContain('email');
  });

  it('reports setup as complete and refuses to run it again', async () => {
    const anon = ctx.anonymous();
    expect((await anon.get('/setup/status')).json()).toEqual({ setupComplete: true });
    const res = await anon.post('/setup', {
      orgName: 'Other',
      adminName: 'Other',
      adminEmail: 'other@example.com',
      adminPassword: 'a long enough password',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('session handling', () => {
  it('requires a session', async () => {
    const res = await ctx.anonymous().get('/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('signs in with a cookie that scripts cannot read', async () => {
    const anon = ctx.anonymous();
    const res = await anon.post('/auth/login', {
      email: ctx.org.admin.label,
      password: TEST_PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    const cookie = res.cookies.find((c) => c.name === 'pms_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');

    const me = (await anon.get('/auth/me')).json();
    expect(me.user.email).toBe(ctx.org.admin.label);
    expect(me.permissions).toContain('org.manage');
    expect(me.grants[0]).toMatchObject({
      role: 'org_admin',
      propertyId: null,
      roleLabel: 'Organisation admin',
    });
  });

  it('rejects wrong credentials without saying which part was wrong', async () => {
    const res = await ctx
      .anonymous()
      .post('/auth/login', { email: ctx.org.admin.label, password: 'not the password' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid email or password');
    expect(res.cookies.find((c) => c.name === 'pms_session')).toBeUndefined();
  });

  it('signs out', async () => {
    const admin = await ctx.admin();
    expect((await admin.get('/auth/me')).statusCode).toBe(200);
    await admin.post('/auth/logout');
    // Replaying the old cookie no longer works.
    expect((await admin.get('/auth/me')).statusCode).toBe(401);
  });

  it('refuses writes sent from another site', async () => {
    const admin = await ctx.admin();
    const foreign = await admin.request({
      method: 'PATCH',
      url: '/org',
      payload: { name: 'Hijacked' },
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);

    const own = await admin.request({
      method: 'PATCH',
      url: '/org',
      payload: { name: 'Renamed Hotels' },
      headers: { origin: new URL(ctx.env.WEB_URL).origin },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().name).toBe('Renamed Hotels');
  });
});

describe('two-factor over the API', () => {
  it('holds a session at the second step until the code is given', async () => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, { role: 'org_admin' });
    const first = await ctx.login(user.email);
    const { secret } = (await first.post('/auth/2fa/enroll')).json();
    const confirm = await first.post('/auth/2fa/confirm', {
      code: totpCode(secret, new Date(Date.now() - 30_000)),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);

    const second = ctx.anonymous();
    const login = await second.post('/auth/login', { email: user.email, password: TEST_PASSWORD });
    expect(login.json()).toEqual({ status: 'mfa_required' });

    const blocked = await second.get('/users');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.details.reason).toBe('mfa_required');
    expect((await second.get('/auth/me')).json()).toMatchObject({
      mfaPending: true,
      permissions: [],
    });

    expect((await second.post('/auth/2fa/verify', { code: '000000' })).statusCode).toBe(401);
    expect((await second.post('/auth/2fa/verify', { code: totpCode(secret) })).statusCode).toBe(
      200,
    );
    expect((await second.get('/users')).statusCode).toBe(200);
  });

  it('confines users to enrolment when the organisation requires two-factor', async () => {
    const strict = await createTestApp();
    try {
      await strict.t.db
        .update(organizations)
        .set({ settings: { requireTwoFactor: true } })
        .where(eq(organizations.id, strict.org.orgId));
      const admin = await strict.admin();
      const blocked = await admin.get('/users');
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.details.reason).toBe('mfa_enrollment_required');

      const { secret } = (await admin.post('/auth/2fa/enroll')).json();
      await admin.post('/auth/2fa/confirm', { code: totpCode(secret) });
      expect((await admin.get('/users')).statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });
});

describe('user administration', () => {
  it('invites a user by email and lets them choose a password', async () => {
    const admin = await ctx.admin();
    const res = await admin.post('/users', {
      email: 'frontdesk@seabreeze.example',
      name: 'Front Desk',
      grants: [{ role: 'front_desk', propertyId: null }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: 'invited', inviteEmailed: true });

    const mail = ctx.mailer.last()!;
    expect(mail.to).toBe('frontdesk@seabreeze.example');
    const token = new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    const anon = ctx.anonymous();
    expect(
      (await anon.post('/auth/password-reset/redeem', { token, password: 'front desk password 1' }))
        .statusCode,
    ).toBe(200);
    const staff = await ctx.login('frontdesk@seabreeze.example', 'front desk password 1');
    const me = (await staff.get('/auth/me')).json();
    expect(me.permissions).toContain('reservations.write');
    expect(me.permissions).not.toContain('org.manage');

    // Staff without the admin role cannot manage users or read the audit log.
    expect((await staff.get('/users')).statusCode).toBe(403);
    expect((await staff.get('/audit')).statusCode).toBe(403);
    expect(
      (await staff.post('/users', { email: 'x@y.co', name: 'X', grants: [] })).statusCode,
    ).toBe(403);
  });

  it('answers a reset request the same way for unknown emails, and mails known ones', async () => {
    const anon = ctx.anonymous();
    const before = ctx.mailer.sent.length;
    const unknown = await anon.post('/auth/password-reset/request', { email: 'ghost@example.com' });
    expect(unknown.json()).toEqual({ status: 'ok' });
    expect(ctx.mailer.sent.length).toBe(before);

    const known = await anon.post('/auth/password-reset/request', { email: ctx.org.admin.label });
    expect(known.json()).toEqual({ status: 'ok' });
    expect(ctx.mailer.sent.length).toBe(before + 1);
  });

  it('shows the audit trail to admins, filtered and paged', async () => {
    const admin = await ctx.admin();
    const all = (await admin.get('/audit?limit=2')).json();
    expect(all.entries).toHaveLength(2);
    expect(all.nextBeforeId).toBeGreaterThan(0);
    const next = (await admin.get(`/audit?limit=2&beforeId=${all.nextBeforeId}`)).json();
    expect(next.entries[0].id).toBeLessThan(all.entries[1].id);

    const logins = (await admin.get('/audit?actionPrefix=auth.login')).json();
    expect(logins.entries.length).toBeGreaterThan(0);
    expect(logins.entries.every((e: { action: string }) => e.action.startsWith('auth.login'))).toBe(
      true,
    );
  });
});

describe('single sign-on over the API', () => {
  it('lists providers publicly and completes the redirect flow', async () => {
    await createTestUser(ctx.t.db, ctx.org.orgId, {
      email: 'gm@seabreeze.example',
      role: 'general_manager',
    });
    const anon = ctx.anonymous();
    expect((await anon.get('/auth/providers')).json()).toEqual({
      providers: [{ slug: 'workspace', name: 'Company Workspace' }],
    });

    const start = await anon.get('/auth/oidc/workspace/start?returnTo=/calendar');
    expect(start.statusCode).toBe(302);
    const flowCookie = start.cookies.find((c) => c.name === 'pms_oidc')!;
    expect(flowCookie.httpOnly).toBe(true);
    const authUrl = start.headers.location as string;
    expect(authUrl.startsWith(idp.issuer)).toBe(true);

    const callback = new URL(
      idp.authorize(authUrl, { sub: 'gm-1', email: 'gm@seabreeze.example' }),
    );
    const finish = await anon.request({
      method: 'GET',
      url: `/auth/oidc/workspace/callback${callback.search}`,
      headers: { cookie: `pms_oidc=${flowCookie.value}` },
    });
    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toBe(`${ctx.env.WEB_URL}/calendar`);
    const me = (await anon.get('/auth/me')).json();
    expect(me.user.email).toBe('gm@seabreeze.example');
    expect(me.authMethod).toBe('oidc');
  });

  it('never redirects to another site after sign-in', async () => {
    const anon = ctx.anonymous();
    const start = await anon.get('/auth/oidc/workspace/start?returnTo=//evil.example/steal');
    const flowCookie = start.cookies.find((c) => c.name === 'pms_oidc')!;
    const callback = new URL(
      idp.authorize(start.headers.location as string, {
        sub: 'gm-1',
        email: 'gm@seabreeze.example',
      }),
    );
    const finish = await anon.request({
      method: 'GET',
      url: `/auth/oidc/workspace/callback${callback.search}`,
      headers: { cookie: `pms_oidc=${flowCookie.value}` },
    });
    expect(finish.headers.location).toBe(`${ctx.env.WEB_URL}/`);
  });

  it('sends failures back to the sign-in page with a reason and no session', async () => {
    const anon = ctx.anonymous();
    const start = await anon.get('/auth/oidc/workspace/start');
    const flowCookie = start.cookies.find((c) => c.name === 'pms_oidc')!;
    const callback = new URL(
      idp.authorize(start.headers.location as string, { sub: 'x', email: 'someone@gmail.com' }),
    );
    const finish = await anon.request({
      method: 'GET',
      url: `/auth/oidc/workspace/callback${callback.search}`,
      headers: { cookie: `pms_oidc=${flowCookie.value}` },
    });
    expect(finish.statusCode).toBe(302);
    expect(finish.headers.location).toContain(`${ctx.env.WEB_URL}/login?error=`);
    expect(finish.cookies.find((c) => c.name === 'pms_session')).toBeUndefined();

    const noCookie = await ctx.anonymous().get(`/auth/oidc/workspace/callback${callback.search}`);
    expect(noCookie.headers.location).toContain('/login?error=');
  });
});
