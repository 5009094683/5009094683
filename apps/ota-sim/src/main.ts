import { getEnv } from '@pms/config';
import { buildSim, DEFAULT_SIM_API_KEY } from './sim';

const env = getEnv();
const sim = buildSim({
  apiKeys: [env.CHANNEX_API_KEY ?? DEFAULT_SIM_API_KEY, DEFAULT_SIM_API_KEY],
  signingSecret: env.CHANNEX_WEBHOOK_SIGNING_SECRET,
  logger: {
    level: env.LOG_LEVEL ?? 'info',
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
// On a developer machine the sites take a moment to catch up, so the lag is visible on screen.
sim.state.distributionDelayMs = 1_200;

const { url } = await sim.listen(env.OTA_SIM_PORT, '0.0.0.0');
sim.app.log.info(`OTA simulator on ${url} (Channex-compatible API at ${url}/api/v1)`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void sim.close().then(() => process.exit(0));
  });
}
