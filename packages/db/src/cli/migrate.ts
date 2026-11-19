import { getEnv } from '@pms/config';
import { runMigrations } from '../migrate';

const env = getEnv();
const target = new URL(env.DATABASE_URL);
console.log(`[migrate] applying migrations to ${target.host}${target.pathname}`);
await runMigrations(env.DATABASE_URL);
console.log('[migrate] up to date');
