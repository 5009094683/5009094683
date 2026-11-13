import { and, desc, eq, gte, ilike, lt, lte, type SQL } from 'drizzle-orm';
import { auditLog, organizations, type Database, type OrgSettings } from '@pms/db';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { notFound, validationError } from './errors';

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  defaultCurrency: string;
  defaultTimezone: string;
  settings: OrgSettings;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: code });
    return true;
  } catch {
    return false;
  }
}

export async function getOrganization(db: Database, orgId: string): Promise<OrganizationView> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw notFound('Organisation', orgId);
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    defaultCurrency: org.defaultCurrency,
    defaultTimezone: org.defaultTimezone,
    settings: org.settings,
  };
}

export interface UpdateOrganizationInput {
  name?: string;
  defaultCurrency?: string;
  defaultTimezone?: string;
  settings?: Partial<OrgSettings>;
}

export async function updateOrganization(
  db: Database,
  actor: Actor,
  input: UpdateOrganizationInput,
): Promise<OrganizationView> {
  if (input.defaultTimezone !== undefined && !isValidTimezone(input.defaultTimezone)) {
    throw validationError(`"${input.defaultTimezone}" is not a known time zone`);
  }
  if (input.defaultCurrency !== undefined && !isValidCurrency(input.defaultCurrency)) {
    throw validationError(`"${input.defaultCurrency}" is not a known currency code`);
  }
  const s = input.settings;
  if (
    s?.guestIdRetentionDays !== undefined &&
    (s.guestIdRetentionDays < 0 || s.guestIdRetentionDays > 3650)
  ) {
    throw validationError('Identity document retention must be between 0 and 3650 days');
  }
  if (
    s?.guestProfileRetentionDays !== undefined &&
    (s.guestProfileRetentionDays < 0 || s.guestProfileRetentionDays > 36500)
  ) {
    throw validationError('Guest profile retention must be between 0 and 36500 days');
  }

  await db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, actor.orgId))
      .for('update');
    if (!org) throw notFound('Organisation', actor.orgId);
    const next = {
      name: input.name?.trim() || org.name,
      defaultCurrency: input.defaultCurrency ?? org.defaultCurrency,
      defaultTimezone: input.defaultTimezone ?? org.defaultTimezone,
      settings: { ...org.settings, ...(input.settings ?? {}) },
    };
    const changes = diff(org as unknown as Record<string, unknown>, next);
    if (Object.keys(changes).length === 0) return;
    await tx.update(organizations).set(next).where(eq(organizations.id, org.id));
    await writeAudit(tx, actor, {
      action: 'org.updated',
      entityType: 'organization',
      entityId: org.id,
      summary: 'Updated organisation settings',
      changes,
    });
  });
  return getOrganization(db, actor.orgId);
}

export interface AuditFilter {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  propertyId?: string;
  /** Matches the start of the action name, e.g. "reservation." */
  actionPrefix?: string;
  from?: Date;
  to?: Date;
  /** Return entries older than this id (keyset pagination). */
  beforeId?: number;
  limit?: number;
}

export async function listAuditLog(db: Database, orgId: string, filter: AuditFilter = {}) {
  const conditions: SQL[] = [eq(auditLog.orgId, orgId)];
  if (filter.entityType) conditions.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditLog.entityId, filter.entityId));
  if (filter.actorUserId) conditions.push(eq(auditLog.actorUserId, filter.actorUserId));
  if (filter.propertyId) conditions.push(eq(auditLog.propertyId, filter.propertyId));
  if (filter.actionPrefix) {
    conditions.push(ilike(auditLog.action, `${filter.actionPrefix.replace(/[%_\\]/g, '\\$&')}%`));
  }
  if (filter.from) conditions.push(gte(auditLog.at, filter.from));
  if (filter.to) conditions.push(lte(auditLog.at, filter.to));
  if (filter.beforeId) conditions.push(lt(auditLog.id, filter.beforeId));
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    entries: page,
    nextBeforeId: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
