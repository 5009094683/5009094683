/*
  Starts the assistant: the connection to the chat, the dashboard for the team.

    pnpm start     with Facebook, as set in .env
    pnpm demo      try-out mode: no Facebook, sample settings, a fresh database
*/
import { rmSync } from 'node:fs';
import pino from 'pino';
import { buildDashboard } from './admin/server';
import { Bot } from './bot/bot';
import { Desk } from './bookings/desk';
import { loadBusiness } from './business/load';
import { BusinessConfigError } from './business/schema';
import { Engine } from './engine/engine';
import { SettingsError, loadEnvFile, readSettings } from './settings';
import { Store } from './store';
import { FacebookTransport } from './transport/facebook';
import { describeSession, loadSession } from './transport/session';
import { SimulatorTransport } from './transport/simulator';
import type { Transport } from './transport/types';

async function main(): Promise<void> {
  loadEnvFile();
  const settings = readSettings();
  const business = await loadBusiness(settings.businessFile);

  const log = pino({
    level: settings.logLevel,
    transport: process.stdout.isTTY
      ? {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
  });

  // The client library for Facebook throws from inside its own callbacks when
  // Facebook answers in a way it does not expect. That must not take the
  // dashboard down with it; the connection notices by itself and signs in again.
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: reason instanceof Error ? reason.message : reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    if (error.stack?.includes('ws3-fca')) {
      log.error({ error: error.message }, 'The Facebook client library failed');
      return;
    }
    log.fatal(error, 'Stopping after an unexpected error');
    process.exit(1);
  });

  if (settings.demo) {
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${settings.databaseFile}${suffix}`, { force: true });
  }
  const store = Store.open(settings.databaseFile);
  const desk = new Desk(store, business);
  const engine = new Engine(business, desk, store.bookings);

  const simulator = settings.connection === 'simulator' ? new SimulatorTransport() : null;
  const transport: Transport =
    simulator ??
    new FacebookTransport({
      sessionFile: settings.sessionFile,
      sendVia: settings.sendVia,
      userAgent: settings.userAgent,
      log: log.child({ part: 'facebook' }),
    });

  const bot = new Bot({
    transport,
    store,
    engine,
    business,
    log: log.child({ part: 'assistant' }),
    options: {
      debounceMs: settings.replyWaitMs,
      staffPauseMs: settings.staffPauseMs,
      maxRepliesPerHour: settings.maxRepliesPerHour,
      staffThreadIds: settings.staffThreadIds,
      dashboardUrl: settings.dashboard.url,
      // Nobody is watching a typing sign in try-out mode.
      ...(settings.demo ? { debounceMs: 400, minTypingMs: 300, maxTypingMs: 900 } : {}),
    },
  });

  const dashboard = await buildDashboard({
    business,
    store,
    desk,
    bot,
    transport,
    simulator,
    password: settings.dashboard.password,
    sessionFile: settings.sessionFile,
    sendVia: settings.sendVia,
    staffThreads: settings.staffThreadIds.length,
    pauseHours: Math.round((settings.staffPauseMs / 3_600_000) * 10) / 10,
  });

  // The dashboard's address is taken first: a second copy of the assistant
  // started by mistake stops here, before it can answer customers twice.
  const { host, port } = settings.dashboard;
  await dashboard.listen({ host, port });
  const address = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  log.info(`${business.company.name}: booking assistant`);
  log.info(`Settings: ${settings.businessFile}`);
  log.info(`Dashboard: ${address}${settings.demo ? '  (password: demo)' : ''}`);
  if (simulator) {
    log.info(`Try-out mode: nothing is sent to Facebook. Write as a customer at ${address}/try`);
  } else {
    try {
      log.info(`Facebook: signing in as ${describeSession(loadSession(settings.sessionFile))}`);
    } catch {
      // The connection reports the missing or unusable session file itself.
    }
  }
  await bot.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Stopping (${signal})`);
    await bot.stop().catch(() => undefined);
    await dashboard.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof SettingsError || error instanceof BusinessConfigError) {
    console.error(`\n${error.message}\n`);
  } else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      '\nThe dashboard address is already in use. Is the assistant already running? ' +
        'Only one copy may run, or customers get every answer twice.\n',
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
