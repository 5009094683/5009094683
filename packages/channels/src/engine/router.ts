import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '@pms/db';
import { ARI_ADAPTER_KINDS } from '../adapter';

export interface RoutedEvent {
  id: number;
  kind: string;
  orgId: string;
  propertyId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RouteResult {
  /** Outbox rows taken and removed. */
  routed: number;
  /** Rows written to per-connection work lists. */
  queued: number;
  /** Events other than availability and rates, for consumers such as outbound webhooks. */
  entityEvents: RoutedEvent[];
}

export interface RouteOptions {
  /**
   * Receives the events other than availability and rates, inside the
   * transaction that removes them from the outbox. Whatever it writes (for
   * example deliveries to outbound webhooks) commits together with that
   * removal, so an event is never dropped between the two.
   */
  onEntityEvents?(tx: Transaction, events: RoutedEvent[]): Promise<void>;
}

const BATCH = 500;

/**
 * Moves committed changes from the outbox to the work list of every
 * connection that must hear about them.
 *
 * The outbox rows are consumed by deleting them, inside the transaction that
 * writes the work-list rows. A row is therefore either still in the outbox or
 * fully fanned out, never half-processed, and nothing depends on reading
 * rows in id order (ids are assigned before commit, so order is not reliable).
 * `SKIP LOCKED` lets several workers route at once without waiting.
 *
 * Connections that are paused, disabled or still being set up are skipped:
 * turning a connection on always starts with a full sync, which covers
 * everything that changed while it was off.
 */
export async function routeOutbox(db: Database, options: RouteOptions = {}): Promise<RouteResult> {
  const result: RouteResult = { routed: 0, queued: 0, entityEvents: [] };
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const { rows: taken } = await tx.execute<{
        id: string;
        kind: string;
        org_id: string;
        property_id: string | null;
        payload: Record<string, unknown>;
        created_at: string;
      }>(sql`
        DELETE FROM outbox
        WHERE id IN (SELECT id FROM outbox ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, org_id, property_id, payload, created_at::text
      `);
      if (taken.length === 0) return { taken: 0, queued: 0, entityEvents: [] as RoutedEvent[] };

      const ari = taken.filter(
        (r) => r.kind === 'ari.availability' || r.kind === 'ari.restrictions',
      );
      let queued = 0;
      if (ari.length > 0) {
        const changes = ari.map((r) => ({
          kind: r.kind === 'ari.availability' ? 'availability' : 'restrictions',
          property_id: r.property_id,
          room_type_id: r.payload.roomTypeId,
          rate_plan_id: r.payload.ratePlanId ?? null,
          date_from: r.payload.from,
          date_to: r.payload.to,
          changed_at: r.created_at,
        }));
        // Only connections that push values, are switched on, and have the
        // room type (or rate plan) mapped receive the change.
        const inserted = await tx.execute(sql`
          INSERT INTO sync_queue (connection_id, kind, room_type_id, rate_plan_id, date_from, date_to, changed_at)
          SELECT c.id, e.kind, e.room_type_id, e.rate_plan_id, e.date_from, e.date_to, e.changed_at
          FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS e(
                 kind text, property_id uuid, room_type_id uuid, rate_plan_id uuid,
                 date_from date, date_to date, changed_at timestamptz)
          JOIN channel_connections c
            ON c.property_id = e.property_id AND c.status IN ('active', 'error')
           AND c.adapter IN (${sql.join(
             ARI_ADAPTER_KINDS.map((k) => sql`${k}`),
             sql`, `,
           )})
          WHERE (e.kind = 'availability' AND EXISTS (
                   SELECT 1 FROM channel_room_mappings m
                   WHERE m.connection_id = c.id AND m.room_type_id = e.room_type_id))
             OR (e.kind = 'restrictions' AND EXISTS (
                   SELECT 1 FROM channel_rate_mappings m
                   WHERE m.connection_id = c.id AND m.rate_plan_id = e.rate_plan_id))
        `);
        queued = inserted.rowCount ?? 0;
      }
      const entityEvents = taken
        .filter((r) => !r.kind.startsWith('ari.'))
        .map((r) => ({
          id: Number(r.id),
          kind: r.kind,
          orgId: r.org_id,
          propertyId: r.property_id,
          payload: r.payload,
          createdAt: r.created_at,
        }));
      if (entityEvents.length > 0 && options.onEntityEvents) {
        await options.onEntityEvents(tx, entityEvents);
      }
      return { taken: taken.length, queued, entityEvents };
    });
    result.routed += batch.taken;
    result.queued += batch.queued;
    result.entityEvents.push(...batch.entityEvents);
    if (batch.taken < BATCH) return result;
  }
}
