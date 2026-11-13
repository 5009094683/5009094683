import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userIdentities, users } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { DomainError } from '../errors';
import {
  createTestOrg,
  createTestUser,
  startMockOidcProvider,
  type MockOidcProvider,
  type TestOrg,
} from '../testing';
import { finishOidcLogin, listPublicOidcProviders, saveOidcProvider, startOidcLogin } from './oidc';
import { resolveSession } from './service';

let t: TestDatabase;
let org: TestOrg;
let idp: MockOidcProvider;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  idp = await startMockOidcProvider();
  await saveOidcProvider(t.db, org.admin, {
    slug: 'workspace',
    name: 'Company Workspace',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    allowedEmailDomains: ['seabreeze.example'],
    autoProvision: false,
  });
  await saveOidcProvider(t.db, org.admin, {
    slug: 'auto',
    name: 'Auto Provisioning',
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    allowedEmailDomains: ['seabreeze.example'],
    autoProvision: true,
    defaultRole: 'read_only',
  });
});
afterAll(async () => {
  await idp.close();
  await t.drop();
});

async function failure(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

describe('single sign-on (OpenID Connect)', () => {
  it('lists enabled providers for the sign-in page without configuration details', async () => {
    const list = await listPublicOidcProviders(t.db);
    expect(list).toEqual([
      { slug: 'auto', name: 'Auto Provisioning' },
      { slug: 'workspace', name: 'Company Workspace' },
    ]);
  });

  it('signs in an existing user by verified email and remembers the link', async () => {
    const user = await createTestUser(t.db, org.orgId, {
      email: 'priya@seabreeze.example',
      role: 'front_desk',
    });
    const { url, flow } = await startOidcLogin(t.db, 'workspace', '/calendar');
    const authUrl = new URL(url);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toContain('openid');

    const callback = idp.authorize(url, {
      sub: 'idp-user-1',
      email: 'Priya@SeaBreeze.example',
      email_verified: true,
    });
    const result = await finishOidcLogin(t.db, flow, new URL(callback));
    expect(result.returnTo).toBe('/calendar');

    const session = await resolveSession(t.db, result.token);
    expect(session?.user.id).toBe(user.id);
    expect(session?.authMethod).toBe('oidc');
    expect(session?.grants).toEqual([{ role: 'front_desk', propertyId: null }]);

    // Later sign-ins match on the provider's subject, even if the email changes there.
    const again = await startOidcLogin(t.db, 'workspace');
    const callback2 = idp.authorize(again.url, {
      sub: 'idp-user-1',
      email: 'priya.new@seabreeze.example',
    });
    const result2 = await finishOidcLogin(t.db, again.flow, new URL(callback2));
    expect((await resolveSession(t.db, result2.token))?.user.id).toBe(user.id);
    const identities = await t.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, user.id));
    expect(identities).toHaveLength(1);
  });

  it('refuses people without an account unless auto-provisioning is on', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'workspace');
    const callback = idp.authorize(url, { sub: 'stranger', email: 'stranger@seabreeze.example' });
    const err = await failure(finishOidcLogin(t.db, flow, new URL(callback)));
    expect(err.code).toBe('forbidden');
    expect(
      await t.db.select().from(users).where(eq(users.email, 'stranger@seabreeze.example')),
    ).toHaveLength(0);
  });

  it('creates the user with the default role when auto-provisioning is on', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'auto');
    const callback = idp.authorize(url, {
      sub: 'new-hire',
      email: 'newhire@seabreeze.example',
      name: 'New Hire',
    });
    const result = await finishOidcLogin(t.db, flow, new URL(callback));
    const session = await resolveSession(t.db, result.token);
    expect(session?.user.name).toBe('New Hire');
    expect(session?.grants).toEqual([{ role: 'read_only', propertyId: null }]);
  });

  it('refuses email domains that are not allowed, and unverified emails', async () => {
    const a = await startOidcLogin(t.db, 'auto');
    const outsider = idp.authorize(a.url, { sub: 'outsider', email: 'someone@gmail.com' });
    expect((await failure(finishOidcLogin(t.db, a.flow, new URL(outsider)))).code).toBe(
      'forbidden',
    );

    const b = await startOidcLogin(t.db, 'auto');
    const unverified = idp.authorize(b.url, {
      sub: 'unverified',
      email: 'x@seabreeze.example',
      email_verified: false,
    });
    expect((await failure(finishOidcLogin(t.db, b.flow, new URL(unverified)))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a callback whose state does not match the one issued', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'workspace');
    const callback = new URL(
      idp.authorize(url, { sub: 'idp-user-1', email: 'priya@seabreeze.example' }),
    );
    callback.searchParams.set('state', 'attacker-chosen');
    expect((await failure(finishOidcLogin(t.db, flow, callback))).code).toBe('unauthenticated');
  });

  it('refuses an identity token with the wrong nonce', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'workspace');
    const callback = idp.authorize(url, { sub: 'idp-user-1', email: 'priya@seabreeze.example' });
    idp.corruptNextNonce();
    expect((await failure(finishOidcLogin(t.db, flow, new URL(callback)))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a code exchanged with the wrong PKCE verifier', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'workspace');
    const callback = idp.authorize(url, { sub: 'idp-user-1', email: 'priya@seabreeze.example' });
    const tampered = { ...flow, codeVerifier: `${flow.codeVerifier}x` };
    expect((await failure(finishOidcLogin(t.db, tampered, new URL(callback)))).code).toBe(
      'unauthenticated',
    );
  });

  it('refuses a sign-in attempt that took too long', async () => {
    const { url, flow } = await startOidcLogin(t.db, 'workspace');
    const callback = idp.authorize(url, { sub: 'idp-user-1', email: 'priya@seabreeze.example' });
    const stale = { ...flow, createdAt: Date.now() - 11 * 60_000 };
    expect((await failure(finishOidcLogin(t.db, stale, new URL(callback)))).code).toBe(
      'unauthenticated',
    );
  });

  it('validates provider configuration', async () => {
    const base = {
      slug: 'bad',
      name: 'Bad',
      issuer: idp.issuer,
      clientId: 'x',
      allowedEmailDomains: ['seabreeze.example'],
    };
    expect(
      (await failure(saveOidcProvider(t.db, org.admin, { ...base, slug: 'Not Valid' }))).code,
    ).toBe('validation');
    expect(
      (await failure(saveOidcProvider(t.db, org.admin, { ...base, defaultRole: 'org_admin' })))
        .code,
    ).toBe('validation');
    expect(
      (await failure(saveOidcProvider(t.db, org.admin, { ...base, scopes: 'email profile' }))).code,
    ).toBe('validation');
    expect(
      (await failure(saveOidcProvider(t.db, org.admin, { ...base, slug: 'workspace' }))).code,
    ).toBe('conflict');
  });
});
