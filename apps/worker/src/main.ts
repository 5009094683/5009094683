import { getEnvOrExit } from '@pms/config';
import { createDb, runMigrations } from '@pms/db';
import { registerDefaultAdapters } from '@pms/channels';
import { createLogger } from './logger';
import { Worker } from './worker';

const env = getEnvOrExit('worker');
const log = createLogger(env);

if (env.usingDevEncryptionKey) {
  log.warn(
    {},
    'APP_ENCRYPTION_KEY is not set: using the built-in development key. Do not use this with real data.',
  );
}

await runMigrations(env.DATABASE_URL);
registerDefaultAdapters();

const handle = createDb({
  url: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  applicationName: 'pms-worker',
});
const worker = new Worker({ handle, env, log });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // Work in progress gets a bounded time to finish; anything cut off is picked up again on restart.
  const timeout = setTimeout(() => {
    log.error({}, 'shutdown timed out');
    process.exit(1);
  }, 25_000);
  try {
    await worker.stop();
    await handle.close();
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await worker.start();
