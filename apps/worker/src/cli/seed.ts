import { analysePendingReviews, generateAllRecommendations } from '@pms/ai';
import { getEnv } from '@pms/config';
import { createDb, runMigrations } from '@pms/db';
import { DEMO_ADMIN, seedDemo, seedDemoHistory } from '@pms/domain/testing';

// `pnpm db:seed`: fills an empty development database with a demo chain that has five weeks
// of life behind it, so that every screen has something on it.
const env = getEnv();
if (env.isProduction) {
  console.error('[seed] refusing to seed a production database');
  process.exit(1);
}
await runMigrations(env.DATABASE_URL);
const handle = createDb({ url: env.DATABASE_URL, max: 4, applicationName: 'pms-seed' });
try {
  const { orgId } = await seedDemo(handle.db);
  const lived = await seedDemoHistory(handle.db, orgId);
  // What the worker would work out overnight, so it is there on the first look.
  const read = await analysePendingReviews(handle.db, null, 100);
  const pricing = await generateAllRecommendations(handle.db);
  const suggestions = pricing.reduce((sum, run) => sum + run.created, 0);
  console.log(
    `[seed] demo data created: ${lived.days} days of history, ${lived.stays} more bookings, ` +
      `${lived.inHouse} guests in house, ${lived.invoices} invoices, ${lived.conversations} conversations, ` +
      `${read} reviews, ${suggestions} rate suggestions.`,
  );
  console.log(`[seed] sign in as ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
} catch (err) {
  console.error(`[seed] ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
