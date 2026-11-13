import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, organizations, sessions, users } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { writeAudit } from '../audit';
import { DomainError } from '../errors';
import { TEST_PASSWORD, createTestOrg, createTestUser, type TestOrg } from '../testing';
import { can, propertyScope } from './permissions';
import {
  beginTwoFactorEnrollment,
  changePassword,
  completeTwoFactor,
  confirmTwoFactorEnrollment,
  createUser,
  disableTwoFactor,
  listUsers,
  loginWithPassword,
  redeemUserToken,
  requestPasswordReset,
  resolveSession,
  revokeSession,
  setupOrganization,
  updateUser,
} from './service';
import { totpCode } from './totp';

let t: TestDatabase;
let org: TestOrg;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
});
afterAll(async () => {
  await t.drop();
});

async function expectDomainError(promise: Promise<unknown>, code: string, message?: RegExp) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to fail').toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (message) expect((err as DomainError).message).toMatch(message);
}

describe('first-run setup', () => {
  it('refuses to run once an organisation exists', async () => {
    await expectDomainError(
      setupOrganization(t.db, {
        orgName: 'Second Org',
        adminEmail: 'second@example.com',
        adminName: 'Second',
        adminPassword: 'another long password',
      }),
      'conflict',
    );
  });

  it('creates the organisation with an admin who can sign in', async () => {
    const fresh = await createTestDatabase();
    try {
      const { orgId, userId } = await setupOrganization(fresh.db, {
        orgName: 'Sea Breeze Hotels & Villas',
        adminEmail: 'Owner@SeaBreeze.example',
        adminName: 'Owner',
        adminPassword: 'a sufficiently long password',
      });
      const [o] = await fresh.db.select().from(organizations).where(eq(organizations.id, orgId));
      expect(o?.slug).toBe('sea-breeze-hotels-villas');
      // Email matching is case-insensitive.
      const login = await loginWithPassword(fresh.db, {
        email: 'owner@seabreeze.example',
        password: 'a sufficiently long password',
      });
      expect(login.status).toBe('ok');
      const session = await resolveSession(fresh.db, login.token);
      expect(session?.user.id).toBe(userId);
      expect(can(session!.grants, 'org.manage')).toBe(true);
    } finally {
      await fresh.drop();
    }
  });
});

describe('password sign-in', () => {
  it('rejects a wrong password and an unknown email with the same error', async () => {
    const user = await createTestUser(t.db, org.orgId);
    await expectDomainError(
      loginWithPassword(t.db, { email: user.email, password: 'wrong password here' }),
      'unauthenticated',
      /Invalid email or password/,
    );
    await expectDomainError(
      loginWithPassword(t.db, { email: 'nobody@example.com', password: TEST_PASSWORD }),
      'unauthenticated',
      /Invalid email or password/,
    );
  });

  it('creates a session that resolves to the user and their grants', async () => {
    const user = await createTestUser(t.db, org.orgId, { role: 'front_desk' });
    const login = await loginWithPassword(t.db, {
      email: user.email,
      password: TEST_PASSWORD,
      ip: '10.0.0.9',
    });
    expect(login.status).toBe('ok');

    const session = await resolveSession(t.db, login.token);
    expect(session?.user.email).toBe(user.email);
    expect(session?.grants).toEqual([{ role: 'front_desk', propertyId: null }]);
    expect(session?.mfaPending).toBe(false);

    // Only the hash of the token is stored.
    const stored = await t.db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(login.token);
    expect(stored[0]!.ip).toBe('10.0.0.9');

    expect(await resolveSession(t.db, 'not-a-real-token')).toBeNull();
    await revokeSession(t.db, login.token);
    expect(await resolveSession(t.db, login.token)).toBeNull();
  });

  it('does not resolve an expired session', async () => {
    const user = await createTestUser(t.db, org.orgId);
    const login = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user.id));
    expect(await resolveSession(t.db, login.token)).toBeNull();
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    const user = await createTestUser(t.db, org.orgId);
    for (let i = 0; i < 10; i++) {
      await expectDomainError(
        loginWithPassword(t.db, { email: user.email, password: `wrong-${i}-password` }),
        'unauthenticated',
      );
    }
    await expectDomainError(
      loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD }),
      'rate_limited',
    );

    // Once the lock lapses the correct password works again.
    await t.db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.id));
    expect(
      (await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD })).status,
    ).toBe('ok');
  });

  it('refuses disabled accounts and ends their sessions', async () => {
    const user = await createTestUser(t.db, org.orgId, { role: 'read_only' });
    const login = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    await updateUser(t.db, org.admin, user.id, { status: 'disabled' });
    expect(await resolveSession(t.db, login.token)).toBeNull();
    await expectDomainError(
      loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD }),
      'unauthenticated',
    );
  });
});

describe('two-factor authentication', () => {
  it('requires the authenticator code after enrolment and blocks replay', async () => {
    const user = await createTestUser(t.db, org.orgId, { role: 'general_manager' });
    const { secret, otpauthUrl } = await beginTwoFactorEnrollment(t.db, user.id);
    expect(otpauthUrl).toContain(secret);

    await expectDomainError(confirmTwoFactorEnrollment(t.db, user.id, '000000'), 'validation');
    // Enrol with the previous step's code so the current step is still unused below.
    const earlier = new Date(Date.now() - 30_000);
    const { recoveryCodes } = await confirmTwoFactorEnrollment(
      t.db,
      user.id,
      totpCode(secret, earlier),
    );
    expect(recoveryCodes).toHaveLength(10);

    const login = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    expect(login.status).toBe('mfa_required');
    const pending = await resolveSession(t.db, login.token);
    expect(pending?.mfaPending).toBe(true);

    await expectDomainError(completeTwoFactor(t.db, login.token, '123 456'), 'unauthenticated');
    const code = totpCode(secret);
    await completeTwoFactor(t.db, login.token, code);
    expect((await resolveSession(t.db, login.token))?.mfaPending).toBe(false);

    // The same code cannot complete a second sign-in.
    const second = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    await expectDomainError(completeTwoFactor(t.db, second.token, code), 'unauthenticated');

    // A recovery code works exactly once.
    await completeTwoFactor(t.db, second.token, recoveryCodes[0]!.toLowerCase());
    expect((await resolveSession(t.db, second.token))?.mfaPending).toBe(false);
    const third = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    await expectDomainError(
      completeTwoFactor(t.db, third.token, recoveryCodes[0]!),
      'unauthenticated',
    );

    await disableTwoFactor(t.db, org.admin, user.id);
    expect(
      (await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD })).status,
    ).toBe('ok');
  });

  it('stores the authenticator secret encrypted', async () => {
    const user = await createTestUser(t.db, org.orgId);
    const { secret } = await beginTwoFactorEnrollment(t.db, user.id);
    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.totpSecretEnc).toBeTruthy();
    expect(row!.totpSecretEnc).not.toContain(secret);
  });

  it('flags users who must enrol when the organisation requires two-factor', async () => {
    const other = await createTestDatabase();
    try {
      const o = await createTestOrg(other.db);
      await other.db
        .update(organizations)
        .set({ settings: { requireTwoFactor: true } })
        .where(eq(organizations.id, o.orgId));
      const user = await createTestUser(other.db, o.orgId);
      const login = await loginWithPassword(other.db, {
        email: user.email,
        password: TEST_PASSWORD,
      });
      expect((await resolveSession(other.db, login.token))?.mustEnrollTwoFactor).toBe(true);
    } finally {
      await other.drop();
    }
  });
});

describe('user management', () => {
  it('invites a user who sets a password through a single-use link', async () => {
    const created = await createUser(t.db, org.admin, {
      email: 'New.Hire@example.com',
      name: 'New Hire',
      grants: [{ role: 'housekeeping', propertyId: null }],
    });
    expect(created.status).toBe('invited');
    expect(created.inviteToken).toBeTruthy();
    await expectDomainError(
      loginWithPassword(t.db, { email: created.email, password: 'whatever password' }),
      'unauthenticated',
    );

    await expectDomainError(
      redeemUserToken(t.db, created.inviteToken!, 'short'),
      'validation',
      /at least 10/,
    );
    await redeemUserToken(t.db, created.inviteToken!, 'my first real password');
    expect(
      (await loginWithPassword(t.db, { email: created.email, password: 'my first real password' }))
        .status,
    ).toBe('ok');
    await expectDomainError(
      redeemUserToken(t.db, created.inviteToken!, 'another real password'),
      'validation',
      /expired/,
    );
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const existing = await createTestUser(t.db, org.orgId);
    await expectDomainError(
      createUser(t.db, org.admin, { email: existing.email.toUpperCase(), name: 'Dup', grants: [] }),
      'conflict',
    );
    await expectDomainError(
      createUser(t.db, org.admin, {
        email: 'weak@example.com',
        name: 'Weak',
        password: 'short',
        grants: [],
      }),
      'validation',
    );
    await expectDomainError(
      createUser(t.db, org.admin, {
        email: 'scoped-admin@example.com',
        name: 'Scoped',
        grants: [{ role: 'org_admin', propertyId: '00000000-0000-0000-0000-000000000001' }],
      }),
      'validation',
    );
  });

  it('resets a password and signs out existing sessions', async () => {
    const user = await createTestUser(t.db, org.orgId);
    const login = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    const reset = await requestPasswordReset(t.db, user.email);
    expect(reset).not.toBeNull();
    expect(await requestPasswordReset(t.db, 'nobody@example.com')).toBeNull();

    await redeemUserToken(t.db, reset!.token, 'a brand new password');
    expect(await resolveSession(t.db, login.token)).toBeNull();
    await expectDomainError(
      loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD }),
      'unauthenticated',
    );
    expect(
      (await loginWithPassword(t.db, { email: user.email, password: 'a brand new password' }))
        .status,
    ).toBe('ok');
  });

  it('changes a password only when the current one is right, keeping the current session', async () => {
    const user = await createTestUser(t.db, org.orgId);
    const a = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    const b = await loginWithPassword(t.db, { email: user.email, password: TEST_PASSWORD });
    const session = (await resolveSession(t.db, a.token))!;
    await expectDomainError(
      changePassword(t.db, session, 'not my password', 'a replacement password'),
      'validation',
    );
    await changePassword(t.db, session, TEST_PASSWORD, 'a replacement password');
    expect(await resolveSession(t.db, a.token)).not.toBeNull();
    expect(await resolveSession(t.db, b.token)).toBeNull();
  });

  it('never leaves the organisation without an admin', async () => {
    await expectDomainError(
      updateUser(t.db, org.admin, org.adminUserId, { status: 'disabled' }),
      'conflict',
    );
    await expectDomainError(
      updateUser(t.db, org.admin, org.adminUserId, {
        grants: [{ role: 'read_only', propertyId: null }],
      }),
      'conflict',
    );
    // With a second admin in place the first can step down.
    const second = await createTestUser(t.db, org.orgId, { role: 'org_admin' });
    await updateUser(t.db, second.actor, org.adminUserId, {
      grants: [{ role: 'read_only', propertyId: null }],
    });
    const list = await listUsers(t.db, org.orgId);
    expect(list.find((u) => u.id === org.adminUserId)?.grants).toEqual([
      { role: 'read_only', propertyId: null },
    ]);
    await updateUser(t.db, second.actor, org.adminUserId, {
      grants: [{ role: 'org_admin', propertyId: null }],
    });
  });
});

describe('permissions', () => {
  const P1 = '11111111-1111-1111-1111-111111111111';
  const P2 = '22222222-2222-2222-2222-222222222222';

  it('scopes property roles to their property', () => {
    const grants = [{ role: 'front_desk' as const, propertyId: P1 }];
    expect(can(grants, 'reservations.write', P1)).toBe(true);
    expect(can(grants, 'reservations.write', P2)).toBe(false);
    expect(can(grants, 'rates.write', P1)).toBe(false);
    expect(propertyScope(grants, 'reservations.read')).toEqual([P1]);
    expect(
      propertyScope([{ role: 'general_manager', propertyId: null }], 'reservations.read'),
    ).toBe('all');
  });

  it('keeps organisation-wide permissions away from property-scoped grants', () => {
    expect(can([{ role: 'org_admin', propertyId: null }], 'org.manage')).toBe(true);
    expect(can([{ role: 'general_manager', propertyId: null }], 'org.manage')).toBe(false);
    expect(can([{ role: 'accountant', propertyId: P1 }], 'audit.read')).toBe(false);
    expect(can([{ role: 'accountant', propertyId: null }], 'audit.read')).toBe(true);
  });

  it('limits villa owners to the owner portal', () => {
    const grants = [{ role: 'villa_owner' as const, propertyId: P1 }];
    expect(can(grants, 'owner.portal', P1)).toBe(true);
    expect(can(grants, 'reservations.read', P1)).toBe(false);
    expect(can([{ role: 'org_admin', propertyId: null }], 'owner.portal')).toBe(false);
  });
});

describe('audit log', () => {
  it('records sign-ins and administrative changes with redacted secrets', async () => {
    const user = await createTestUser(t.db, org.orgId);
    await loginWithPassword(t.db, {
      email: user.email,
      password: TEST_PASSWORD,
      ip: '203.0.113.7',
      requestId: 'req-1',
    });
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.entityId, user.id));
    const login = entries.find((e) => e.action === 'auth.login');
    expect(login).toMatchObject({
      actorLabel: user.email,
      ip: '203.0.113.7',
      requestId: 'req-1',
      actorType: 'user',
    });

    await writeAudit(t.db, org.admin, {
      action: 'test.secret',
      entityType: 'test',
      changes: { password: 'hunter2', nested: { clientSecret: 'abc', name: 'kept' } },
    });
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'test.secret'));
    expect(entry!.changes).toEqual({
      password: '[redacted]',
      nested: { clientSecret: '[redacted]', name: 'kept' },
    });
  });

  it('cannot be edited or deleted, except by the retention job', async () => {
    await writeAudit(t.db, org.admin, { action: 'test.immutable', entityType: 'test' });
    await expect(
      t.db.execute(sql`UPDATE audit_log SET summary = 'tampered' WHERE action = 'test.immutable'`),
    ).rejects.toThrow();
    await expect(
      t.db.execute(sql`DELETE FROM audit_log WHERE action = 'test.immutable'`),
    ).rejects.toThrow();
    await expect(t.db.execute(sql`TRUNCATE audit_log`)).rejects.toThrow();

    const [{ count: before }] = (
      await t.db.execute<{ count: string }>(
        sql`SELECT count(*) FROM audit_log WHERE action = 'test.immutable'`,
      )
    ).rows as [{ count: string }];
    expect(Number(before)).toBe(1);

    await t.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pms.audit_retention', 'on', true)`);
      await tx.execute(sql`DELETE FROM audit_log WHERE action = 'test.immutable'`);
    });
    const after = await t.db.select().from(auditLog).where(eq(auditLog.action, 'test.immutable'));
    expect(after).toHaveLength(0);
    // The retention switch is transaction-local: it does not leak to later statements.
    await writeAudit(t.db, org.admin, { action: 'test.immutable', entityType: 'test' });
    await expect(
      t.db.execute(sql`DELETE FROM audit_log WHERE action = 'test.immutable'`),
    ).rejects.toThrow();
  });
});
