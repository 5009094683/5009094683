import Fastify, { type FastifyInstance } from 'fastify';
import { channexApi } from './channex-api';
import { controlApi } from './control-api';
import { SimState } from './state';
import { channelScreenHtml, UI_HTML } from './ui';
import { WebhookSender } from './webhooks';

export interface SimOptions {
  /** Keys accepted in the `user-api-key` header. */
  apiKeys?: string[];
  /** Sign webhook deliveries with this secret, as Channex does for signed webhooks. */
  signingSecret?: string;
  /** Pauses between webhook delivery attempts. The real service waits minutes; tests wait milliseconds. */
  webhookRetryDelaysMs?: number[];
  logger?: boolean | Record<string, unknown>;
  /** How often unacknowledged revisions are checked for the `non_acked_booking` warning. 0 turns it off. */
  nonAckedCheckMs?: number;
}

export interface Sim {
  app: FastifyInstance;
  state: SimState;
  sender: WebhookSender;
  /** Starts listening and returns the base URL of the Channex-compatible API (ending in `/api/v1`). */
  listen(port?: number, host?: string): Promise<{ url: string; apiUrl: string }>;
  close(): Promise<void>;
}

export const DEFAULT_SIM_API_KEY = 'sim-api-key';

/**
 * A stand-in for the channel manager and the booking sites behind it.
 *
 * - `/api/v1/...` answers like the Channex API, for the PMS.
 * - `/sim/...` lets a test or a person act as a guest on a site, inject
 *   failures, and look at what the PMS sent.
 * - `/` is a screen showing what each site would offer for sale.
 */
export function buildSim(options: SimOptions = {}): Sim {
  const state = new SimState();
  const sender = new WebhookSender(state, {
    signingSecret: options.signingSecret,
    retryDelaysMs: options.webhookRetryDelaysMs ?? [1_000, 2_000, 4_000, 8_000],
  });
  state.onEvent = (event, propertyId, payload) => sender.announce(event, propertyId, payload);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  void app.register(channexApi, {
    prefix: '/api/v1',
    state,
    apiKeys: options.apiKeys ?? [DEFAULT_SIM_API_KEY],
  });
  void app.register(controlApi, { prefix: '/sim', state, sender });

  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(UI_HTML));
  app.get('/health', async () => ({ status: 'ok' }));

  // The embedded channel screen: exchanges a one-time token for a page.
  app.get('/auth/exchange', async (req, reply) => {
    const query = req.query as { oauth_session_key?: string };
    const token = query.oauth_session_key
      ? state.oneTimeTokens.get(query.oauth_session_key)
      : undefined;
    if (!token || token.expiresAt < Date.now()) {
      return reply
        .status(401)
        .type('text/plain')
        .send('This link has expired or was already used.');
    }
    state.oneTimeTokens.delete(query.oauth_session_key!);
    const property = state.properties.get(token.propertyId);
    if (!property) return reply.status(404).type('text/plain').send('Property not found.');
    return reply.type('text/html; charset=utf-8').send(channelScreenHtml(property, token.username));
  });

  let timer: NodeJS.Timeout | null = null;
  const every = options.nonAckedCheckMs ?? 30_000;
  if (every > 0) {
    timer = setInterval(() => state.warnNonAcked(), every);
    timer.unref();
  }

  return {
    app,
    state,
    sender,
    async listen(port = 0, host = '127.0.0.1') {
      await app.listen({ port, host });
      const address = app.server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`;
      return { url, apiUrl: `${url}/api/v1` };
    },
    async close() {
      if (timer) clearInterval(timer);
      sender.stop();
      state.reset();
      await app.close();
    },
  };
}
