/*
  Starts the assistant: the connection to the chat, the dashboard for the team.

    pnpm start             with Facebook, as set in .env
    pnpm start --tunnel    the same, reachable through a try-out tunnel (no address of your own needed)
    pnpm demo              try-out mode: no Facebook, sample settings, a fresh database
*/
import { rmSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { buildDashboard } from './admin/server';
import { Bot } from './bot/bot';
import { Desk } from './bookings/desk';
import { loadBusiness } from './business/load';
import { BusinessConfigError } from './business/schema';
import { Engine } from './engine/engine';
import { PRIVACY_PATH, buildPublicServer, publicRoutes } from './public/server';
import { SettingsError, loadEnvFile, readSettings } from './settings';
import { Store } from './store';
import { MessengerTransport, WEBHOOK_PATH } from './transport/messenger';
import { SimulatorTransport } from './transport/simulator';
import type { Transport } from './transport/types';
import { type Tunnel, TunnelError, openTunnel } from './tunnel';

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

  process.on('unhandledRejection', (reason) => {
    log.error({ reason: reason instanceof Error ? reason.message : reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
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
  const messenger = simulator
    ? null
    : new MessengerTransport({
        ...settings.facebook,
        // With a tunnel, the address is only known once the tunnel is open.
        publicUrl: settings.tunnel ? '' : settings.publicUrl,
        log: log.child({ part: 'facebook' }),
      });
  const transport: Transport = simulator ?? messenger!;

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

  // What Facebook calls has a port of its own, so that it alone needs to be
  // reachable from the internet. With the same number for both, or in try-out
  // mode, it shares the dashboard's port.
  const open = { business, messenger, log: log.child({ part: 'webhook' }) };
  const onePort = settings.demo || settings.webhook.port === settings.dashboard.port;

  const dashboard = await buildDashboard({
    business,
    store,
    desk,
    bot,
    transport,
    simulator,
    password: settings.dashboard.password,
    staffThreads: settings.staffThreadIds.length,
    pauseHours: Math.round((settings.staffPauseMs / 3_600_000) * 10) / 10,
    publicRoutes: onePort ? publicRoutes(open) : undefined,
  });

  // The dashboard's address is taken first: a second copy of the assistant
  // started by mistake stops here, before it can answer customers twice.
  const { host, port } = settings.dashboard;
  await dashboard.listen({ host, port });
  const local = (h: string, p: number) => `http://${h === '0.0.0.0' ? 'localhost' : h}:${p}`;
  const address = local(host, port);

  let publicServer: FastifyInstance | null = null;
  if (!onePort) {
    publicServer = await buildPublicServer(open);
    await publicServer.listen(settings.webhook);
  }
  const publicPort = onePort ? port : settings.webhook.port;
  const publicLocal = onePort ? address : local(settings.webhook.host, settings.webhook.port);

  log.info(`${business.company.name}: booking assistant`);
  log.info(`Settings: ${settings.businessFile}`);
  const passwordHint = !settings.demo
    ? ''
    : settings.dashboard.password === 'demo'
      ? '  (password: demo)'
      : '  (password: the DASHBOARD_PASSWORD from .env)';
  log.info(`Dashboard: ${address}${passwordHint}`);

  let tunnel: Tunnel | null = null;
  if (simulator) {
    log.info(`Try-out mode: nothing is sent to Facebook. Write as a customer at ${address}/try`);
    log.info(`Privacy notice, as customers would see it: ${address}${PRIVACY_PATH}`);
  } else if (messenger) {
    if (settings.tunnel) {
      log.info(
        'Opening a try-out tunnel (for trying out only: the address changes with every start)',
      );
      tunnel = await openTunnel(publicPort, {
        log: log.child({ part: 'tunnel' }),
        onNewUrl: (url) => void messenger.setPublicUrl(url),
      });
      await messenger.setPublicUrl(tunnel.url);
    }
    const outside = tunnel?.url ?? settings.publicUrl;
    log.info(
      outside
        ? `Facebook calls in at: ${outside}${WEBHOOK_PATH}  (this machine: ${publicLocal})`
        : `Facebook calls in at: ${publicLocal}${WEBHOOK_PATH}  (PUBLIC_URL is not set)`,
    );
    if (outside) log.info(`Privacy notice for customers: ${outside}${PRIVACY_PATH}`);
  }
  await bot.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Stopping (${signal})`);
    tunnel?.stop();
    await bot.stop().catch(() => undefined);
    await publicServer?.close().catch(() => undefined);
    await dashboard.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((error: unknown) => {
  if (
    error instanceof SettingsError ||
    error instanceof BusinessConfigError ||
    error instanceof TunnelError
  ) {
    console.error(`\n${error.message}\n`);
  } else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const port = (error as NodeJS.ErrnoException & { port?: number }).port;
    console.error(
      `\nPort ${port ?? ''} is already in use. Is the assistant already running? ` +
        'Only one copy may run, or customers get every answer twice.\n',
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
