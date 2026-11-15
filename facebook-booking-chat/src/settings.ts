import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/*
  How the program is run: where its files are, how it connects, who may open
  the dashboard. Read from the environment, and from the file .env when there
  is one (see .env.example). What the assistant says and sells is not here but
  in config/business.ts.
*/

const number = (fallback: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(fallback);

const schema = z.object({
  BUSINESS_FILE: z.string().default('config/business.ts'),
  DATA_DIR: z.string().default('./var'),

  CHAT_CONNECTION: z.enum(['facebook', 'simulator']).default('facebook'),
  FB_SESSION_FILE: z.string().default(''),
  FB_SEND_VIA: z.enum(['mqtt', 'http']).default('mqtt'),
  FB_USER_AGENT: z.string().default(''),

  DASHBOARD_HOST: z.string().default('127.0.0.1'),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3400),
  DASHBOARD_PASSWORD: z.string().default(''),
  DASHBOARD_URL: z.string().default(''),

  STAFF_THREAD_IDS: z.string().default(''),
  REPLY_WAIT_SECONDS: number(2.5, 0, 60),
  STAFF_PAUSE_HOURS: number(12, 0.1, 24 * 30),
  MAX_REPLIES_PER_HOUR: number(40, 1, 1000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface Settings {
  demo: boolean;
  businessFile: string;
  dataDir: string;
  databaseFile: string;
  connection: 'facebook' | 'simulator';
  sessionFile: string;
  sendVia: 'mqtt' | 'http';
  userAgent: string;
  dashboard: { host: string; port: number; password: string; url: string };
  staffThreadIds: string[];
  replyWaitMs: number;
  staffPauseMs: number;
  maxRepliesPerHour: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export class SettingsError extends Error {}

/** Reads .env from the working directory into the environment; set variables win. */
export function loadEnvFile(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function readSettings(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): Settings {
  // An empty value in .env ("FB_USER_AGENT=") means "not set".
  const given = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new SettingsError(
      `The settings in the environment or in .env are not usable:\n${lines.join('\n')}`,
    );
  }
  const values = parsed.data;
  const demo = argv.includes('--demo');

  const dataDir = resolve(demo ? `${values.DATA_DIR}/demo` : values.DATA_DIR);
  const settings: Settings = {
    demo,
    businessFile:
      demo && env.BUSINESS_FILE === undefined ? 'config/business.demo.ts' : values.BUSINESS_FILE,
    dataDir,
    databaseFile: resolve(dataDir, 'assistant.sqlite'),
    connection: demo ? 'simulator' : values.CHAT_CONNECTION,
    sessionFile: resolve(values.FB_SESSION_FILE || `${dataDir}/facebook-session.json`),
    sendVia: values.FB_SEND_VIA,
    userAgent: values.FB_USER_AGENT,
    dashboard: {
      host: values.DASHBOARD_HOST,
      port: values.DASHBOARD_PORT,
      password: values.DASHBOARD_PASSWORD || (demo ? 'demo' : ''),
      url: values.DASHBOARD_URL,
    },
    staffThreadIds: values.STAFF_THREAD_IDS.split(/[\s,]+/).filter(Boolean),
    replyWaitMs: Math.round(values.REPLY_WAIT_SECONDS * 1000),
    staffPauseMs: Math.round(values.STAFF_PAUSE_HOURS * 60 * 60 * 1000),
    maxRepliesPerHour: values.MAX_REPLIES_PER_HOUR,
    logLevel: values.LOG_LEVEL,
  };

  if (!demo && settings.dashboard.password.length < 8) {
    throw new SettingsError(
      'Set DASHBOARD_PASSWORD (in .env) to a password of at least 8 characters. ' +
        'The dashboard shows customers\u2019 names, phone numbers and chats.',
    );
  }
  return settings;
}
