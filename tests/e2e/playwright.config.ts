import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, AUTH_STATE, E2E_DATABASE_URL, WEB_PORT, WEB_URL } from './env';

const serverEnv = {
  // "test" lifts the sign-in rate limit, which the suite would otherwise trip.
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL: E2E_DATABASE_URL,
  API_PORT: String(API_PORT),
  API_INTERNAL_URL: API_URL,
  API_PUBLIC_URL: `${WEB_URL}/api`,
  WEB_URL,
};

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One database is shared by every spec, and specs change it.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : 'list',
  use: {
    baseURL: WEB_URL,
    // The system Chrome: no browser download needed, locally or on CI runners.
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chrome',
      testIgnore: /.*\.setup\.ts/,
      dependencies: ['setup'],
      use: { storageState: AUTH_STATE },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx setup-db.ts && pnpm --filter @pms/api exec tsx src/server.ts',
      url: `${API_URL}/health`,
      env: serverEnv,
      // Locally, servers that are already up are reused so reruns are quick.
      // The specs create their own properties, so a used database is fine.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      // A separate build directory lets the suite run while `pnpm dev` is up.
      command: `pnpm --filter @pms/web exec next dev -p ${WEB_PORT}`,
      url: `${WEB_URL}/login`,
      env: {
        ...serverEnv,
        NODE_ENV: 'development',
        NEXT_DIST_DIR: '.next-e2e',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});
