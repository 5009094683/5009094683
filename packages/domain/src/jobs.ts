import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@pms/db';
import { parsePgTimestamp } from './sqlx';

export interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /**
   * At most one pending or running job per key. Enqueueing again while one
   * exists is a no-op, which lets every worker instance schedule the same
   * recurring work without duplicating it.
   */
  uniqueKey?: string;
}

/** Queues background work. Returns false when a job with the same unique key is already waiting. */
export async function enqueueJob(
  db: DbOrTx,
  kind: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO jobs (kind, payload, run_at, max_attempts, unique_key)
    VALUES (${kind}, ${JSON.stringify(payload)}::jsonb, ${(options.runAt ?? new Date()).toISOString()}::timestamptz,
            ${options.maxAttempts ?? 5}, ${options.uniqueKey ?? null})
    ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending', 'running') DO NOTHING
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Queues work that should happen about once per period, from any number of
 * worker instances: nothing is queued while a job of this kind and key is
 * waiting, running, or was queued within the period.
 */
export async function enqueueRecurring(
  db: DbOrTx,
  kind: string,
  everyMs: number,
  payload: Record<string, unknown> = {},
  options: { key?: string; maxAttempts?: number; now?: Date } = {},
): Promise<boolean> {
  const key = options.key ?? kind;
  const now = (options.now ?? new Date()).toISOString();
  const result = await db.execute(sql`
    INSERT INTO jobs (kind, payload, run_at, max_attempts, unique_key)
    SELECT ${kind}, ${JSON.stringify(payload)}::jsonb, ${now}::timestamptz, ${options.maxAttempts ?? 1}, ${key}
    WHERE NOT EXISTS (
      SELECT 1 FROM jobs
      WHERE unique_key = ${key}
        AND (status IN ('pending', 'running')
             OR created_at > ${now}::timestamptz - make_interval(secs => ${everyMs / 1000}))
    )
    ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending', 'running') DO NOTHING
  `);
  return (result.rowCount ?? 0) > 0;
}

/** A job left "running" this long belonged to a worker that died; it is handed out again. */
const STALE_AFTER_MINUTES = 15;

/**
 * Takes up to `limit` due jobs for this worker. `FOR UPDATE SKIP LOCKED`
 * means two workers never take the same job and never wait on each other.
 */
export async function claimJobs(
  db: DbOrTx,
  workerId: string,
  limit: number,
  kinds?: string[],
): Promise<JobRow[]> {
  const kindFilter = kinds?.length
    ? sql`AND kind IN (${sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;
  const { rows } = await db.execute<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
    run_at: string;
  }>(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs
      WHERE ((status = 'pending' AND run_at <= now())
          OR (status = 'running' AND locked_at < now() - make_interval(mins => ${STALE_AFTER_MINUTES})))
        ${kindFilter}
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, attempts, max_attempts, run_at
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: parsePgTimestamp(r.run_at)!,
  }));
}

export async function completeJob(
  db: DbOrTx,
  jobId: number,
  result?: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL,
                    result = ${result ? JSON.stringify(result) : null}::jsonb
    WHERE id = ${jobId}
  `);
}

/** Records a failure. The job is retried with exponential backoff until its attempts run out. */
export async function failJob(
  db: DbOrTx,
  job: JobRow,
  error: unknown,
): Promise<{ willRetry: boolean }> {
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = job.attempts < job.maxAttempts;
  const delaySeconds = Math.min(3600, 15 * 2 ** (job.attempts - 1));
  await db.execute(sql`
    UPDATE jobs
    SET status = ${willRetry ? 'pending' : 'failed'},
        run_at = CASE WHEN ${willRetry} THEN now() + make_interval(secs => ${delaySeconds}) ELSE run_at END,
        finished_at = CASE WHEN ${willRetry} THEN NULL ELSE now() END,
        locked_at = NULL, locked_by = NULL,
        last_error = ${message.slice(0, 2000)}
    WHERE id = ${job.id}
  `);
  return { willRetry };
}

/** Removes finished jobs older than the given age so the table does not grow without bound. */
export async function pruneJobs(db: DbOrTx, olderThanDays = 14): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM jobs
    WHERE status IN ('done', 'failed') AND finished_at < now() - make_interval(days => ${olderThanDays})
  `);
  return result.rowCount ?? 0;
}
