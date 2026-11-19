import { defineConfig } from '@playwright/test';
import {
  API_PORT,
  API_URL,
  AUTH_STATE,
  BOOKING_PORT,
  BOOKING_URL,
  E2E_DATABASE_URL,
  INBOUND_EMAIL_SECRET,
  WEB_PORT,
  WEB_URL,
} from './env';

const serverEnv = {
  // "test" lifts the sign-in rate limit, which the suite would otherwise trip.
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  DATABASE_URL: E2E_DATABASE_URL,
  API_PORT: String(API_PORT),
  API_INTERNAL_URL: API_URL,
  API_PUBLIC_URL: `${WEB_URL}/api`,
  WEB_URL,
  // Where the API sends a guest back to after paying, and what the links it writes point at.
  BOOKING_URL,
  // Files uploaded during a run are kept apart from those of `pnpm dev`.
  STORAGE_DIR: './var/e2e-files',
  // The inbox takes guests' email, and offers to answer by email. No worker runs here, so
  // nothing is ever sent to this address: it only has to be set for a reply to be written.
  INBOUND_EMAIL_SECRET,
  SMTP_URL: 'smtp://127.0.0.1:1',
  MAIL_FROM: 'Sea Breeze <stay@seabreeze.example>',
};

const nextEnv = {
  ...serverEnv,
  NODE_ENV: 'development',
  // A separate build directory lets the suite run while `pnpm dev` is up.
  NEXT_DIST_DIR: '.next-e2e',
  NEXT_TELEMETRY_DISABLED: '1',
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
      command: `pnpm --filter @pms/web exec next dev -p ${WEB_PORT}`,
      url: `${WEB_URL}/login`,
      env: nextEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
    },
    {
      // The guest booking site. Its start page lists the properties, so it is up
      // only once it can reach the API.
      command: `pnpm --filter @pms/booking exec next dev -p ${BOOKING_PORT}`,
      url: BOOKING_URL,
      env: nextEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});
