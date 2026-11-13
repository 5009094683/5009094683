import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alerts, type AlertSeverity, type AlertStatus, type DbOrTx } from '@pms/db';
import type { Actor } from './context';
import { notFound } from './errors';
import { emit } from './outbox';

export type AlertKind =
  | 'overbooking'
  | 'sync_failure'
  | 'sync_lag'
  | 'sync_drift'
  | 'channel_disconnected'
  | 'unmapped_booking'
  | 'unacknowledged_booking'
  | 'booking_needs_review'
  | 'inbound_failure'
  | 'calendar_feed_failure'
  | 'unusual_cancellations'
  | 'payment_failed'
  | 'payment_unplaced'
  | 'refund_pending'
  | 'message_failed'
  | 'night_audit'
  | 'ledger_mismatch'
  | 'owner_statements';

export interface RaiseAlertInput {
  orgId: string;
  propertyId?: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  /**
   * Identifies the condition. While an alert with this key is open, raising it
   * again updates that alert (and counts the occurrence) instead of adding one.
   */
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}

export type AlertRow = typeof alerts.$inferSelect;

export async function raiseAlert(
  tx: DbOrTx,
  input: RaiseAlertInput,
): Promise<{ id: string; created: boolean }> {
  const { rows } = await tx.execute<{ id: string; created: boolean }>(sql`
    INSERT INTO alerts (org_id, property_id, kind, severity, title, body, entity_type, entity_id, dedupe_key, metadata)
    VALUES (${input.orgId}, ${input.propertyId ?? null}, ${input.kind}, ${input.severity}, ${input.title},
            ${input.body ?? null}, ${input.entityType ?? null}, ${input.entityId ?? null}, ${input.dedupeKey},
            ${JSON.stringify(input.metadata ?? {})}::jsonb)
    ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO UPDATE
      SET occurrences = alerts.occurrences + 1,
          last_seen_at = now(),
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          severity = EXCLUDED.severity,
          metadata = EXCLUDED.metadata
    RETURNING id, (xmax = 0) AS created
  `);
  const row = rows[0]!;
  if (row.created) {
    await emit(tx, input.orgId, [
      {
        kind: 'alert.raised',
        propertyId: input.propertyId ?? null,
        payload: {
          alertId: row.id,
          kind: input.kind,
          severity: input.severity,
          title: input.title,
        },
      },
    ]);
  }
  return row;
}

/** Closes the open alert for a condition that no longer holds. A no-op when none is open. */
export async function resolveAlert(tx: DbOrTx, orgId: string, dedupeKey: string): Promise<boolean> {
  const resolved = await tx
    .update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(
      and(
        eq(alerts.orgId, orgId),
        eq(alerts.dedupeKey, dedupeKey),
        sql`${alerts.status} <> 'resolved'`,
      ),
    )
    .returning({ id: alerts.id, propertyId: alerts.propertyId });
  for (const row of resolved) {
    await emit(tx, orgId, [
      { kind: 'alert.updated', propertyId: row.propertyId, payload: { alertId: row.id } },
    ]);
  }
  return resolved.length > 0;
}

export async function setAlertStatus(
  db: DbOrTx,
  actor: Actor,
  alertId: string,
  status: Exclude<AlertStatus, 'open'>,
): Promise<AlertRow> {
  const [row] = await db
    .update(alerts)
    .set(
      status === 'acknowledged'
        ? { status, acknowledgedAt: new Date(), acknowledgedBy: actor.userId ?? null }
        : { status, resolvedAt: new Date() },
    )
    .where(and(eq(alerts.id, alertId), eq(alerts.orgId, actor.orgId)))
    .returning();
  if (!row) throw notFound('Alert', alertId);
  await emit(db, actor.orgId, [
    { kind: 'alert.updated', propertyId: row.propertyId, payload: { alertId } },
  ]);
  return row;
}

export interface AlertFilter {
  status?: AlertStatus[];
  propertyIds?: string[] | 'all';
  kinds?: AlertKind[];
  limit?: number;
}

export async function listAlerts(
  db: DbOrTx,
  orgId: string,
  filter: AlertFilter = {},
): Promise<AlertRow[]> {
  const conditions: SQL[] = [eq(alerts.orgId, orgId)];
  if (filter.status?.length) conditions.push(inArray(alerts.status, filter.status));
  if (filter.kinds?.length) conditions.push(inArray(alerts.kind, filter.kinds));
  if (filter.propertyIds && filter.propertyIds !== 'all') {
    // Organisation-level alerts (no property) are visible to anyone with access to at least one property.
    conditions.push(
      filter.propertyIds.length > 0
        ? sql`(${alerts.propertyId} IS NULL OR ${inArray(alerts.propertyId, filter.propertyIds)})`
        : sql`false`,
    );
  }
  return db
    .select()
    .from(alerts)
    .where(and(...conditions))
    .orderBy(
      sql`CASE ${alerts.status} WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END`,
      sql`CASE ${alerts.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
      desc(alerts.lastSeenAt),
    )
    .limit(Math.min(filter.limit ?? 100, 500));
}
