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
const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);
const digits = z.string().regex(/^\d+$/, 'is a number without spaces').default('');
const yesOrNo = z
  .enum(['true', 'false', 'yes', 'no', '1', '0'])
  .default('false')
  .transform((value) => ['true', 'yes', '1'].includes(value));

const schema = z.object({
  BUSINESS_FILE: z.string().default('config/business.ts'),
  DATA_DIR: z.string().default('./var'),

  CHAT_CONNECTION: z.enum(['messenger', 'simulator']).default('messenger'),
  FB_APP_ID: digits,
  FB_APP_SECRET: z.string().default(''),
  FB_PAGE_ACCESS_TOKEN: z.string().default(''),
  FB_PAGE_ID: digits,
  FB_VERIFY_TOKEN: z.string().default(''),
  FB_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'looks like v27.0')
    .default('v27.0'),
  FB_HUMAN_AGENT_TAG: yesOrNo,

  PUBLIC_URL: z.string().default(''),
  WEBHOOK_HOST: z.string().default('127.0.0.1'),
  WEBHOOK_PORT: port(3401),

  DASHBOARD_HOST: z.string().default('127.0.0.1'),
  DASHBOARD_PORT: port(3400),
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
  /** Open a try-out tunnel and use its address as the public one. */
  tunnel: boolean;
  businessFile: string;
  dataDir: string;
  databaseFile: string;
  connection: 'messenger' | 'simulator';
  facebook: {
    appId: string;
    appSecret: string;
    pageAccessToken: string;
    pageId: string;
    verifyToken: string;
    graphVersion: string;
    humanAgentTag: boolean;
  };
  /** The HTTPS address under which Facebook reaches the webhook port. '' = not set. */
  publicUrl: string;
  /** Where the part that is open to the internet listens. */
  webhook: { host: string; port: number };
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

const WHERE_TO_FIND: Record<string, string> = {
  FB_APP_ID:
    'the number of your app at developers.facebook.com (shown at the top of its dashboard)',
  FB_APP_SECRET: 'in the app\u2019s dashboard: App settings > Basic > App secret > Show',
  FB_PAGE_ACCESS_TOKEN:
    'in the app\u2019s dashboard: Use cases > Customize > Messenger API Settings > 2. Generate ' +
    'access tokens > "Generate" next to the Page',
};

function publicAddress(value: string): string {
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(
      `PUBLIC_URL is not an address: "${value}". It looks like https://assistant.example.com`,
    );
  }
  if (url.protocol !== 'https:') {
    throw new SettingsError(
      'PUBLIC_URL must begin with https://. Facebook only delivers messages to addresses with HTTPS.',
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function readSettings(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): Settings {
  // An empty value in .env ("PUBLIC_URL=") means "not set".
  const given = Object.fromEntries(
    Object.entries(env)
      .map(([name, value]) => [name, value?.trim()])
      .filter(([, value]) => value !== undefined && value !== ''),
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
    tunnel: !demo && argv.includes('--tunnel'),
    businessFile:
      demo && env.BUSINESS_FILE === undefined ? 'config/business.demo.ts' : values.BUSINESS_FILE,
    dataDir,
    databaseFile: resolve(dataDir, 'assistant.sqlite'),
    connection: demo ? 'simulator' : values.CHAT_CONNECTION,
    facebook: {
      appId: values.FB_APP_ID,
      appSecret: values.FB_APP_SECRET,
      pageAccessToken: values.FB_PAGE_ACCESS_TOKEN,
      pageId: values.FB_PAGE_ID,
      verifyToken: values.FB_VERIFY_TOKEN,
      graphVersion: values.FB_GRAPH_VERSION,
      humanAgentTag: values.FB_HUMAN_AGENT_TAG,
    },
    publicUrl: publicAddress(values.PUBLIC_URL),
    webhook: { host: values.WEBHOOK_HOST, port: values.WEBHOOK_PORT },
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
  if (settings.connection === 'messenger') {
    const lacking = (['FB_APP_ID', 'FB_APP_SECRET', 'FB_PAGE_ACCESS_TOKEN'] as const).filter(
      (name) => values[name] === '',
    );
    if (lacking.length > 0) {
      const lines = lacking.map((name) => `  - ${name}: ${WHERE_TO_FIND[name]}`);
      throw new SettingsError(
        `To connect to Facebook, .env still needs:\n${lines.join('\n')}\n\n` +
          'The README describes each step under "Connecting Facebook". ' +
          'To try the assistant without Facebook: pnpm demo',
      );
    }
  }
  return settings;
}
