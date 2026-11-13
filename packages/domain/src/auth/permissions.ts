import type { Role } from '@pms/db';
import type { Actor, Grant } from '../context';
import { forbidden } from '../errors';

export const PERMISSIONS = [
  /** Organisation settings, users, roles, single sign-on, API keys, webhooks. */
  'org.manage',
  'audit.read',
  'property.read',
  /** Property details, room types, units, rate plans. */
  'property.manage',
  'rates.read',
  'rates.write',
  'reservations.read',
  'reservations.write',
  /** Book past capacity, bypass restrictions, override rates. */
  'reservations.override',
  'blocks.write',
  'frontdesk.operate',
  'guests.read',
  'guests.write',
  /** See decrypted identity document numbers. */
  'guests.pii',
  'folio.read',
  'folio.write',
  'payments.refund',
  'accounting.manage',
  'nightaudit.run',
  'housekeeping.read',
  'housekeeping.write',
  'maintenance.write',
  'channels.read',
  'channels.manage',
  'inbox.read',
  'inbox.write',
  'reports.read',
  'ai.use',
  'ai.pricing.approve',
  /** Villa owners: their own units' calendar and statements only. */
  'owner.portal',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = PERMISSIONS.filter((p) => p !== 'owner.portal');

const READ_ONLY: Permission[] = [
  'property.read',
  'rates.read',
  'reservations.read',
  'guests.read',
  'folio.read',
  'housekeeping.read',
  'channels.read',
  'inbox.read',
  'reports.read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  org_admin: ALL,
  general_manager: ALL.filter((p) => p !== 'org.manage'),
  revenue_manager: [
    ...READ_ONLY,
    'rates.write',
    'reservations.write',
    'blocks.write',
    'channels.manage',
    'ai.use',
    'ai.pricing.approve',
  ],
  front_desk: [
    ...READ_ONLY,
    'reservations.write',
    'blocks.write',
    'frontdesk.operate',
    'guests.write',
    'guests.pii',
    'folio.write',
    'housekeeping.write',
    'inbox.write',
    'ai.use',
  ],
  housekeeping: ['property.read', 'reservations.read', 'housekeeping.read', 'housekeeping.write'],
  maintenance: ['property.read', 'housekeeping.read', 'maintenance.write'],
  accountant: [
    ...READ_ONLY,
    'folio.write',
    'payments.refund',
    'accounting.manage',
    'nightaudit.run',
    'audit.read',
  ],
  read_only: READ_ONLY,
  villa_owner: ['owner.portal'],
};

export const ROLE_LABELS: Record<Role, string> = {
  org_admin: 'Organisation admin',
  general_manager: 'General manager',
  revenue_manager: 'Revenue manager',
  front_desk: 'Front desk',
  housekeeping: 'Housekeeping',
  maintenance: 'Maintenance',
  accountant: 'Accountant',
  read_only: 'Read only',
  villa_owner: 'Villa owner',
};

/** Permissions that only make sense across the whole organisation. */
const ORG_WIDE: ReadonlySet<Permission> = new Set(['org.manage', 'audit.read']);

function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Whether the grants allow `permission`. With a property, a grant counts if it
 * covers that property (or all). Without one, any grant carrying the
 * permission counts, except organisation-wide permissions, which need a grant
 * that is not limited to a property.
 */
export function can(grants: Grant[], permission: Permission, propertyId?: string | null): boolean {
  return grants.some((g) => {
    if (!roleHas(g.role, permission)) return false;
    if (ORG_WIDE.has(permission)) return g.propertyId === null;
    if (propertyId) return g.propertyId === null || g.propertyId === propertyId;
    return true;
  });
}

/** Property ids the grants allow `permission` on, or 'all'. */
export function propertyScope(grants: Grant[], permission: Permission): 'all' | string[] {
  const ids = new Set<string>();
  for (const g of grants) {
    if (!roleHas(g.role, permission)) continue;
    if (g.propertyId === null) return 'all';
    ids.add(g.propertyId);
  }
  return [...ids];
}

export function requirePermission(
  actor: Actor,
  permission: Permission,
  propertyId?: string | null,
): void {
  if (actor.type === 'system' || actor.type === 'channel') return;
  if (!can(actor.grants, permission, propertyId)) throw forbidden();
}

/** Every permission the grants give on at least one property; used to shape the UI. */
export function effectivePermissions(grants: Grant[]): Permission[] {
  return PERMISSIONS.filter((p) => can(grants, p));
}
