import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, type DbHandle } from './client';
import { runMigrations } from './migrate';

const TEMPLATE_DB = 'pms_test_template';

function baseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://pms:pms@localhost:5432/pms'
  );
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(baseUrl(), 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Builds the migrated template database that per-test databases are cloned
 * from. Called once per test run from the Vitest global setup.
 */
export async function prepareTestTemplate(): Promise<void> {
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  });
  await runMigrations(withDatabase(baseUrl(), TEMPLATE_DB));
}

/**
 * Drops a test database. An autovacuum worker that happens to be busy in it
 * cannot be terminated by an ordinary role, which makes the drop fail for a
 * moment; that is retried, and a database that still cannot be dropped is
 * left for the next run's clean-up rather than failing the tests.
 */
async function dropDatabase(name: string): Promise<void> {
  await admin(async (client) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        // 42501: cannot terminate another role's backend. 55006: still in use.
        if (code !== '42501' && code !== '55006') throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  });
}

/** Removes databases left behind by test runs that were killed before cleanup. */
export async function dropStaleTestDatabases(): Promise<void> {
  const names = await admin(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'pms_test_%' AND datname <> $1`,
      [TEMPLATE_DB],
    );
    return rows.map((r) => r.datname);
  });
  for (const name of names) await dropDatabase(name);
}

export interface TestDatabase extends DbHandle {
  name: string;
  drop(): Promise<void>;
}

/** Creates an isolated, fully migrated database for one test file. */
export async function createTestDatabase(options: { max?: number } = {}): Promise<TestDatabase> {
  const name = `pms_test_${randomBytes(6).toString('hex')}`;
  await admin(async (client) => {
    // Cloning fails while another clone of the same template is in flight on
    // some PostgreSQL versions, so retry briefly instead of failing the file.
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE "${name}" TEMPLATE ${TEMPLATE_DB}`);
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== '55006' || attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      }
    }
  });
  const url = withDatabase(baseUrl(), name);
  const handle = createDb({ url, max: options.max ?? 10, applicationName: 'pms-test' });
  return {
    ...handle,
    name,
    async drop() {
      await handle.close();
      await dropDatabase(name);
    },
  };
}
