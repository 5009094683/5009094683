/**
 * Creates a fresh database for a browser-test run and fills it with the demo
 * organisation. Runs before the API server starts.
 */
import pg from 'pg';
import { createDb, runMigrations } from '@pms/db';
import { seedDemo } from '@pms/domain/testing';
import { E2E_DATABASE_URL } from './env';

const target = new URL(E2E_DATABASE_URL);
const database = target.pathname.slice(1);
if (!/^pms_e2e\w*$/.test(database)) {
  // The database is dropped below, so insist on a name that can only be a test database.
  throw new Error(
    `Refusing to recreate "${database}": browser tests need a database named pms_e2e*.`,
  );
}

const adminUrl = new URL(E2E_DATABASE_URL);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
await admin.query(`CREATE DATABASE "${database}"`);
await admin.end();

await runMigrations(E2E_DATABASE_URL);
const handle = createDb({ url: E2E_DATABASE_URL, max: 4, applicationName: 'pms-e2e-setup' });
try {
  await seedDemo(handle.db);
} finally {
  await handle.close();
}
console.log(`[e2e] database ${database} ready`);
