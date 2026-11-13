import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findWorkspaceRoot, getEnv } from '@pms/config';
import { buildSim, DEFAULT_SIM_API_KEY } from './sim';
import type { SimSnapshot } from './state';

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

// A restart (the dev server restarts on every code change) must not wipe the simulated booking
// sites: the PMS would be left connected to properties that no longer exist. So the state is
// kept in a file. Set OTA_SIM_STATE_FILE to an empty value to start clean every time.
const stateFile =
  process.env.OTA_SIM_STATE_FILE === ''
    ? null
    : resolve(
        findWorkspaceRoot() ?? process.cwd(),
        process.env.OTA_SIM_STATE_FILE ?? 'var/ota-sim-state.json',
      );
let saved = '';
if (stateFile && existsSync(stateFile)) {
  try {
    saved = readFileSync(stateFile, 'utf8');
    sim.state.restore(JSON.parse(saved) as SimSnapshot);
    sim.app.log.info(
      `restored ${sim.state.properties.size} simulated properties from ${stateFile}`,
    );
  } catch (err) {
    sim.app.log.warn({ err }, 'could not restore the saved simulator state; starting clean');
  }
}
const save = (): void => {
  if (!stateFile) return;
  const next = JSON.stringify(sim.state.snapshot());
  if (next === saved) return;
  mkdirSync(dirname(stateFile), { recursive: true });
  // Written beside and renamed, so a crash mid-write never leaves half a file.
  writeFileSync(`${stateFile}.tmp`, next);
  renameSync(`${stateFile}.tmp`, stateFile);
  saved = next;
};
const saver = setInterval(save, 2_000);
saver.unref();

const { url } = await sim.listen(env.OTA_SIM_PORT, '0.0.0.0');
sim.app.log.info(`OTA simulator on ${url} (Channex-compatible API at ${url}/api/v1)`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    save();
    void sim.close().then(() => process.exit(0));
  });
}
