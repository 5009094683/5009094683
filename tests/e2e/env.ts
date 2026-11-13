/** Ports and URLs for a browser-test run. Chosen so they do not collide with `pnpm dev`. */
export const API_PORT = 4010;
export const WEB_PORT = 3010;
export const SIM_PORT = 4110;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
export const API_URL = `http://localhost:${API_PORT}`;

function e2eDatabaseUrl(): string {
  const base = new URL(process.env.DATABASE_URL ?? 'postgres://pms:pms@localhost:5432/pms');
  base.pathname = '/pms_e2e';
  return base.toString();
}

export const E2E_DATABASE_URL = e2eDatabaseUrl();

export const DEMO_LOGIN = { email: 'admin@example.com', password: 'demo-password-1' };

/** Where the signed-in browser state is kept between the setup step and the specs. */
export const AUTH_STATE = new URL('./.auth/admin.json', import.meta.url).pathname;
