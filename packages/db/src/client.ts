import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything a query can run on: the pool-backed database or an open transaction. */
export type DbOrTx = Database | Transaction;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  url: string;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  max?: number;
  applicationName?: string;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'pms',
    // Just-in-time compilation adds around a second to planning the larger
    // statements here and never pays for itself on short transactional
    // queries. Sent as a startup option so it costs no extra round trip.
    options: '-c jit=off',
  });
  // An idle client dropped by the server must not take the process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });
  const db = drizzle(pool, { schema });
  return { db, pool, url: options.url, close: () => pool.end() };
}

/** PostgreSQL error codes the domain layer translates into business errors. */
export const PG_ERRORS = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
} as const;

export interface PgErrorInfo {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
  message: string;
}

/** Finds the PostgreSQL error inside whatever the driver or Drizzle threw. */
export function pgErrorInfo(err: unknown): PgErrorInfo | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const e = current as Record<string, unknown>;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      return {
        code: e.code,
        constraint: typeof e.constraint === 'string' ? e.constraint : undefined,
        table: typeof e.table === 'string' ? e.table : undefined,
        detail: typeof e.detail === 'string' ? e.detail : undefined,
        message: typeof e.message === 'string' ? e.message : String(current),
      };
    }
    current = e.cause;
  }
  return undefined;
}
