import { and, desc, eq, isNull } from 'drizzle-orm';
import { API_KEY_ROLES, apiKeys, properties, users, type DbOrTx } from '@pms/db';
import { writeAudit } from './audit';
import type { Actor, Grant } from './context';
import { randomToken, sha256Hex } from './crypto';
import { notFound, validationError } from './errors';
import { transact } from './sqlx';

/**
 * Keys that let another system call the API: a revenue tool, an accounting
 * export, a website. A key carries roles like a person's, but never the
 * right to manage users, sign-in or keys. Only a hash of the key is kept, so
 * a key is shown once, when it is made.
 */

type ApiKeyRow = typeof apiKeys.$inferSelect;

export const API_KEY_PREFIX = 'pms_';

export interface ApiKeyView {
  id: string;
  name: string;
  /** The start of the key, enough to recognise it by. */
  prefix: string;
  grants: Grant[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** Who made the key. Null when that person's account is gone. */
  createdByName: string | null;
}

const view = (row: ApiKeyRow, createdByName: string | null): ApiKeyView => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  grants: row.grants,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdAt: row.createdAt,
  createdByName,
});

async function nameOf(db: DbOrTx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return user?.name ?? null;
}

export interface ApiKeyInput {
  name: string;
  grants: Grant[];
  expiresAt?: Date | null;
}

export async function createApiKey(
  db: DbOrTx,
  actor: Actor,
  input: ApiKeyInput,
  now: Date = new Date(),
): Promise<{ key: string; apiKey: ApiKeyView }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw validationError('Give the key a name that says what uses it');
  if (input.grants.length === 0) throw validationError('Choose what the key may do');
  if (input.grants.length > 50) throw validationError('A key takes at most 50 roles');
  for (const grant of input.grants) {
    if (!(API_KEY_ROLES as readonly string[]).includes(grant.role)) {
      throw validationError(
        `A key cannot have the ${grant.role.replace('_', ' ')} role: managing users, sign-in and keys stays with people`,
      );
    }
  }
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    throw validationError('The expiry date must be in the future');
  }
  return transact(db, async (tx) => {
    const own = await tx
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.orgId, actor.orgId));
    const known = new Set(own.map((p) => p.id));
    for (const grant of input.grants) {
      if (grant.propertyId && !known.has(grant.propertyId)) {
        throw notFound('Property', grant.propertyId);
      }
    }
    const key = `${API_KEY_PREFIX}${randomToken(32)}`;
    const [row] = await tx
      .insert(apiKeys)
      .values({
        orgId: actor.orgId,
        name,
        prefix: key.slice(0, API_KEY_PREFIX.length + 6),
        keyHash: sha256Hex(key),
        grants: input.grants.map((g) => ({ role: g.role, propertyId: g.propertyId ?? null })),
        expiresAt: input.expiresAt ?? null,
        createdBy: actor.userId ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: row!.id,
      summary: `Created the API key "${name}"`,
      changes: { grants: row!.grants, expiresAt: row!.expiresAt },
    });
    return { key, apiKey: view(row!, await nameOf(tx, row!.createdBy)) };
  });
}

export async function listApiKeys(db: DbOrTx, orgId: string): Promise<ApiKeyView[]> {
  const rows = await db
    .select({ key: apiKeys, createdByName: users.name })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdBy))
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((row) => view(row.key, row.createdByName));
}

/** Stops a key working at once. It stays in the list, so the audit trail still makes sense. */
export async function revokeApiKey(db: DbOrTx, actor: Actor, keyId: string): Promise<ApiKeyView> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, actor.orgId)))
      .for('update');
    if (!before) throw notFound('API key', keyId);
    // Revoking twice is one revocation: nothing changes and nothing new is recorded.
    if (before.revokedAt) return view(before, await nameOf(tx, before.createdBy));
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, keyId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: keyId,
      summary: `Revoked the API key "${before.name}"`,
    });
    return view(row!, await nameOf(tx, before.createdBy));
  });
}

export interface ResolvedApiKey {
  id: string;
  orgId: string;
  name: string;
  grants: Grant[];
}

/** How stale "last used" may be: one write a minute for each key, however busy it is. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** The key behind a bearer token, or null when it is unknown, revoked or expired. */
export async function resolveApiKey(
  db: DbOrTx,
  key: string,
  now: Date = new Date(),
): Promise<ResolvedApiKey | null> {
  if (!key.startsWith(API_KEY_PREFIX) || key.length > 200) return null;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256Hex(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  }
  return { id: row.id, orgId: row.orgId, name: row.name, grants: row.grants };
}
