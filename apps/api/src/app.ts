import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import type { Env } from '@pms/config';
import type { Database, DbHandle } from '@pms/db';
import { checkWorkerLiveness, registerDefaultAdapters } from '@pms/channels';
import { createMailer, type Mailer } from '@pms/domain';
import { registerAuth } from './plugins/auth';
import { registerErrorHandling } from './plugins/errors';
import { registerLive } from './plugins/live';
import { auditRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { calendarRoutes } from './routes/calendar';
import { channelRoutes, channelWebhookRoutes, icalRoutes, mailboxRoutes } from './routes/channels';
import { guestRoutes } from './routes/guests';
import { orgRoutes } from './routes/org';
import { propertyRoutes } from './routes/properties';
import { reservationRoutes } from './routes/reservations';
import { ssoRoutes } from './routes/sso';
import { userRoutes } from './routes/users';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    handle: DbHandle;
    env: Env;
    mailer: Mailer;
  }
}

export interface AppDeps {
  handle: DbHandle;
  env: Env;
  mailer?: Mailer;
  /** Pino options, or false to disable logging (tests). */
  logger?: boolean | Record<string, unknown>;
}

export type App = FastifyInstance;

const WORKER_WATCH_INTERVAL_MS = 60_000;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.env.TRUST_PROXY,
    requestIdHeader: 'x-request-id',
    bodyLimit: 5 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  registerDefaultAdapters();
  app.decorate('db', deps.handle.db);
  app.decorate('handle', deps.handle);
  app.decorate('env', deps.env);
  app.decorate('mailer', deps.mailer ?? createMailer(deps.env));

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(helmet, {
    // The API serves JSON; the documentation page needs inline assets.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    // Tests drive many requests from one address; limits are exercised explicitly there.
    max: deps.env.isTest ? 100_000 : 300,
    timeWindow: '1 minute',
  });

  const docsEnabled = deps.env.API_DOCS ? deps.env.API_DOCS === 'true' : !deps.env.isProduction;
  if (docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'PMS API',
          description: 'Property management, inventory and channel synchronisation API.',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            session: { type: 'apiKey', in: 'cookie', name: 'pms_session' },
            apiKey: { type: 'http', scheme: 'bearer' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  registerAuth(app);

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { hide: true } }, async (_req, reply) => {
    try {
      await app.db.execute(sql`SELECT 1`);
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  await registerLive(app);

  const typed = app.withTypeProvider<ZodTypeProvider>();
  await typed.register(authRoutes);
  await typed.register(userRoutes);
  await typed.register(ssoRoutes);
  await typed.register(orgRoutes);
  await typed.register(auditRoutes);
  await typed.register(propertyRoutes);
  await typed.register(reservationRoutes);
  await typed.register(calendarRoutes);
  await typed.register(guestRoutes);
  await typed.register(channelRoutes);
  await typed.register(icalRoutes);
  await typed.register(mailboxRoutes);
  await app.register(channelWebhookRoutes);

  // The API is still up when the sync worker is not, so it is the one to say so.
  if (!deps.env.isTest) {
    const watch = setInterval(() => {
      void checkWorkerLiveness(app.db).catch((err: unknown) =>
        app.log.warn({ err }, 'could not check on the sync worker'),
      );
    }, WORKER_WATCH_INTERVAL_MS);
    watch.unref();
    app.addHook('onClose', async () => clearInterval(watch));
  }

  return app;
}
