import { sql } from 'drizzle-orm';
import type { Database } from '@pms/db';
import { parsePgTimestamp, raiseAlert, resolveAlert } from '@pms/domain';
import { ARI_ADAPTER_KINDS } from '../adapter';

export interface WorkerIdentity {
  id: string;
  hostname?: string;
  info?: Record<string, unknown>;
}

/** Says "this worker is alive". Called every few seconds by each worker process. */
export async function recordHeartbeat(db: Database, worker: WorkerIdentity): Promise<void> {
  await db.execute(sql`
    INSERT INTO worker_heartbeats (worker_id, hostname, info)
    VALUES (${worker.id}, ${worker.hostname ?? null}, ${JSON.stringify(worker.info ?? {})}::jsonb)
    ON CONFLICT (worker_id) DO UPDATE
      SET last_seen_at = now(), hostname = EXCLUDED.hostname, info = EXCLUDED.info
  `);
}

export async function removeHeartbeat(db: Database, workerId: string): Promise<void> {
  await db.execute(sql`DELETE FROM worker_heartbeats WHERE worker_id = ${workerId}`);
}

export interface WorkerStatus {
  /** True when at least one worker reported within `staleMs`. */
  alive: boolean;
  workers: number;
  lastSeenAt: Date | null;
}

/** A worker that has not reported for this long is taken to be down. */
export const WORKER_STALE_MS = 90_000;

export async function workerStatus(
  db: Database,
  now: Date = new Date(),
  staleMs: number = WORKER_STALE_MS,
): Promise<WorkerStatus> {
  const { rows } = await db.execute<{ live: number; last_seen: string | null }>(sql`
    SELECT count(*) FILTER (
             WHERE last_seen_at > ${now.toISOString()}::timestamptz - make_interval(secs => ${staleMs / 1000})
           )::int AS live,
           max(last_seen_at)::text AS last_seen
    FROM worker_heartbeats
  `);
  const row = rows[0];
  return {
    alive: (row?.live ?? 0) > 0,
    workers: row?.live ?? 0,
    lastSeenAt: parsePgTimestamp(row?.last_seen ?? null),
  };
}

const workerDownKey = (orgId: string): string => `worker_down:${orgId}`;

/**
 * Raises an alert in every organisation with live connections when no worker
 * is running, and clears it when one is. Run from the API (which is still up
 * when the worker is not) as well as from the worker.
 */
export async function checkWorkerLiveness(
  db: Database,
  now: Date = new Date(),
): Promise<WorkerStatus> {
  const status = await workerStatus(db, now);
  if (status.alive) {
    const { rows } = await db.execute<{ org_id: string }>(sql`
      SELECT DISTINCT org_id FROM alerts WHERE dedupe_key LIKE 'worker_down:%' AND status <> 'resolved'
    `);
    for (const { org_id } of rows) await resolveAlert(db, org_id, workerDownKey(org_id));
    return status;
  }
  const { rows } = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT org_id FROM channel_connections WHERE status IN ('active', 'error')
  `);
  for (const { org_id } of rows) {
    await raiseAlert(db, {
      orgId: org_id,
      kind: 'sync_failure',
      severity: 'critical',
      title: 'Channel sync has stopped: the sync worker is not running',
      body:
        'Nothing is being sent to or fetched from the booking channels. ' +
        (status.lastSeenAt
          ? `The worker last reported at ${status.lastSeenAt.toISOString()}.`
          : 'No worker has reported yet.') +
        ' Start the worker process; everything queued in the meantime is sent as soon as it is up.',
      dedupeKey: workerDownKey(org_id),
    });
  }
  return status;
}

/** Changes waiting longer than this to reach a channel are reported. */
export const SYNC_LAG_ALERT_MS = 10 * 60_000;

/**
 * Raises an alert for connections whose oldest unsent change has waited too
 * long, and clears it once they catch up. A failing connection has its own
 * alert already; this one catches "nothing is failing, yet nothing is moving".
 */
export async function checkSyncLag(
  db: Database,
  now: Date = new Date(),
  thresholdMs: number = SYNC_LAG_ALERT_MS,
): Promise<{ lagging: string[] }> {
  const { rows } = await db.execute<{
    id: string;
    org_id: string;
    property_id: string;
    name: string;
    property_name: string;
    pending: number;
    oldest: string | null;
    has_alert: boolean;
  }>(sql`
    SELECT c.id, c.org_id, c.property_id, c.name, p.name AS property_name,
           q.pending, q.oldest::text AS oldest,
           EXISTS (SELECT 1 FROM alerts a
                   WHERE a.dedupe_key = 'sync_lag:' || c.id AND a.status <> 'resolved') AS has_alert
    FROM channel_connections c
    JOIN properties p ON p.id = c.property_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS pending, min(at) AS oldest
      FROM (
        SELECT changed_at AS at FROM sync_queue s WHERE s.connection_id = c.id
        UNION ALL
        -- Committed changes nobody has picked up yet count as waiting too.
        SELECT created_at FROM outbox o
        WHERE o.property_id = c.property_id AND o.kind IN ('ari.availability', 'ari.restrictions')
      ) waiting
    ) q ON true
    WHERE c.adapter IN (${sql.join(
      ARI_ADAPTER_KINDS.map((k) => sql`${k}`),
      sql`, `,
    )})
      AND c.status IN ('active', 'error')
  `);
  const lagging: string[] = [];
  for (const row of rows) {
    const oldest = parsePgTimestamp(row.oldest);
    const lagMs = oldest ? now.getTime() - oldest.getTime() : 0;
    if (lagMs > thresholdMs) {
      lagging.push(row.id);
      await raiseAlert(db, {
        orgId: row.org_id,
        propertyId: row.property_id,
        kind: 'sync_lag',
        severity: 'warning',
        title: `${row.property_name}: changes are slow to reach the booking channels`,
        body: `${row.pending} change(s) are waiting; the oldest has waited ${Math.round(lagMs / 60_000)} minutes. Availability on the channels may be out of date.`,
        entityType: 'channel_connection',
        entityId: row.id,
        dedupeKey: `sync_lag:${row.id}`,
        metadata: { pending: row.pending, lagMs },
      });
    } else if (row.has_alert) {
      await resolveAlert(db, row.org_id, `sync_lag:${row.id}`);
    }
  }
  return { lagging };
}

/** How long the contents of a booking message that led to no reservation are kept. */
export const UNUSED_MESSAGE_DAYS = 90;

/** Removes sync history older than the given age. Returns rows removed or emptied. */
export async function pruneSyncHistory(db: Database, olderThanDays = 30): Promise<number> {
  const log = await db.execute(
    sql`DELETE FROM sync_log WHERE created_at < now() - make_interval(days => ${olderThanDays})`,
  );
  const hooks = await db.execute(
    sql`DELETE FROM webhook_events WHERE received_at < now() - make_interval(days => ${olderThanDays})`,
  );
  const beats = await db.execute(
    sql`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`,
  );
  // A booking message that never became a reservation (it could not be read, or its room was
  // never mapped) has nobody's profile to share the fate of. Its contents, which name a
  // guest, are dropped once nobody is going to act on it; the row stays, so that the same
  // message arriving again is still recognised.
  const stale = await db.execute(sql`
    UPDATE booking_revisions
    SET raw = '{"erased": true}'::jsonb,
        event = jsonb_build_object('bookingId', event->'bookingId', 'status', event->'status'),
        next_attempt_at = NULL
    WHERE reservation_id IS NULL
      AND received_at < now() - make_interval(days => ${UNUSED_MESSAGE_DAYS})
      AND raw <> '{"erased": true}'::jsonb
  `);
  return (
    (log.rowCount ?? 0) + (hooks.rowCount ?? 0) + (beats.rowCount ?? 0) + (stale.rowCount ?? 0)
  );
}
