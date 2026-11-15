import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import type { Business } from '../business/schema';
import { type MessengerTransport, WEBHOOK_PATH } from '../transport/messenger';
import { privacyPage } from './privacy';

/*
  The part of the program that is open to the internet: the address Facebook
  calls with customers' messages, and the privacy notice. Nothing here shows
  anything of the dashboard.

  It runs on a port of its own, so that only this part needs to be reachable
  from outside; it can also be mounted on the dashboard's port where one
  address has to do for both.
*/

export const PRIVACY_PATH = '/privacy';

/** The paths that are open without signing in when mounted on the dashboard. */
export const PUBLIC_PATHS: readonly string[] = [WEBHOOK_PATH, PRIVACY_PATH];

// Facebook puts up to a thousand events into one call.
const BODY_LIMIT = 5 * 1024 * 1024;
const WARN_EVERY_MS = 60_000;

export interface PublicDeps {
  business: Business;
  /** Null in try-out mode, where there is no Facebook to call in. */
  messenger: MessengerTransport | null;
  log?: { warn(details: object, message: string): void };
  now?: () => number;
}

export function publicRoutes(deps: PublicDeps): FastifyPluginAsync {
  const { business, messenger } = deps;
  const now = deps.now ?? (() => Date.now());
  let warnedAt = Number.NEGATIVE_INFINITY;

  return async (app) => {
    // Facebook signs the very bytes it sends; they are kept as they came, and
    // read as JSON only once the signature has been found right.
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    app.addHook('onRequest', async (_request, reply) => {
      void reply.headers({
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
    });

    // Facebook checks the address before it uses it.
    app.get(WEBHOOK_PATH, async (request, reply) => {
      const answer =
        messenger?.answerToVerification(request.query as Record<string, unknown>) ?? null;
      if (answer === null) return reply.code(403).type('text/plain').send('Forbidden');
      return reply.header('cache-control', 'no-store').type('text/plain').send(answer);
    });

    // Facebook delivers what happened in the Page's chats.
    app.post(WEBHOOK_PATH, async (request, reply) => {
      void reply.header('cache-control', 'no-store').type('text/plain');
      if (!messenger) return reply.code(503).send('Not connected to Facebook.');

      const body = request.body;
      const signature = request.headers['x-hub-signature-256'];
      if (!Buffer.isBuffer(body) || !messenger.isSignedByFacebook(body, signature)) {
        // Anyone can call this address; only Facebook can sign with the app secret.
        if (now() - warnedAt >= WARN_EVERY_MS) {
          warnedAt = now();
          deps.log?.warn(
            { from: request.ip },
            'A call to the webhook without Facebook\u2019s signature was turned away',
          );
        }
        return reply.code(401).send('The signature is missing or wrong.');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return reply.code(400).send('Not JSON.');
      }
      // Facebook wants its answer within seconds and repeats what got none.
      // Messages are only taken in here; answering customers follows by itself.
      return messenger.receive(payload)
        ? reply.code(200).send('EVENT_RECEIVED')
        : reply.code(404).send('Not about a Page.');
    });

    app.get(PRIVACY_PATH, async (_request, reply) =>
      reply
        .headers({
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'cache-control': 'public, max-age=3600',
        })
        .type('text/html; charset=utf-8')
        .send(privacyPage(business)),
    );
  };
}

/** The public part as a server of its own. */
export async function buildPublicServer(
  deps: PublicDeps & { logger?: boolean | object },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  await app.register(publicRoutes(deps));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/', async (_request, reply) => reply.redirect(PRIVACY_PATH));
  app.setNotFoundHandler((_request, reply) => reply.code(404).type('text/plain').send('Not found'));
  return app;
}
