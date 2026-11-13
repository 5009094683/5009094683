import { parseEnv, type Env } from '@pms/config';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { MemoryMailer } from '@pms/domain';
import { TEST_PASSWORD, createTestOrg, type TestOrg } from '@pms/domain/testing';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp, type App } from './app';

export interface TestApp {
  app: App;
  t: TestDatabase;
  org: TestOrg;
  mailer: MemoryMailer;
  env: Env;
  /** Signs in and returns a client that sends the session cookie. */
  login(email: string, password?: string): Promise<TestClient>;
  /** A client signed in as the organisation admin created with the test org. */
  admin(): Promise<TestClient>;
  anonymous(): TestClient;
  close(): Promise<void>;
}

export interface TestClient {
  cookie: string | undefined;
  request(options: InjectOptions): Promise<LightMyRequestResponse>;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  put(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, body?: unknown): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
}

function sessionCookieFrom(res: LightMyRequestResponse): string | undefined {
  const cookie = res.cookies.find((c) => c.name === 'pms_session');
  return cookie && cookie.value ? `pms_session=${cookie.value}` : undefined;
}

function client(app: App, initialCookie?: string): TestClient {
  const self: TestClient = {
    cookie: initialCookie,
    async request(options) {
      const headers: Record<string, string> = {
        ...(options.headers as Record<string, string> | undefined),
      };
      if (self.cookie && !headers.cookie) headers.cookie = self.cookie;
      const res = await app.inject({ ...options, headers });
      const updated = sessionCookieFrom(res);
      if (updated) self.cookie = updated;
      return res;
    },
    get: (url) => self.request({ method: 'GET', url }),
    post: (url, body) => self.request({ method: 'POST', url, payload: (body ?? {}) as object }),
    put: (url, body) => self.request({ method: 'PUT', url, payload: (body ?? {}) as object }),
    patch: (url, body) => self.request({ method: 'PATCH', url, payload: (body ?? {}) as object }),
    delete: (url) => self.request({ method: 'DELETE', url }),
  };
  return self;
}

export async function createTestApp(envOverrides: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestDatabase();
  const env = parseEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: t.url, ...envOverrides });
  const mailer = new MemoryMailer();
  const app = await buildApp({ handle: t, env, mailer, logger: false });
  await app.ready();
  const org = await createTestOrg(t.db);

  const login = async (email: string, password = TEST_PASSWORD): Promise<TestClient> => {
    const c = client(app);
    const res = await c.post('/auth/login', { email, password });
    if (res.statusCode !== 200)
      throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
    return c;
  };

  return {
    app,
    t,
    org,
    mailer,
    env,
    login,
    admin: () => login(org.admin.label),
    anonymous: () => client(app),
    async close() {
      await app.close();
      await t.drop();
    },
  };
}
