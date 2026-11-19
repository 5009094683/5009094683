import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getEnv } from '@pms/config';
import {
  organizations,
  roleAssignments,
  sessions,
  users,
  userTokens,
  ROLES,
  type Database,
  type DbOrTx,
  type Role,
} from '@pms/db';
import { writeAudit } from '../audit';
import type { Actor, Grant } from '../context';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../crypto';
import { DomainError, conflict, notFound, validationError } from '../errors';
import {
  hashPassword,
  passwordNeedsRehash,
  passwordProblem,
  verifyDummyPassword,
  verifyPassword,
} from './passwords';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;
const SESSION_ABSOLUTE_DAYS = 7;
const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 2;

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  twoFactorEnabled: boolean;
}

export interface SessionContext {
  sessionId: string;
  user: SessionUser;
  grants: Grant[];
  authMethod: 'password' | 'oidc';
  /** Password accepted, second factor still required: only the 2FA endpoints may be used. */
  mfaPending: boolean;
  /** Organisation policy demands a second factor this user has not enrolled yet. */
  mustEnrollTwoFactor: boolean;
  expiresAt: Date;
}

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

function invalidCredentials(): DomainError {
  return new DomainError('unauthenticated', 'Invalid email or password');
}

function userActor(user: { id: string; orgId: string; email: string }, client: ClientInfo): Actor {
  return {
    type: 'user',
    orgId: user.orgId,
    userId: user.id,
    label: user.email,
    grants: [],
    ip: client.ip,
    requestId: client.requestId,
  };
}

export async function loadGrants(db: DbOrTx, userId: string): Promise<Grant[]> {
  const rows = await db
    .select({ role: roleAssignments.role, propertyId: roleAssignments.propertyId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  return rows;
}

export async function createSession(
  db: DbOrTx,
  userId: string,
  options: { authMethod: 'password' | 'oidc'; mfaPending: boolean } & ClientInfo,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + getEnv().SESSION_TTL_HOURS * 3_600_000);
  const [row] = await db
    .insert(sessions)
    .values({
      tokenHash: sha256Hex(token),
      userId,
      authMethod: options.authMethod,
      mfaPending: options.mfaPending,
      ip: options.ip ?? null,
      userAgent: options.userAgent?.slice(0, 400) ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

export type LoginResult =
  | { status: 'ok'; token: string; expiresAt: Date }
  | { status: 'mfa_required'; token: string; expiresAt: Date };

export async function loginWithPassword(
  db: Database,
  input: { email: string; password: string } & ClientInfo,
): Promise<LoginResult> {
  const email = input.email.trim();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!user || user.status !== 'active' || !user.passwordHash) {
    await verifyDummyPassword(input.password);
    throw invalidCredentials();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new DomainError('rate_limited', 'Too many failed attempts. Try again in a few minutes.');
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    await recordFailedAttempt(db, user, input, 'auth.login_failed');
    throw invalidCredentials();
  }

  return db.transaction(async (tx) => {
    const updates: Partial<typeof users.$inferInsert> = {
      failedLoginCount: 0,
      lockedUntil: null,
    };
    const mfaPending = user.totpEnabledAt !== null;
    if (!mfaPending) updates.lastLoginAt = new Date();
    if (passwordNeedsRehash(user.passwordHash!)) {
      updates.passwordHash = await hashPassword(input.password);
    }
    await tx.update(users).set(updates).where(eq(users.id, user.id));
    const session = await createSession(tx, user.id, {
      authMethod: 'password',
      mfaPending,
      ...input,
    });
    if (!mfaPending) {
      await writeAudit(tx, userActor(user, input), {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        summary: 'Signed in with password',
      });
    }
    return {
      status: mfaPending ? 'mfa_required' : 'ok',
      token: session.token,
      expiresAt: session.expiresAt,
    };
  });
}

async function recordFailedAttempt(
  db: Database,
  user: { id: string; orgId: string; email: string },
  client: ClientInfo,
  action: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, user.id))
      .returning({ failedLoginCount: users.failedLoginCount });
    const locked = (updated?.failedLoginCount ?? 0) >= MAX_FAILED_LOGINS;
    if (locked) {
      await tx
        .update(users)
        .set({ lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000), failedLoginCount: 0 })
        .where(eq(users.id, user.id));
    }
    await writeAudit(tx, userActor(user, client), {
      action,
      entityType: 'user',
      entityId: user.id,
      summary: locked
        ? `Account locked for ${LOCKOUT_MINUTES} minutes after repeated failures`
        : 'Failed sign-in attempt',
    });
  });
}

/** Completes a sign-in that is waiting for a second factor. Accepts a TOTP or a recovery code. */
export async function completeTwoFactor(
  db: Database,
  token: string,
  code: string,
  client: ClientInfo = {},
): Promise<void> {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row || !row.session.mfaPending) {
    throw new DomainError('unauthenticated', 'Sign in again to continue');
  }
  const { session, user } = row;
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new DomainError('rate_limited', 'Too many failed attempts. Try again in a few minutes.');
  }
  if (!user.totpSecretEnc || !user.totpEnabledAt) {
    throw new DomainError('unauthenticated', 'Sign in again to continue');
  }

  const step = verifyTotp(decryptSecret(user.totpSecretEnc), code, { lastStep: user.totpLastStep });
  let usedRecoveryCode = false;
  let remainingRecovery = user.recoveryCodeHashes;
  if (step === null) {
    const hash = sha256Hex(normalizeRecoveryCode(code));
    if (user.recoveryCodeHashes.includes(hash)) {
      usedRecoveryCode = true;
      remainingRecovery = user.recoveryCodeHashes.filter((h) => h !== hash);
    } else {
      await recordFailedAttempt(db, user, client, 'auth.2fa_failed');
      throw new DomainError('unauthenticated', 'That code is not valid');
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        ...(step !== null ? { totpLastStep: step } : { recoveryCodeHashes: remainingRecovery }),
      })
      .where(eq(users.id, user.id));
    await tx.update(sessions).set({ mfaPending: false }).where(eq(sessions.id, session.id));
    await writeAudit(tx, userActor(user, client), {
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      summary: usedRecoveryCode
        ? `Signed in with a recovery code (${remainingRecovery.length} left)`
        : 'Signed in with password and authenticator code',
    });
  });
}

/** Looks up a session token. Extends the session when it is past half its lifetime. */
export async function resolveSession(db: Database, token: string): Promise<SessionContext | null> {
  if (!token) return null;
  const now = new Date();
  const [row] = await db
    .select({ session: sessions, user: users, orgSettings: organizations.settings })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row || row.user.status !== 'active') return null;
  const { session, user } = row;

  const ttlMs = getEnv().SESSION_TTL_HOURS * 3_600_000;
  let expiresAt = session.expiresAt;
  const absoluteEnd = new Date(session.createdAt.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000);
  const remaining = expiresAt.getTime() - now.getTime();
  const stale = now.getTime() - session.lastSeenAt.getTime() > 60_000;
  if (stale || remaining < ttlMs / 2) {
    if (remaining < ttlMs / 2) {
      expiresAt = new Date(Math.min(now.getTime() + ttlMs, absoluteEnd.getTime()));
    }
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(sessions.id, session.id));
  }

  const grants = await loadGrants(db, user.id);
  const twoFactorEnabled = user.totpEnabledAt !== null;
  return {
    sessionId: session.id,
    user: { id: user.id, orgId: user.orgId, email: user.email, name: user.name, twoFactorEnabled },
    grants,
    authMethod: session.authMethod,
    mfaPending: session.mfaPending,
    // Single sign-on delegates the second factor to the identity provider.
    mustEnrollTwoFactor:
      Boolean(row.orgSettings.requireTwoFactor) &&
      !twoFactorEnabled &&
      session.authMethod === 'password',
    expiresAt,
  };
}

export async function revokeSession(db: DbOrTx, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(
  db: DbOrTx,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined,
      ),
    );
}

// ---------------------------------------------------------------------------
// Two-factor enrolment

/** Starts enrolment: stores a new secret (not yet active) and returns it for the QR code. */
export async function beginTwoFactorEnrollment(
  db: Database,
  userId: string,
): Promise<{ secret: string; otpauthUrl: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound('User', userId);
  if (user.totpEnabledAt) throw conflict('Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret) })
    .where(eq(users.id, userId));
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, user.orgId));
  return {
    secret,
    otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: org?.name ?? 'PMS' }),
  };
}

/** Activates two-factor after the user proves the authenticator works. Returns recovery codes once. */
export async function confirmTwoFactorEnrollment(
  db: Database,
  userId: string,
  code: string,
  client: ClientInfo = {},
): Promise<{ recoveryCodes: string[] }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound('User', userId);
  if (user.totpEnabledAt) throw conflict('Two-factor authentication is already enabled');
  if (!user.totpSecretEnc) throw validationError('Start two-factor enrolment first');
  const step = verifyTotp(decryptSecret(user.totpSecretEnc), code);
  if (step === null)
    throw validationError('That code is not valid. Check the time on your phone and try again.');

  const recoveryCodes = generateRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        totpEnabledAt: new Date(),
        totpLastStep: step,
        recoveryCodeHashes: recoveryCodes.map((c) => sha256Hex(normalizeRecoveryCode(c))),
      })
      .where(eq(users.id, userId));
    await writeAudit(tx, userActor(user, client), {
      action: 'auth.2fa_enabled',
      entityType: 'user',
      entityId: userId,
      summary: 'Enabled two-factor authentication',
    });
  });
  return { recoveryCodes };
}

/** Removes the second factor. `actor` is the user themself (with their password checked by the caller) or an admin. */
export async function disableTwoFactor(db: Database, actor: Actor, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.orgId !== actor.orgId) throw notFound('User', userId);
    await tx
      .update(users)
      .set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, recoveryCodeHashes: [] })
      .where(eq(users.id, userId));
    await writeAudit(tx, actor, {
      action: 'auth.2fa_disabled',
      entityType: 'user',
      entityId: userId,
      summary: `Disabled two-factor authentication for ${user.email}`,
    });
  });
}

// ---------------------------------------------------------------------------
// User management

function assertGrants(grants: Grant[]): void {
  for (const g of grants) {
    if (!ROLES.includes(g.role)) throw validationError(`Unknown role "${g.role}"`);
    if (g.role === 'org_admin' && g.propertyId !== null) {
      throw validationError('The organisation admin role cannot be limited to one property');
    }
  }
}

export interface CreateUserInput {
  email: string;
  name: string;
  /** Omit to create an invited account that sets its own password through a link. */
  password?: string;
  grants: Grant[];
}

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'invited';
  /** Present for invited accounts: the single-use token to build the invitation link from. */
  inviteToken?: string;
}

export async function createUser(
  db: Database,
  actor: Actor,
  input: CreateUserInput,
): Promise<CreatedUser> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw validationError('Enter a valid email address');
  if (!input.name.trim()) throw validationError('Name is required');
  assertGrants(input.grants);
  if (input.password !== undefined) {
    const problem = passwordProblem(input.password, { email });
    if (problem) throw validationError(problem);
  }
  const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) throw conflict('A user with this email already exists');

    const status = passwordHash ? 'active' : 'invited';
    const [user] = await tx
      .insert(users)
      .values({ orgId: actor.orgId, email, name: input.name.trim(), status, passwordHash })
      .returning();
    if (input.grants.length > 0) {
      await tx.insert(roleAssignments).values(
        input.grants.map((g) => ({
          userId: user!.id,
          role: g.role,
          propertyId: g.propertyId,
          createdBy: actor.userId ?? null,
        })),
      );
    }
    let inviteToken: string | undefined;
    if (status === 'invited') {
      inviteToken = await issueUserToken(tx, user!.id, 'invite', actor.userId);
    }
    await writeAudit(tx, actor, {
      action: 'user.created',
      entityType: 'user',
      entityId: user!.id,
      summary: `Created user ${email}`,
      changes: { grants: input.grants, status },
    });
    return { id: user!.id, email, name: user!.name, status, inviteToken };
  });
}

async function issueUserToken(
  tx: DbOrTx,
  userId: string,
  kind: 'invite' | 'password_reset',
  createdBy?: string,
): Promise<string> {
  const token = randomToken(32);
  const hours = kind === 'invite' ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  await tx.insert(userTokens).values({
    userId,
    kind,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + hours * 3_600_000),
    createdBy: createdBy ?? null,
  });
  return token;
}

/** Issues a password-reset token. Returns null for unknown or disabled accounts (callers must not reveal which). */
export async function requestPasswordReset(
  db: Database,
  email: string,
  createdBy?: string,
): Promise<{ token: string; userId: string; email: string; name: string } | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email.trim())).limit(1);
  if (!user || user.status === 'disabled') return null;
  const token = await issueUserToken(
    db,
    user.id,
    user.status === 'invited' ? 'invite' : 'password_reset',
    createdBy,
  );
  return { token, userId: user.id, email: user.email, name: user.name };
}

/** Sets a password from an invitation or reset link and signs the user out everywhere else. */
export async function redeemUserToken(
  db: Database,
  token: string,
  newPassword: string,
  client: ClientInfo = {},
): Promise<{ userId: string; email: string }> {
  const hash = sha256Hex(token);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ token: userTokens, user: users })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(
        and(
          eq(userTokens.tokenHash, hash),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      )
      .for('update', { of: userTokens })
      .limit(1);
    if (!row || row.user.status === 'disabled') {
      throw validationError('This link is invalid or has expired. Ask for a new one.');
    }
    const problem = passwordProblem(newPassword, { email: row.user.email });
    if (problem) throw validationError(problem);

    await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, row.token.id));
    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(newPassword),
        status: 'active',
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, row.user.id));
    await revokeAllSessions(tx, row.user.id);
    await writeAudit(tx, userActor(row.user, client), {
      action: row.token.kind === 'invite' ? 'user.invite_accepted' : 'auth.password_reset',
      entityType: 'user',
      entityId: row.user.id,
      summary:
        row.token.kind === 'invite' ? 'Accepted invitation and set a password' : 'Reset password',
    });
    return { userId: row.user.id, email: row.user.email };
  });
}

export async function changePassword(
  db: Database,
  session: SessionContext,
  currentPassword: string,
  newPassword: string,
  client: ClientInfo = {},
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!user) throw notFound('User', session.user.id);
  if (user.passwordHash && !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw validationError('Your current password is not correct');
  }
  const problem = passwordProblem(newPassword, { email: user.email });
  if (problem) throw validationError(problem);
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await revokeAllSessions(tx, user.id, session.sessionId);
    await writeAudit(tx, userActor(user, client), {
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
      summary: 'Changed password',
    });
  });
}

export interface UpdateUserInput {
  name?: string;
  status?: 'active' | 'disabled';
  grants?: Grant[];
}

export async function updateUser(
  db: Database,
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
): Promise<void> {
  if (input.grants) assertGrants(input.grants);
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);
    if (!user || user.orgId !== actor.orgId) throw notFound('User', userId);

    const removesAdmin =
      (input.status === 'disabled' ||
        (input.grants && !input.grants.some((g) => g.role === 'org_admin'))) ??
      false;
    if (removesAdmin) {
      // Never leave the organisation without an active admin.
      const admins = await tx
        .select({ id: users.id })
        .from(roleAssignments)
        .innerJoin(users, eq(users.id, roleAssignments.userId))
        .where(
          and(
            eq(roleAssignments.role, 'org_admin'),
            eq(users.orgId, actor.orgId),
            eq(users.status, 'active'),
          ),
        );
      const others = admins.filter((a) => a.id !== userId);
      const isAdmin = admins.some((a) => a.id === userId);
      if (isAdmin && others.length === 0) {
        throw conflict('At least one active organisation admin is required');
      }
    }

    const changes: Record<string, unknown> = {};
    const set: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined && input.name.trim() !== user.name) {
      set.name = input.name.trim();
      changes.name = { from: user.name, to: set.name };
    }
    if (input.status !== undefined && input.status !== user.status) {
      if (user.status === 'invited' && input.status === 'active') {
        throw validationError('An invited user becomes active by accepting the invitation');
      }
      set.status = input.status;
      changes.status = { from: user.status, to: input.status };
    }
    if (Object.keys(set).length > 0) await tx.update(users).set(set).where(eq(users.id, userId));
    if (input.status === 'disabled') await revokeAllSessions(tx, userId);

    if (input.grants) {
      const before = await loadGrants(tx, userId);
      await tx.delete(roleAssignments).where(eq(roleAssignments.userId, userId));
      if (input.grants.length > 0) {
        await tx.insert(roleAssignments).values(
          input.grants.map((g) => ({
            userId,
            role: g.role as Role,
            propertyId: g.propertyId,
            createdBy: actor.userId ?? null,
          })),
        );
      }
      changes.grants = { from: before, to: input.grants };
    }

    if (Object.keys(changes).length > 0) {
      await writeAudit(tx, actor, {
        action: 'user.updated',
        entityType: 'user',
        entityId: userId,
        summary: `Updated user ${user.email}`,
        changes,
      });
    }
  });
}

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  status: string;
  twoFactorEnabled: boolean;
  lastLoginAt: Date | null;
  grants: Grant[];
}

export async function listUsers(db: Database, orgId: string): Promise<UserListItem[]> {
  const rows = await db.select().from(users).where(eq(users.orgId, orgId)).orderBy(users.name);
  const assignments = await db
    .select({
      userId: roleAssignments.userId,
      role: roleAssignments.role,
      propertyId: roleAssignments.propertyId,
    })
    .from(roleAssignments)
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(eq(users.orgId, orgId));
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status,
    twoFactorEnabled: u.totpEnabledAt !== null,
    lastLoginAt: u.lastLoginAt,
    grants: assignments
      .filter((a) => a.userId === u.id)
      .map((a) => ({ role: a.role, propertyId: a.propertyId })),
  }));
}

// ---------------------------------------------------------------------------
// First-run setup

export async function isSetupComplete(db: DbOrTx): Promise<boolean> {
  const [row] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  return row !== undefined;
}

/** Creates the organisation and its first admin. Refused once an organisation exists. */
export async function setupOrganization(
  db: Database,
  input: { orgName: string; adminEmail: string; adminName: string; adminPassword: string },
): Promise<{ orgId: string; userId: string }> {
  const email = input.adminEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw validationError('Enter a valid email address');
  const problem = passwordProblem(input.adminPassword, { email });
  if (problem) throw validationError(problem);
  if (!input.orgName.trim()) throw validationError('Organisation name is required');
  const passwordHash = await hashPassword(input.adminPassword);

  return db.transaction(async (tx) => {
    // Serialise concurrent first-run requests so only one organisation can be created.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727002)`);
    if (await isSetupComplete(tx)) throw conflict('This system is already set up');
    const slug =
      input.orgName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'org';
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.orgName.trim(), slug })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({
        orgId: org!.id,
        email,
        name: input.adminName.trim() || email,
        status: 'active',
        passwordHash,
      })
      .returning();
    await tx
      .insert(roleAssignments)
      .values({ userId: user!.id, role: 'org_admin', propertyId: null });
    await writeAudit(
      tx,
      { type: 'user', orgId: org!.id, userId: user!.id, label: email, grants: [] },
      {
        action: 'org.created',
        entityType: 'organization',
        entityId: org!.id,
        summary: `Set up ${org!.name}`,
      },
    );
    return { orgId: org!.id, userId: user!.id };
  });
}
