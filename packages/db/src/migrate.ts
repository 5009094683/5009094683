import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { findWorkspaceRoot } from '@pms/config';
import { createDb } from './client';

/** Arbitrary constant identifying the migration lock among advisory locks. */
const MIGRATION_LOCK_ID = 727_001;

/**
 * Locates the SQL migrations. Sources run from `packages/db/src`; bundled
 * builds copy the folder next to the bundle; containers may set
 * PMS_MIGRATIONS_DIR explicitly.
 */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot();
  const candidates = [
    process.env.PMS_MIGRATIONS_DIR,
    join(here, '..', 'migrations'),
    join(here, 'migrations'),
    root ? join(root, 'packages', 'db', 'migrations') : undefined,
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return resolve(candidate);
  }
  throw new Error(`Database migrations not found. Looked in: ${candidates.join(', ')}`);
}

/**
 * Applies pending migrations. An advisory lock serialises processes that boot
 * at the same time (API and worker), so each migration runs exactly once.
 * The lock is held on its own connection; the migrator uses a separate one.
 */
export async function runMigrations(url: string): Promise<void> {
  const folder = migrationsFolder();
  const lockClient = new pg.Client({ connectionString: url, application_name: 'pms-migrate-lock' });
  await lockClient.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const handle = createDb({ url, max: 1, applicationName: 'pms-migrate' });
    try {
      await migrate(handle.db, { migrationsFolder: folder });
    } finally {
      await handle.close();
    }
  } finally {
    // Closing the connection releases the session-level advisory lock.
    await lockClient.end();
  }
}
