import type { FastifyInstance } from 'fastify';
import { listen, type NotificationListener } from '@pms/db';
import { can, resolveSession, type Grant } from '@pms/domain';
import { fullSession } from './auth';

export interface LiveEvent {
  id: number;
  kind: string;
  orgId: string;
  propertyId: string | null;
  payload?: Record<string, unknown>;
}

interface Subscriber {
  orgId: string;
  grants: Grant[];
  send(event: LiveEvent): void;
}

/** Outbox kinds that open screens care about. Rate-plan internals reach them as `rates.updated`. */
const FORWARDED =
  /^(reservation|block|unit|rates|alert|sync|message|folio|task)\.|^ari\.availability$/;

/**
 * Fans database change notifications out to connected browsers. Each server
 * process keeps one LISTEN connection; every change committed anywhere (API,
 * worker, another API instance) reaches every open calendar within moments.
 */
export class LiveHub {
  private readonly subscribers = new Set<Subscriber>();
  private listener: NotificationListener | null = null;

  constructor(
    private readonly url: string,
    private readonly log: (message: string, err?: Error) => void,
  ) {}

  async start(): Promise<void> {
    this.listener = listen({
      url: this.url,
      channels: ['pms_outbox'],
      applicationName: 'pms-api-live',
      onNotification: (_channel, payload) => this.dispatch(payload),
      // Changes made while disconnected were missed: tell every screen to refetch.
      onReconnect: () => this.broadcastResync(),
      onError: (err) => this.log('live update listener error', err),
    });
    await this.listener.ready;
  }

  async stop(): Promise<void> {
    await this.listener?.stop();
    this.listener = null;
    this.subscribers.clear();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  get connections(): number {
    return this.subscribers.size;
  }

  private dispatch(raw: string): void {
    let event: LiveEvent;
    try {
      event = JSON.parse(raw) as LiveEvent;
    } catch {
      return;
    }
    if (!FORWARDED.test(event.kind)) return;
    for (const subscriber of this.subscribers) {
      if (subscriber.orgId !== event.orgId) continue;
      // Property events go only to people who can see that property.
      const visible = event.propertyId
        ? can(subscriber.grants, 'property.read', event.propertyId)
        : can(subscriber.grants, 'property.read');
      if (visible) subscriber.send(event);
    }
  }

  private broadcastResync(): void {
    for (const subscriber of this.subscribers) {
      subscriber.send({ id: 0, kind: 'resync', orgId: subscriber.orgId, propertyId: null });
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    live: LiveHub;
  }
}

const PING_INTERVAL_MS = 25_000;

export async function registerLive(app: FastifyInstance): Promise<void> {
  const hub = new LiveHub(app.handle.url, (message, err) => app.log.warn({ err }, message));
  app.decorate('live', hub);
  await hub.start();
  app.addHook('onClose', async () => hub.stop());

  app.get(
    '/live',
    {
      schema: {
        tags: ['live'],
        summary: 'Server-sent events: changes to reservations, blocks, rates and alerts',
      },
    },
    async (req, reply) => {
      const session = fullSession(req);
      const token = req.sessionToken!;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Tell reverse proxies not to buffer the stream.
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');

      const unsubscribe = hub.subscribe({
        orgId: session.user.orgId,
        grants: session.grants,
        send: (event) => {
          res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
        },
      });

      // The comment line keeps idle connections open through proxies. The same
      // tick re-checks the session, so a signed-out or disabled user stops
      // receiving events within one interval.
      const timer = setInterval(() => {
        void resolveSession(app.db, token)
          .then((current) => {
            if (!current || current.mfaPending) res.end();
            else res.write(': ping\n\n');
          })
          .catch(() => res.end());
      }, PING_INTERVAL_MS);

      const cleanup = (): void => {
        clearInterval(timer);
        unsubscribe();
      };
      req.raw.on('close', cleanup);
      res.on('close', cleanup);
    },
  );
}
