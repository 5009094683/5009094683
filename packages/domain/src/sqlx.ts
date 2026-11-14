import { sql, type SQL } from 'drizzle-orm';
import { PG_ERRORS, pgErrorInfo, type DbOrTx, type Transaction } from '@pms/db';
import { DomainError } from './errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A uuid[] parameter. The whole array travels as one parameter (a PostgreSQL
 * array literal), so the planner sees its real length and estimates joins
 * against it correctly. A JS array interpolated directly would become a
 * record, not an array.
 */
export function uuidArray(ids: readonly string[]): SQL {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`Not a UUID: ${id}`);
  }
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/** A date[] parameter, passed the same way as `uuidArray`. */
export function dateArray(dates: readonly string[]): SQL {
  for (const date of dates) {
    if (!DATE_RE.test(date)) throw new Error(`Not a date: ${date}`);
  }
  return sql`${`{${dates.join(',')}}`}::date[]`;
}

export function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** A JSON document parameter, for `jsonb_to_recordset` and friends. */
export function jsonParam(value: unknown): SQL {
  return sql`${JSON.stringify(value)}::jsonb`;
}

/** Raw queries return timestamptz as text like `2026-11-13 12:30:19.137709+00`. */
export function parsePgTimestamp(value: string | Date | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  let iso = value.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  return new Date(iso);
}

/**
 * Turns the database's own refusals into errors a caller can act on. The
 * constraints are the final guard; these messages are what a user sees when
 * a race slips past the earlier checks.
 */
export function translatePgError(err: unknown): unknown {
  if (err instanceof DomainError) return err;
  const pg = pgErrorInfo(err);
  if (!pg) return err;
  if (pg.code === PG_ERRORS.exclusionViolation && pg.constraint === 'unit_no_overlap') {
    return new DomainError('unit_occupied', 'That unit is already taken on some of those dates');
  }
  if (pg.code === PG_ERRORS.checkViolation && pg.constraint === 'not_oversold') {
    return new DomainError('no_availability', 'Not enough availability for those dates');
  }
  if (pg.code === PG_ERRORS.checkViolation && pg.constraint?.startsWith('units_link')) {
    return new DomainError('validation', pg.message);
  }
  if (pg.code === PG_ERRORS.deadlockDetected || pg.code === PG_ERRORS.serializationFailure) {
    return new DomainError(
      'conflict',
      'Another change was being saved at the same moment. Try again.',
      {
        retryable: true,
      },
    );
  }
  return err;
}

/** Runs `fn`, translating database refusals into domain errors. */
export async function withPgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw translatePgError(err);
  }
}

function isTransaction(db: DbOrTx): boolean {
  return typeof (db as { rollback?: unknown }).rollback === 'function';
}

/**
 * Runs `fn` in a transaction (a savepoint when already inside one) and
 * translates database refusals. A top-level transaction that loses a deadlock
 * or a serialisation race is retried, since the loser did nothing wrong.
 *
 * `fn` must only touch the database: it may run more than once.
 */
export async function transact<T>(db: DbOrTx, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const nested = isTransaction(db);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (err) {
      const code = pgErrorInfo(err)?.code;
      const retryable =
        code === PG_ERRORS.deadlockDetected || code === PG_ERRORS.serializationFailure;
      if (!retryable || nested || attempt >= 3) throw translatePgError(err);
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1) + Math.random() * 40));
    }
  }
}
