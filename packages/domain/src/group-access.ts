import { and, eq } from 'drizzle-orm';
import { properties, reservationGroups, type DbOrTx } from '@pms/db';
import { invalidState, notFound, validationError } from './errors';

export type GroupRow = typeof reservationGroups.$inferSelect;

/** A group of the organisation, with what its property says about money and time. */
export async function groupOf(
  db: DbOrTx,
  orgId: string,
  groupId: string,
  lock = false,
): Promise<{ group: GroupRow; currency: string; timezone: string }> {
  const query = db
    .select({ group: reservationGroups, currency: properties.currency, tz: properties.timezone })
    .from(reservationGroups)
    .innerJoin(properties, eq(properties.id, reservationGroups.propertyId))
    .where(and(eq(reservationGroups.id, groupId), eq(properties.orgId, orgId)));
  const [row] = lock ? await query.for('update', { of: reservationGroups }) : await query;
  if (!row) throw notFound('Group', groupId);
  return { group: row.group, currency: row.currency, timezone: row.tz };
}

/**
 * Checks that a booking may join the group: it is at the same property and
 * the event has not been called off.
 */
export async function requireOpenGroup(
  db: DbOrTx,
  orgId: string,
  groupId: string,
  propertyId: string,
): Promise<GroupRow> {
  const { group } = await groupOf(db, orgId, groupId);
  if (group.propertyId !== propertyId) {
    throw validationError('This group is at another property');
  }
  if (group.status === 'cancelled') {
    throw invalidState(`${group.name} has been cancelled, so it cannot take bookings`);
  }
  return group;
}
