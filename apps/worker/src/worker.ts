import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { inArray, sql } from 'drizzle-orm';
import type { Env } from '@pms/config';
import {
  channelConnections,
  listen,
  type Database,
  type DbHandle,
  type NotificationListener,
} from '@pms/db';
import {
  adapterFor,
  checkSyncLag,
  checkWorkerLiveness,
  connectionsDueForDriftCheck,
  dispatchDue,
  nextDispatchAt,
  recordHeartbeat,
  registerMessageTransports,
  removeHeartbeat,
  requestDueFullSyncs,
  retryPendingRevisions,
  routeOutbox,
  type RouteOptions,
} from '@pms/channels';
import {
  claimJobs,
  completeJob,
  createGateway,
  createMailer,
  enqueueJob,
  enqueueRecurring,
  expireHolds,
  failJob,
  isDomainError,
  LocalFileStore,
  paymentOrdersToCheck,
  runAutomations,
  runDueNightAudits,
  syncPaymentOrder,
  systemActor,
  type FileStore,
  type JobRow,
  type Mailer,
  type PaymentGateway,
} from '@pms/domain';
import { jobHandler, jobKinds, JOBS, type JobContext } from './jobs';
import { Loop } from './loop';
import type { Logger } from './logger';

export interface WorkerOptions {
  handle: DbHandle;
  env: Env;
  log: Logger;
  id?: string;
  /** Extra work done in the transaction that takes events off the outbox (outbound webhooks). */
  route?: RouteOptions;
  /** Stand-ins for the mail server, the file store and the payment gateway, for tests. */
  mailer?: Mailer;
  files?: FileStore;
  gateway?: PaymentGateway;
  /** Timings, shortened by tests. */
  timings?: Partial<Timings>;
}

interface Timings {
  /** Fallback wake-up of the sync loop when no notification arrives. */
  syncIdleMs: number;
  /** A burst of changes within this window travels as one push. */
  syncDebounceMs: number;
  /** How often delayed and retried jobs are looked for. */
  jobIdleMs: number;
  /** How often recurring work is scheduled and health is checked. */
  scheduleMs: number;
  heartbeatMs: number;
}

const DEFAULT_TIMINGS: Timings = {
  syncIdleMs: 5_000,
  syncDebounceMs: 50,
  jobIdleMs: 2_000,
  scheduleMs: 20_000,
  heartbeatMs: 10_000,
};

const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const POLL_RETRY_MS = 60_000;
const DAY_MS = 24 * 3600_000;

/**
 * The background process that keeps the channels in step with the PMS.
 *
 * Three loops share one process:
 * - sync: moves committed changes from the outbox to each connection's work
 *   list and pushes current values to the channels. Woken the moment a change
 *   commits (LISTEN/NOTIFY) and by a short timer as a safety net.
 * - jobs: runs queued background work (fetching bookings, drift checks).
 * - schedule: queues the recurring work and watches for trouble.
 *
 * Any number of workers may run side by side: every piece of work is taken
 * under a lock or a unique key, so they share it rather than repeat it.
 */
export class Worker {
  readonly id: string;
  private readonly db: Database;
  private readonly env: Env;
  private readonly log: Logger;
  private readonly timings: Timings;
  private readonly context: JobContext;
  private readonly syncLoop: Loop;
  private readonly jobLoop: Loop;
  private readonly scheduleLoop: Loop;
  private readonly active = new Set<Promise<void>>();
  private listener: NotificationListener | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date();

  constructor(private readonly options: WorkerOptions) {
    this.id = options.id ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.db = options.handle.db;
    this.env = options.env;
    this.log = options.log;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.context = {
      db: this.db,
      env: this.env,
      log: this.log,
      files: options.files ?? new LocalFileStore(this.env.STORAGE_DIR),
    };
    registerMessageTransports(this.db, this.env, options.mailer ?? createMailer(this.env));
    const onError = (name: string) => (err: unknown) =>
      this.log.error({ err, loop: name }, 'worker loop failed; it will run again');
    this.syncLoop = new Loop(() => this.syncTick(), {
      name: 'sync',
      idleMs: this.timings.syncIdleMs,
      debounceMs: this.timings.syncDebounceMs,
      onError: onError('sync'),
    });
    this.jobLoop = new Loop(() => this.jobTick(), {
      name: 'jobs',
      idleMs: this.timings.jobIdleMs,
      onError: onError('jobs'),
    });
    this.scheduleLoop = new Loop(() => this.scheduleTick(), {
      name: 'schedule',
      idleMs: this.timings.scheduleMs,
      onError: onError('schedule'),
    });
  }

  async start(): Promise<void> {
    await this.heartbeat();
    this.listener = listen({
      url: this.options.handle.url,
      channels: ['pms_outbox', 'pms_jobs'],
      applicationName: 'pms-worker-listen',
      onNotification: (channel) => {
        if (channel === 'pms_outbox') this.syncLoop.wake();
        else this.jobLoop.wake();
      },
      // Whatever was announced while the connection was down is found by looking.
      onReconnect: () => {
        this.syncLoop.wake();
        this.jobLoop.wake();
      },
      onError: (err) => this.log.warn({ err }, 'notification listener error; reconnecting'),
    });
    await this.listener.ready;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch((err: unknown) => this.log.warn({ err }, 'heartbeat failed'));
    }, this.timings.heartbeatMs);
    this.syncLoop.start();
    this.jobLoop.start();
    this.scheduleLoop.start();
    this.log.info({ workerId: this.id }, 'worker started');
  }

  /** Stops taking work, lets work in progress finish, and signs off. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.listener?.stop();
    this.listener = null;
    await Promise.all([this.scheduleLoop.stop(), this.jobLoop.stop(), this.syncLoop.stop()]);
    await Promise.allSettled([...this.active]);
    await removeHeartbeat(this.db, this.id).catch(() => {});
    this.log.info({ workerId: this.id }, 'worker stopped');
  }

  /**
   * One full pass, in order: schedule recurring work, run every waiting job,
   * route and push. For tests and one-off runs; a started worker does this on
   * its own.
   */
  async runOnce(): Promise<void> {
    await this.scheduleTick();
    for (let round = 0; round < 20; round++) {
      const jobs = await claimJobs(this.db, this.id, 50, jobKinds());
      if (jobs.length === 0) break;
      await Promise.all(jobs.map((job) => this.runJob(job)));
    }
    await this.syncTick();
  }

  private async heartbeat(): Promise<void> {
    await recordHeartbeat(this.db, {
      id: this.id,
      hostname: hostname(),
      info: {
        pid: process.pid,
        startedAt: this.startedAt.toISOString(),
        activeJobs: this.active.size,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Sync: outbox -> work lists -> channels

  private async syncTick(): Promise<number> {
    const routed = await routeOutbox(this.db, this.options.route);
    if (routed.queued > 0)
      this.log.debug({ routed: routed.routed, queued: routed.queued }, 'routed changes');
    const results = await dispatchDue(this.db, new Date(), this.env.WORKER_CONCURRENCY);
    for (const result of results) {
      if (result.outcome === 'pushed') {
        this.log.info(
          { connectionId: result.connectionId, items: result.items, full: result.full },
          'pushed to channel',
        );
      } else if (result.outcome === 'failed') {
        this.log.warn(
          { connectionId: result.connectionId, error: result.error },
          'push to channel failed',
        );
      }
    }
    const next = await nextDispatchAt(this.db);
    if (!next) return this.timings.syncIdleMs;
    // A connection held by another worker shows as overdue; do not spin on it.
    return Math.max(100, next.getTime() - Date.now());
  }

  // -------------------------------------------------------------------------
  // Jobs

  private async jobTick(): Promise<number> {
    const free = this.env.WORKER_CONCURRENCY - this.active.size;
    if (free <= 0) return this.timings.jobIdleMs;
    const jobs = await claimJobs(this.db, this.id, free, jobKinds());
    for (const job of jobs) {
      const run: Promise<void> = this.runJob(job).finally(() => {
        this.active.delete(run);
        this.jobLoop.wake();
      });
      this.active.add(run);
    }
    // A full hand may mean more are waiting; look again as soon as a slot frees (see finally above).
    return this.timings.jobIdleMs;
  }

  private async runJob(job: JobRow): Promise<void> {
    const handler = jobHandler(job.kind);
    const started = Date.now();
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}"`);
      const result = await handler(job.payload, this.context, job);
      await completeJob(this.db, job.id, result ?? undefined);
      this.log.debug(
        { jobId: job.id, kind: job.kind, ms: Date.now() - started, result },
        'job done',
      );
    } catch (err) {
      try {
        const { willRetry } = await failJob(this.db, job, err);
        this.log.warn(
          { jobId: job.id, kind: job.kind, attempt: job.attempts, willRetry, err },
          willRetry ? 'job failed; it will be retried' : 'job failed for good',
        );
      } catch (recordErr) {
        // The database is unreachable; the job stays "running" and is reclaimed when its lock goes stale.
        this.log.error({ jobId: job.id, err: recordErr }, 'could not record a job failure');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Schedule: recurring work and health

  private async scheduleTick(): Promise<number> {
    const now = new Date();
    const step = async (name: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (err) {
        // One failing step must not stop the ones after it.
        this.log.error({ err, step: name }, 'scheduled step failed');
      }
    };

    await step('heartbeat', () => this.heartbeat());
    await step('worker liveness', () => checkWorkerLiveness(this.db, now));
    await step('booking polls', () => this.queueBookingPolls(now));
    await step('pending revisions', async () => {
      const retried = await retryPendingRevisions(this.db, now);
      if (retried.applied + retried.failed + retried.acknowledged > 0) {
        this.log.info({ ...retried }, 'retried pending booking revisions');
      }
    });
    await step('nightly full sync', async () => {
      if (!this.env.SYNC_NIGHTLY_FULL) return;
      const requested = await requestDueFullSyncs(this.db, now);
      if (requested.length > 0) {
        this.log.info({ connections: requested }, 'nightly full sync requested');
        this.syncLoop.wake();
      }
    });
    await step('drift checks', async () => {
      for (const connectionId of await connectionsDueForDriftCheck(this.db, undefined, now)) {
        await enqueueJob(
          this.db,
          JOBS.driftCheck,
          { connectionId },
          { uniqueKey: `${JOBS.driftCheck}:${connectionId}`, maxAttempts: 2 },
        );
      }
    });
    await step('sync lag', () => checkSyncLag(this.db, now));
    await step('expired holds', () => this.expireHolds(now));
    await step('night audit', async () => {
      const closed = await runDueNightAudits(
        this.db,
        (orgId) => systemActor(orgId, 'night-audit'),
        now,
      );
      for (const audit of closed) {
        if (audit.ok) this.log.info({ ...audit }, 'night audit completed');
        else this.log.error({ ...audit }, 'night audit failed');
      }
    });
    await step('automatic messages', async () => {
      const run = await runAutomations(this.db, now);
      if (run.sent + run.skipped > 0) this.log.info({ ...run }, 'automatic messages');
    });
    await step('online payments', () => this.checkPaymentOrders(now));
    await step('pruning', () => enqueueRecurring(this.db, JOBS.prune, DAY_MS, {}, { now }));
    return this.timings.scheduleMs;
  }

  /** Queues a fetch for every connection whose bookings have not been fetched within its interval. */
  private async queueBookingPolls(now: Date): Promise<void> {
    const connections = await this.db
      .select()
      .from(channelConnections)
      .where(inArray(channelConnections.status, ['active', 'error']));
    for (const connection of connections) {
      let interval: number;
      try {
        const adapter = adapterFor(connection);
        if (!adapter.pullBookings || adapter.capabilities.bookings === 'none') continue;
        interval = adapter.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      } catch (err) {
        this.log.warn({ err, connectionId: connection.id }, 'connection cannot be used');
        continue;
      }
      const last = connection.lastPullAt?.getTime() ?? 0;
      if (now.getTime() - last < interval) continue;
      // At most one a minute, so an outage is retried steadily rather than hammered.
      await enqueueRecurring(
        this.db,
        JOBS.channelPull,
        Math.min(interval, POLL_RETRY_MS),
        { connectionId: connection.id, via: 'poll' },
        { key: `${JOBS.channelPull}:poll:${connection.id}`, now },
      );
    }
  }

  private gateway: PaymentGateway | null | undefined;

  /**
   * Asks the gateway about online payments nobody came back from: a guest who
   * paid and closed the tab is confirmed, and an order past its time is closed.
   */
  private async checkPaymentOrders(now: Date): Promise<void> {
    if (this.gateway === undefined) {
      try {
        this.gateway = this.options.gateway ?? createGateway(this.env, this.db);
      } catch (err) {
        if (!isDomainError(err, 'not_configured')) throw err;
        this.gateway = null;
      }
    }
    if (!this.gateway) return;
    for (const orderId of await paymentOrdersToCheck(this.db, this.gateway.name, now)) {
      try {
        const outcome = await syncPaymentOrder(this.db, this.gateway, orderId, now);
        if (outcome.settled) {
          this.log.info(
            { orderId, refunded: outcome.refunded },
            outcome.refunded
              ? 'online payment arrived too late and was refunded'
              : 'online payment recorded',
          );
        }
      } catch (err) {
        // One order the gateway cannot answer for must not hold up the others.
        this.log.warn({ err, orderId }, 'could not check an online payment');
      }
    }
  }

  /** Releases inventory held by website bookings that were never completed. */
  private async expireHolds(now: Date): Promise<void> {
    const { rows } = await this.db.execute<{ org_id: string }>(sql`
      SELECT DISTINCT org_id FROM reservations
      WHERE status = 'tentative' AND hold_expires_at <= ${now.toISOString()}::timestamptz
    `);
    for (const { org_id } of rows) {
      const expired = await expireHolds(this.db, systemActor(org_id, 'worker'), now);
      if (expired > 0) this.log.info({ orgId: org_id, expired }, 'released expired holds');
    }
  }
}
