import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { inventoryBlocks, properties, reservations, type Database } from '@pms/db';
import { forbidden, notFound, propertyScope, type Actor, type Permission } from '@pms/domain';
import { authorize } from '../plugins/auth';

/**
 * The properties a request may act on with `permission`, optionally narrowed
 * to the ones it asked for. Asking for a property outside the caller's scope
 * is refused rather than silently dropped.
 */
export function scopedProperties(
  req: FastifyRequest,
  permission: Permission,
  requested?: string[],
): { actor: Actor; propertyIds: string[] | 'all' } {
  const actor = authorize(req, permission);
  const scope = propertyScope(actor.grants, permission);
  if (!requested || requested.length === 0) return { actor, propertyIds: scope };
  if (scope !== 'all' && requested.some((id) => !scope.includes(id))) throw forbidden();
  return { actor, propertyIds: requested };
}

/** Authorises an action on a reservation by the property it belongs to. */
export async function authorizeReservation(
  db: Database,
  req: FastifyRequest,
  reservationId: string,
  permission: Permission,
): Promise<{ actor: Actor; propertyId: string }> {
  const session = authorize(req);
  const [row] = await db
    .select({ propertyId: reservations.propertyId })
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, session.orgId)));
  if (!row) throw notFound('Reservation', reservationId);
  return { actor: authorize(req, permission, row.propertyId), propertyId: row.propertyId };
}

export async function authorizeBlock(
  db: Database,
  req: FastifyRequest,
  blockId: string,
  permission: Permission,
): Promise<{ actor: Actor; propertyId: string }> {
  const session = authorize(req);
  const [row] = await db
    .select({ propertyId: inventoryBlocks.propertyId })
    .from(inventoryBlocks)
    .innerJoin(properties, eq(properties.id, inventoryBlocks.propertyId))
    .where(and(eq(inventoryBlocks.id, blockId), eq(properties.orgId, session.orgId)));
  if (!row) throw notFound('Block', blockId);
  return { actor: authorize(req, permission, row.propertyId), propertyId: row.propertyId };
}

/**
 * Authorises an action on a property named in the URL. The organisation check
 * matters because a role granted on "all properties" is not tied to an id.
 */
export async function authorizeProperty(
  db: Database,
  req: FastifyRequest,
  propertyId: string,
  permission: Permission,
): Promise<Actor> {
  const session = authorize(req);
  const [row] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, session.orgId)));
  if (!row) throw notFound('Property', propertyId);
  return authorize(req, permission, propertyId);
}
