import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Insecure key used only outside production so a fresh checkout boots without setup. */
const DEV_ENCRYPTION_KEY = 'ZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyLWJ5dGVzISE=';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

  DATABASE_URL: z.string().default('postgres://pms:pms@localhost:5432/pms'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().default(4000),
  /**
   * Base URL under which browsers and channel webhooks reach the API. By
   * default the back office proxies `/api` to the API, so cookies stay
   * same-origin with the web app.
   */
  API_PUBLIC_URL: z.string().default('http://localhost:3000/api'),
  /** Where the web apps reach the API server-side (inside the cluster or on localhost). */
  API_INTERNAL_URL: z.string().default('http://localhost:4000'),
  WEB_URL: z.string().default('http://localhost:3000'),
  BOOKING_URL: z.string().default('http://localhost:3001'),
  /** Honour X-Forwarded-For. Turn off only when the API is exposed without a proxy in front. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Serve interactive API documentation at /docs. Defaults to on outside production. */
  API_DOCS: z.enum(['true', 'false']).optional(),

  /** Base64 of 32 random bytes. Encrypts stored secrets and guest identity data. */
  APP_ENCRYPTION_KEY: optionalString,
  /** Older keys, comma separated, still accepted for decryption during rotation. */
  APP_ENCRYPTION_KEY_PREVIOUS: optionalString,
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(12),

  CHANNEX_API_KEY: optionalString,
  /** Production is https://app.channex.io/api/v1, the sandbox https://staging.channex.io/api/v1. */
  CHANNEX_BASE_URL: optionalString,
  /** Shared secret Channex sends back on webhook calls (set as a webhook header). */
  CHANNEX_WEBHOOK_SECRET: optionalString,
  /** Secret of the Channex signing key, when webhooks are HMAC-signed. */
  CHANNEX_WEBHOOK_SIGNING_SECRET: optionalString,

  /**
   * Shortest pause between two pushes for one property. Channex allows 10
   * requests a minute per property on each endpoint; the default stays inside that.
   */
  CHANNEX_MIN_PUSH_INTERVAL_MS: z.coerce.number().int().min(0).max(600_000).default(6_500),

  /** Background jobs one worker process runs at a time. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Restate the whole horizon to the channels once a night, as a safety net under the per-change pushes. */
  SYNC_NIGHTLY_FULL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** How many days ahead the daily comparison of channel values against the PMS looks. */
  SYNC_DRIFT_CHECK_DAYS: z.coerce.number().int().min(1).max(500).default(60),

  OTA_SIM_URL: z.string().default('http://localhost:4100'),
  OTA_SIM_PORT: z.coerce.number().int().default(4100),

  AI_PROVIDER: z.enum(['anthropic', 'openai', 'none']).optional(),
  AI_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  /** ID-document images are only sent to the LLM provider when this is on. */
  AI_DOCUMENT_CAPTURE_ENABLED: boolFromString,

  SMTP_URL: optionalString,
  MAIL_FROM: z.string().default('PMS <no-reply@localhost>'),

  RESERVATIONS_IMAP_HOST: optionalString,
  RESERVATIONS_IMAP_PORT: z.coerce.number().int().default(993),
  RESERVATIONS_IMAP_USER: optionalString,
  RESERVATIONS_IMAP_PASSWORD: optionalString,
  RESERVATIONS_IMAP_MAILBOX: z.string().default('INBOX'),
  /** Shared secret for the inbound-email HTTP hook (for mail providers that POST raw MIME). */
  INBOUND_EMAIL_SECRET: optionalString,
  /**
   * Address guests' replies are sent to (the Reply-To of messages from the
   * inbox). Its mail must be delivered to the inbound-email hook for replies
   * to show in the inbox. Without it, replies go to the property's own address.
   */
  INBOX_REPLY_ADDRESS: optionalString,

  PAYMENT_PROVIDER: z.enum(['razorpay', 'stripe', 'mock']).optional(),
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,

  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  /** Graph API version the WhatsApp calls are made against. Meta retires versions about two years after release. */
  WHATSAPP_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v27.0'),

  /** Where uploaded files (identity documents, attachments) are kept. They are encrypted before they are written. */
  STORAGE_DIR: z.string().default('./var/files'),

  BACKUP_DIR: z.string().default('./var/backups'),

  /** Requests one API key may make in a minute, on each API server. */
  API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  /**
   * Let outbound webhooks call addresses on private networks. Off in
   * production unless set: a webhook must not be a way to reach internal
   * services. On elsewhere, so a receiver on localhost can be tried out.
   */
  WEBHOOKS_ALLOW_PRIVATE_HOSTS: z.enum(['true', 'false']).optional(),
});

type Parsed = z.infer<typeof schema>;

/** The API key the bundled OTA simulator accepts. Never valid anywhere else. */
export const SIMULATOR_API_KEY = 'sim-api-key';

export type Env = Omit<
  Parsed,
  | 'APP_ENCRYPTION_KEY'
  | 'AI_PROVIDER'
  | 'PAYMENT_PROVIDER'
  | 'CHANNEX_BASE_URL'
  | 'WEBHOOKS_ALLOW_PRIVATE_HOSTS'
> & {
  WEBHOOKS_ALLOW_PRIVATE_HOSTS: boolean;
  APP_ENCRYPTION_KEY: string;
  CHANNEX_BASE_URL: string;
  /** True when channel sync talks to the bundled simulator instead of a real channel manager. */
  usingChannelSimulator: boolean;
  AI_PROVIDER: 'anthropic' | 'openai' | 'none';
  PAYMENT_PROVIDER: 'razorpay' | 'stripe' | 'mock';
  isProduction: boolean;
  isTest: boolean;
  usingDevEncryptionKey: boolean;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Walks up from `start` to the directory holding pnpm-workspace.yaml. */
export function findWorkspaceRoot(start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let envFilesLoaded = false;

/** Loads `.env` from the workspace root once. Variables already set win. */
export function loadEnvFiles(): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;
  const root = findWorkspaceRoot();
  if (!root) return;
  const file = join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const parsed = result.data;
  const isProduction = parsed.NODE_ENV === 'production';

  if (isProduction && !parsed.APP_ENCRYPTION_KEY) {
    throw new ConfigError('APP_ENCRYPTION_KEY is required in production (base64 of 32 bytes).');
  }
  const encryptionKey = parsed.APP_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY;
  for (const key of [encryptionKey, ...(parsed.APP_ENCRYPTION_KEY_PREVIOUS?.split(',') ?? [])]) {
    if (Buffer.from(key.trim(), 'base64').length !== 32) {
      throw new ConfigError('Encryption keys must be base64 encodings of exactly 32 bytes.');
    }
  }

  const aiProvider =
    parsed.AI_PROVIDER ??
    (parsed.ANTHROPIC_API_KEY ? 'anthropic' : parsed.OPENAI_API_KEY ? 'openai' : 'none');
  if (aiProvider === 'anthropic' && !parsed.ANTHROPIC_API_KEY) {
    throw new ConfigError('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
  }
  if (aiProvider === 'openai' && !parsed.OPENAI_API_KEY) {
    throw new ConfigError('AI_PROVIDER=openai requires OPENAI_API_KEY.');
  }

  const paymentProvider =
    parsed.PAYMENT_PROVIDER ??
    (parsed.RAZORPAY_KEY_ID ? 'razorpay' : parsed.STRIPE_SECRET_KEY ? 'stripe' : 'mock');
  if (isProduction && paymentProvider === 'mock' && parsed.PAYMENT_PROVIDER !== 'mock') {
    // Falling back silently to a provider that approves everything would be unsafe.
    throw new ConfigError(
      'No payment gateway is configured. Set RAZORPAY_* or STRIPE_* keys, or PAYMENT_PROVIDER=mock to opt in explicitly.',
    );
  }

  // Outside production, with no channel manager key, the bundled simulator stands in so
  // a fresh checkout syncs end to end. Production never falls back: no key means no sync.
  const simulatorUrl = `${parsed.OTA_SIM_URL.replace(/\/+$/, '')}/api/v1`;
  const useSimulator = !isProduction && !parsed.CHANNEX_API_KEY && !parsed.CHANNEX_BASE_URL;
  const channexBaseUrl = useSimulator
    ? simulatorUrl
    : (parsed.CHANNEX_BASE_URL ?? 'https://staging.channex.io/api/v1');

  return {
    ...parsed,
    CHANNEX_API_KEY: useSimulator ? SIMULATOR_API_KEY : parsed.CHANNEX_API_KEY,
    CHANNEX_BASE_URL: channexBaseUrl,
    usingChannelSimulator: channexBaseUrl.startsWith(simulatorUrl),
    APP_ENCRYPTION_KEY: encryptionKey,
    AI_PROVIDER: aiProvider,
    PAYMENT_PROVIDER: paymentProvider,
    WEBHOOKS_ALLOW_PRIVATE_HOSTS: parsed.WEBHOOKS_ALLOW_PRIVATE_HOSTS
      ? parsed.WEBHOOKS_ALLOW_PRIVATE_HOSTS === 'true'
      : !isProduction,
    isProduction,
    isTest: parsed.NODE_ENV === 'test',
    usingDevEncryptionKey: encryptionKey === DEV_ENCRYPTION_KEY,
  };
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    loadEnvFiles();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test hook: drop the memoized environment so the next getEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
