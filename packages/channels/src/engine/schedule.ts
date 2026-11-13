import { sql } from 'drizzle-orm';
import type { Database } from '@pms/db';
import { ARI_ADAPTER_KINDS } from '../adapter';

export interface FullSyncSchedule {
  /** Local hour (at the property) from which the nightly restatement may start. */
  fromHour: number;
  /** Local hour by which it must have started. */
  toHour: number;
  /** Connections started per call. Calls are spaced by the worker, which staggers the properties. */
  limit: number;
}

export const DEFAULT_FULL_SYNC_SCHEDULE: FullSyncSchedule = { fromHour: 2, toHour: 5, limit: 2 };

/**
 * Asks for the once-a-night restatement of the whole horizon, for connections
 * whose property is in its small hours and that have not had one in the last
 * 20 hours.
 *
 * Changes are always pushed as they happen; this is the safety net under
 * them. It is deliberately limited to once a day, off-peak, a few properties
 * at a time, which is what channel managers ask of a PMS.
 */
export async function requestDueFullSyncs(
  db: Database,
  now: Date = new Date(),
  schedule: FullSyncSchedule = DEFAULT_FULL_SYNC_SCHEDULE,
): Promise<string[]> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const { rows } = await db.execute<{ id: string }>(sql`
    UPDATE channel_connections SET full_sync_requested_at = ${at}
    WHERE id IN (
      SELECT c.id FROM channel_connections c
      JOIN properties p ON p.id = c.property_id
      WHERE c.status = 'active'
        AND c.adapter IN (${sql.join(
          ARI_ADAPTER_KINDS.map((k) => sql`${k}`),
          sql`, `,
        )})
        AND c.full_sync_requested_at IS NULL
        AND (c.last_full_sync_at IS NULL OR c.last_full_sync_at < ${at} - interval '20 hours')
        AND extract(hour FROM ${at} AT TIME ZONE p.timezone) >= ${schedule.fromHour}
        AND extract(hour FROM ${at} AT TIME ZONE p.timezone) < ${schedule.toHour}
      ORDER BY c.last_full_sync_at NULLS FIRST
      LIMIT ${schedule.limit}
      FOR UPDATE OF c SKIP LOCKED
    )
    RETURNING id
  `);
  return rows.map((r) => r.id);
}
