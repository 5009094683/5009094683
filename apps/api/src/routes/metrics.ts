import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { safeEqual } from '@pms/domain';

/** Upper bounds of the request-duration buckets, in seconds. */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

const label = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Figures for a monitoring system, in the Prometheus text format: how the API
 * is answering, and how far behind the background work is. Served only to a
 * caller that presents METRICS_TOKEN; without that setting the route answers
 * as if it did not exist.
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  const requests = new Map<string, Series>();

  app.addHook('onResponse', async (req, reply) => {
    // The route as declared, not the address asked for: ids would make every request its own series.
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/metrics' || route === '/health' || route === '/ready') return;
    const key = `${req.method} ${route} ${Math.floor(reply.statusCode / 100)}xx`;
    let series = requests.get(key);
    if (!series) {
      if (requests.size > 2_000) return;
      series = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      requests.set(key, series);
    }
    const seconds = reply.elapsedTime / 1000;
    series.count++;
    series.sum += seconds;
    BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) series.buckets[i]!++;
    });
  });

  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const token = app.env.METRICS_TOKEN;
    const given = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !given || !safeEqual(given, token)) {
      return reply.status(404).send({
        error: { code: 'not_found', message: 'No route for GET /metrics', requestId: req.id },
      });
    }

    const { rows } = await app.db.execute<{ name: string; labels: string | null; value: string }>(
      sql`
        SELECT 'pms_outbox_pending' AS name, NULL AS labels, count(*)::text AS value FROM outbox
        UNION ALL
        SELECT 'pms_outbox_oldest_seconds', NULL,
          coalesce(extract(epoch FROM now() - min(created_at)), 0)::text FROM outbox
        UNION ALL
        SELECT 'pms_sync_queue_pending', NULL, count(*)::text FROM sync_queue
        UNION ALL
        SELECT 'pms_sync_queue_oldest_seconds', NULL,
          coalesce(extract(epoch FROM now() - min(changed_at)), 0)::text FROM sync_queue
        UNION ALL
        SELECT 'pms_jobs', 'status="' || status || '"', count(*)::text FROM jobs
          WHERE status IN ('pending', 'running') OR finished_at > now() - interval '24 hours'
          GROUP BY status
        UNION ALL
        SELECT 'pms_jobs_overdue_seconds', NULL,
          coalesce(extract(epoch FROM now() - min(run_at)), 0)::text FROM jobs
          WHERE status = 'pending' AND run_at <= now()
        UNION ALL
        SELECT 'pms_alerts_open', 'severity="' || severity || '"', count(*)::text FROM alerts
          WHERE status <> 'resolved' GROUP BY severity
        UNION ALL
        SELECT 'pms_channel_connections', 'status="' || status || '"', count(*)::text
          FROM channel_connections GROUP BY status
        UNION ALL
        SELECT 'pms_booking_revisions_waiting', NULL, count(*)::text FROM booking_revisions
          WHERE status IN ('received', 'unmapped', 'failed')
        UNION ALL
        SELECT 'pms_webhook_deliveries', 'status="' || status || '"', count(*)::text
          FROM webhook_deliveries WHERE status = 'pending' OR created_at > now() - interval '24 hours'
          GROUP BY status
        UNION ALL
        SELECT 'pms_workers_alive', NULL, count(*)::text FROM worker_heartbeats
          WHERE last_seen_at > now() - interval '1 minute'
        UNION ALL
        SELECT 'pms_worker_last_seen_seconds', NULL,
          coalesce(extract(epoch FROM now() - max(last_seen_at)), -1)::text FROM worker_heartbeats
      `,
    );

    const help: Record<string, string> = {
      pms_outbox_pending: 'Committed changes not yet handed to the channel work lists',
      pms_outbox_oldest_seconds: 'Age of the oldest such change',
      pms_sync_queue_pending: 'Changes waiting to be pushed to a channel',
      pms_sync_queue_oldest_seconds: 'Age of the oldest change waiting to be pushed',
      pms_jobs: 'Background jobs waiting or running, and those finished in the last 24 hours',
      pms_jobs_overdue_seconds: 'How long the most overdue job has been waiting',
      pms_alerts_open: 'Alerts that have not been resolved',
      pms_channel_connections: 'Channel connections by state',
      pms_booking_revisions_waiting: 'Bookings from channels not yet applied',
      pms_webhook_deliveries: 'Outbound webhook deliveries waiting, and those of the last 24 hours',
      pms_workers_alive: 'Workers heard from in the last minute',
      pms_worker_last_seen_seconds: 'Seconds since any worker was last heard from (-1: never)',
    };
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.name)) {
        seen.add(row.name);
        lines.push(`# HELP ${row.name} ${help[row.name] ?? ''}`, `# TYPE ${row.name} gauge`);
      }
      lines.push(`${row.name}${row.labels ? `{${row.labels}}` : ''} ${row.value}`);
    }

    lines.push(
      '# HELP pms_http_request_duration_seconds How long requests took, by route',
      '# TYPE pms_http_request_duration_seconds histogram',
    );
    for (const [key, series] of requests) {
      const [method, route, status] = key.split(' ') as [string, string, string];
      const labels = `method="${method}",route="${label(route)}",status="${status}"`;
      BUCKETS.forEach((bound, i) => {
        lines.push(
          `pms_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${series.buckets[i]}`,
        );
      });
      lines.push(
        `pms_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${series.count}`,
        `pms_http_request_duration_seconds_sum{${labels}} ${series.sum.toFixed(6)}`,
        `pms_http_request_duration_seconds_count{${labels}} ${series.count}`,
      );
    }

    const memory = process.memoryUsage();
    lines.push(
      '# HELP pms_live_connections Browsers connected for live updates',
      '# TYPE pms_live_connections gauge',
      `pms_live_connections ${app.live.connections}`,
      '# HELP process_resident_memory_bytes Resident memory of the API process',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${memory.rss}`,
      '# HELP process_uptime_seconds How long the API process has been running',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${Math.round(process.uptime())}`,
    );
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(`${lines.join('\n')}\n`);
  });
}
