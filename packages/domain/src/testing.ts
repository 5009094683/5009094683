import { organizations, roleAssignments, users, type Database, type Role } from '@pms/db';
import type { Actor, Grant } from './context';
import { hashPassword } from './auth/passwords';

export { startMockOidcProvider, type MockOidcProvider } from './testing/mock-oidc';

export const TEST_PASSWORD = 'correct horse battery staple';

let cachedHash: Promise<string> | undefined;

/** One scrypt hash shared by all fixtures; hashing per user would dominate test time. */
function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export interface TestOrg {
  orgId: string;
  adminUserId: string;
  admin: Actor;
}

export async function createTestOrg(db: Database, name = 'Test Hotels'): Promise<TestOrg> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizations).values({ name, slug }).returning();
  const user = await createTestUser(db, org!.id, {
    email: `admin-${slug}@example.com`,
    grants: [{ role: 'org_admin', propertyId: null }],
  });
  return { orgId: org!.id, adminUserId: user.id, admin: user.actor };
}

export async function createTestUser(
  db: Database,
  orgId: string,
  options: {
    email?: string;
    name?: string;
    grants?: Grant[];
    role?: Role;
    propertyId?: string | null;
  } = {},
): Promise<{ id: string; email: string; actor: Actor }> {
  const email = options.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const grants =
    options.grants ??
    (options.role ? [{ role: options.role, propertyId: options.propertyId ?? null }] : []);
  const [user] = await db
    .insert(users)
    .values({
      orgId,
      email,
      name: options.name ?? 'Test User',
      status: 'active',
      passwordHash: await testPasswordHash(),
    })
    .returning();
  if (grants.length > 0) {
    await db
      .insert(roleAssignments)
      .values(grants.map((g) => ({ userId: user!.id, role: g.role, propertyId: g.propertyId })));
  }
  return {
    id: user!.id,
    email,
    actor: { type: 'user', orgId, userId: user!.id, label: email, grants },
  };
}
