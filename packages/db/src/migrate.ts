import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from './client';

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Arbitrary constant identifying the migration lock among advisory locks. */
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies pending migrations. An advisory lock serialises processes that boot
 * at the same time (API and worker), so each migration runs exactly once.
 * The lock is held on its own connection; the migrator uses a separate one.
 */
export async function runMigrations(url: string): Promise<void> {
  const lockClient = new pg.Client({ connectionString: url, application_name: 'pms-migrate-lock' });
  await lockClient.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const handle = createDb({ url, max: 1, applicationName: 'pms-migrate' });
    try {
      await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await handle.close();
    }
  } finally {
    // Closing the connection releases the session-level advisory lock.
    await lockClient.end();
  }
}
