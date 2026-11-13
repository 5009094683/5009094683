import type { Env } from '@pms/config';
import type { Database } from '@pms/db';
import {
  CHANNEL_JOBS,
  checkDrift,
  importBookings,
  pruneSyncHistory,
  pullConnection,
} from '@pms/channels';
import { pruneJobs, type JobRow } from '@pms/domain';
import type { Logger } from './logger';

export interface JobContext {
  db: Database;
  env: Env;
  log: Logger;
}

/**
 * Background work, by job kind. A handler that throws has its job retried with
 * backoff until the job's attempts run out. Whatever a handler returns is kept
 * on the finished job for diagnosis.
 */
export type JobHandler = (
  payload: Record<string, unknown>,
  context: JobContext,
  job: JobRow,
) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export function jobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}

export function jobKinds(): string[] {
  return [...handlers.keys()];
}

export const JOBS = {
  channelPull: CHANNEL_JOBS.pull,
  driftCheck: CHANNEL_JOBS.driftCheck,
  importBookings: CHANNEL_JOBS.importBookings,
  prune: 'maintenance.prune',
} as const;

registerJobHandler(JOBS.channelPull, async (payload, { db }) => {
  const result = await pullConnection(
    db,
    String(payload.connectionId),
    payload.via === 'webhook' ? 'webhook' : 'poll',
  );
  // Throwing hands the retry schedule to the job queue: a booking announced by webhook is fetched again soon.
  if (result.outcome === 'failed') throw new Error(result.error ?? 'Could not fetch bookings');
  return {
    outcome: result.outcome,
    received: result.received,
    fresh: result.fresh,
    failed: result.results.filter((r) => r.status === 'failed').length,
  };
});

registerJobHandler(JOBS.driftCheck, async (payload, { db, env }) => {
  const result = await checkDrift(db, String(payload.connectionId), {
    days: env.SYNC_DRIFT_CHECK_DAYS,
    confirmDelayMs: env.isTest ? 0 : 5_000,
  });
  if (result.outcome === 'failed') throw new Error(result.error ?? 'Could not read the channel');
  return { outcome: result.outcome, compared: result.compared, drifted: result.drifted };
});

registerJobHandler(JOBS.importBookings, async (payload, { db }) => {
  const result = await importBookings(db, String(payload.connectionId));
  return { ...result };
});

registerJobHandler(JOBS.prune, async (_payload, { db }) => {
  const jobs = await pruneJobs(db);
  const history = await pruneSyncHistory(db);
  return { jobs, history };
});
