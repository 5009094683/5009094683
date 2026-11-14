import pg from 'pg';

export interface NotificationListener {
  /** Resolves once the first LISTEN is in place. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export interface ListenerOptions {
  url: string;
  channels: string[];
  onNotification(channel: string, payload: string): void;
  /**
   * Called after the connection was lost and re-established. Notifications
   * sent in between are gone, so the owner should catch up by polling.
   */
  onReconnect?(): void;
  onError?(err: Error): void;
  applicationName?: string;
}

/**
 * Holds one dedicated connection that LISTENs on the given channels and
 * reconnects with backoff when the connection drops. NOTIFY is only a wake-up
 * signal: every consumer also polls, so a lost notification delays work but
 * never loses it.
 */
export function listen(options: ListenerOptions): NotificationListener {
  let client: pg.Client | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = new pg.Client({
      connectionString: options.url,
      application_name: options.applicationName ?? 'pms-listener',
      keepAlive: true,
    });
    let closed = false;
    const onClosed = (err?: Error): void => {
      if (closed) return;
      closed = true;
      if (client === next) client = null;
      if (err) options.onError?.(err);
      if (stopped) return;
      const delay = Math.min(30_000, 250 * 2 ** attempt++);
      timer = setTimeout(() => void connect(), delay);
    };
    next.on('error', onClosed);
    next.on('end', () => onClosed());
    next.on('notification', (msg) => {
      try {
        options.onNotification(msg.channel, msg.payload ?? '');
      } catch (err) {
        options.onError?.(err as Error);
      }
    });
    try {
      await next.connect();
      for (const channel of options.channels) {
        await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      }
      if (stopped) {
        await next.end().catch(() => {});
        return;
      }
      client = next;
      const reconnected = attempt > 0;
      attempt = 0;
      resolveReady();
      if (reconnected) options.onReconnect?.();
    } catch (err) {
      await next.end().catch(() => {});
      onClosed(err as Error);
    }
  };

  void connect();

  return {
    ready,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = client;
      client = null;
      if (current) await current.end().catch(() => {});
      resolveReady();
    },
  };
}
