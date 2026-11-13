import { getEnv } from '@pms/config';
import { createDb, runMigrations } from '@pms/db';
import { DEMO_ADMIN, seedDemo } from '../demo-seed';

// `pnpm db:seed`: fills an empty development database with demo data.
const env = getEnv();
if (env.isProduction) {
  console.error('[seed] refusing to seed a production database');
  process.exit(1);
}
await runMigrations(env.DATABASE_URL);
const handle = createDb({ url: env.DATABASE_URL, max: 4, applicationName: 'pms-seed' });
try {
  await seedDemo(handle.db);
  console.log(`[seed] demo data created. Sign in as ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
} catch (err) {
  console.error(`[seed] ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
