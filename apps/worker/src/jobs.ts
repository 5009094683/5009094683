import type { Env } from '@pms/config';
import type { Database } from '@pms/db';
import {
  CHANNEL_JOBS,
  checkDrift,
  importBookings,
  pruneSyncHistory,
  pullConnection,
  pullThread,
  queueStaleThreads,
} from '@pms/channels';
import {
  deliverMessage,
  MESSAGE_JOBS,
  pruneJobs,
  purgeExpiredFiles,
  type FileStore,
  type JobRow,
} from '@pms/domain';
import type { Logger } from './logger';

export interface JobContext {
  db: Database;
  env: Env;
  log: Logger;
  files: FileStore;
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
  pullMessages: CHANNEL_JOBS.pullMessages,
  sendMessage: MESSAGE_JOBS.send,
  prune: 'maintenance.prune',
} as const;

registerJobHandler(JOBS.channelPull, async (payload, { db, log }) => {
  const connectionId = String(payload.connectionId);
  const result = await pullConnection(
    db,
    connectionId,
    payload.via === 'webhook' ? 'webhook' : 'poll',
  );
  // Throwing hands the retry schedule to the job queue: a booking announced by webhook is fetched again soon.
  if (result.outcome === 'failed') throw new Error(result.error ?? 'Could not fetch bookings');
  // The regular check also looks for guest messages no webhook announced.
  let threads = 0;
  if (payload.via !== 'webhook') {
    try {
      threads = (await queueStaleThreads(db, connectionId)).queued;
    } catch (err) {
      log.warn({ err, connectionId }, 'could not look for new guest messages');
    }
  }
  return {
    outcome: result.outcome,
    received: result.received,
    fresh: result.fresh,
    failed: result.results.filter((r) => r.status === 'failed').length,
    threads,
  };
});

registerJobHandler(JOBS.pullMessages, async (payload, { db }) => {
  const result = await pullThread(db, String(payload.connectionId), String(payload.threadId));
  return { ...result };
});

registerJobHandler(JOBS.sendMessage, async (payload, { db }, job) => {
  // On the last attempt the message is marked failed and staff are told, instead of the job failing quietly.
  const outcome = await deliverMessage(db, String(payload.messageId), {
    finalAttempt: job.attempts >= job.maxAttempts,
  });
  return { ...outcome };
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

registerJobHandler(JOBS.prune, async (_payload, { db, files }) => {
  const jobs = await pruneJobs(db);
  const history = await pruneSyncHistory(db);
  const removedFiles = await purgeExpiredFiles(db, files);
  return { jobs, history, removedFiles };
});
