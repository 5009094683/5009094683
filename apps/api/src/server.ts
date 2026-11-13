import { getEnv } from '@pms/config';
import { createDb, runMigrations } from '@pms/db';
import { buildApp } from './app';

const env = getEnv();

if (env.usingDevEncryptionKey) {
  console.warn(
    '[api] APP_ENCRYPTION_KEY is not set: using the built-in development key. Do not use this with real data.',
  );
}

await runMigrations(env.DATABASE_URL);

const handle = createDb({
  url: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  applicationName: 'pms-api',
});
const app = await buildApp({
  handle,
  env,
  logger: {
    level: env.LOG_LEVEL ?? 'info',
    // Cookies and authorization headers must never reach the logs.
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    ...(env.isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }),
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await handle.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.API_HOST, port: env.API_PORT });
