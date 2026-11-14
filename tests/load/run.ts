/**
 * A load run against the real API, worker and channel simulator, talking over
 * HTTP on local ports with a database of their own (`pms_load`, created here
 * and dropped at the end).
 *
 *   pnpm test:load                 # the standard run
 *   LOAD_SCALE=3 pnpm test:load    # three times the requests
 *
 * It measures the paths that carry the load in practice (guests searching,
 * staff reading the calendar, bookings arriving from booking sites, rates
 * being changed) and checks the one thing that must hold under any load: the
 * last room is sold once. The run fails when a limit below is missed.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { buildApp } from '@pms/api/app';
import { resetChannexThrottle } from '@pms/channels';
import { parseEnv, resetEnvCache } from '@pms/config';
import { createDb, runMigrations } from '@pms/db';
import { addDays, MemoryFileStore, MemoryMailer, todayIn, updateProperty } from '@pms/domain';
import { createTestHotel, createTestOrg, TEST_PASSWORD } from '@pms/domain/testing';
import { buildSim, CHANNELS, type ChannelCode } from '@pms/ota-sim';
import { silentLogger, Worker } from '@pms/worker';

const SCALE = Math.max(0.1, Number(process.env.LOAD_SCALE ?? 1));
const n = (count: number): number => Math.max(1, Math.round(count * SCALE));

/** What the run must achieve. Milliseconds unless said otherwise. */
const LIMITS = {
  searchP95: 400,
  calendarP95: 600,
  rateChangeP95: 600,
  /** From a guest booking on a site to the room being closed on every other site. */
  bookingSyncSeconds: 60,
  rateSyncSeconds: 90,
  errorShare: 0.001,
};

const SIM_KEY = 'load-test-key';
const TZ = 'Asia/Kolkata';
const day = (offset: number): string => addDays(todayIn(TZ), offset);

interface Sample {
  ms: number;
  status: number;
}

interface Result {
  name: string;
  requests: number;
  seconds: number;
  perSecond: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: number;
}

function summarise(name: string, samples: Sample[], seconds: number, ok: number[]): Result {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number): number =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return {
    name,
    requests: samples.length,
    seconds: Math.round(seconds * 10) / 10,
    perSecond: Math.round(samples.length / seconds),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    errors: samples.filter((s) => !ok.includes(s.status)).length,
  };
}

/** Runs `total` calls, `concurrency` at a time, and times each. */
async function run(
  name: string,
  total: number,
  concurrency: number,
  call: (index: number) => Promise<number>,
  ok: number[] = [200, 201],
): Promise<Result & { samples: Sample[] }> {
  const samples: Sample[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= total) return;
        const begun = performance.now();
        // A call that could not be made at all counts as status 0.
        const status = await call(index).catch(() => 0);
        samples.push({ ms: performance.now() - begun, status });
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  return { ...summarise(name, samples, seconds, ok), samples };
}

async function until(
  what: string,
  check: () => Promise<boolean>,
  timeoutSeconds: number,
): Promise<number> {
  const started = performance.now();
  for (;;) {
    if (await check()) return (performance.now() - started) / 1000;
    if ((performance.now() - started) / 1000 > timeoutSeconds) {
      throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const base = new URL(process.env.DATABASE_URL ?? 'postgres://pms:pms@localhost:5432/pms');
const withDatabase = (name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

async function recreateDatabase(name: string, create: boolean): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase('postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    if (create) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const database = 'pms_load';
  await recreateDatabase(database, true);
  const databaseUrl = withDatabase(database);
  await runMigrations(databaseUrl);

  const sim = buildSim({ apiKeys: [SIM_KEY], webhookRetryDelaysMs: [200, 500, 1_000, 2_000] });
  const { url: simUrl, apiUrl: channexUrl } = await sim.listen();
  // The run measures this system, not the channel manager's request limits: those have their own tests.
  sim.state.ariLimitPerMinute = 1_000_000;

  const overrides = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '20',
    CHANNEX_API_KEY: SIM_KEY,
    CHANNEX_BASE_URL: channexUrl,
    CHANNEX_WEBHOOK_SECRET: 'load-webhook-secret',
    CHANNEX_MIN_PUSH_INTERVAL_MS: '0',
    OTA_SIM_URL: simUrl,
  };
  Object.assign(process.env, overrides);
  resetEnvCache();
  resetChannexThrottle();
  const env = parseEnv({ ...process.env, ...overrides });
  const handle = createDb({ url: databaseUrl, max: 20, applicationName: 'pms-load' });
  const mailer = new MemoryMailer();
  const files = new MemoryFileStore();
  const app = await buildApp({ handle, env, mailer, files, ai: null, logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const api = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  env.API_PUBLIC_URL = api;
  const worker = new Worker({ handle, env, log: silentLogger, mailer, files, ai: null });
  await worker.start();

  const results: Result[] = [];
  const failures: string[] = [];
  try {
    // A hotel of fifty rooms, selling on its own website and on five booking sites.
    const org = await createTestOrg(handle.db, 'Load Test Hotels');
    const hotel = await createTestHotel(handle.db, org, { standardRooms: 40, deluxeRooms: 10 });
    await updateProperty(handle.db, org.admin, hotel.property.id, {
      settings: { bookingEngineEnabled: true, bookingPayment: 'none' },
    });

    let cookie = '';
    const login = await fetch(`${api}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: org.admin.label, password: TEST_PASSWORD }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    if (!login.ok || !cookie) throw new Error(`Could not sign in: ${login.status}`);
    const staff = async (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(`${api}${path}`, {
        method,
        headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    const json = async <T>(response: Response): Promise<T> => {
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      return (await response.json()) as T;
    };

    const connection = await json<{ id: string }>(
      await staff('POST', '/channels/connections', {
        propertyId: hotel.property.id,
        adapter: 'channex',
      }),
    );
    const { externalPropertyId } = await json<{ externalPropertyId: string }>(
      await staff('POST', `/channels/connections/${connection.id}/channex/provision`),
    );
    await json(await staff('POST', '/channels/channex/webhook'));
    const mappings = await json<{
      roomTypes: { roomTypeId: string; externalId: string }[];
      ratePlans: { ratePlanId: string; externalId: string }[];
    }>(await staff('GET', `/channels/connections/${connection.id}/mappings`));
    await json(
      await staff('PATCH', `/channels/connections/${connection.id}`, { status: 'active' }),
    );
    const pending = async (): Promise<number> => {
      const { rows } = await handle.db.execute<{ waiting: number }>(sql`
        SELECT ((SELECT count(*) FROM outbox WHERE kind LIKE 'ari.%') + (SELECT count(*) FROM sync_queue))::int AS waiting
      `);
      return rows[0]?.waiting ?? 0;
    };
    await until(
      'the first full sync',
      async () => {
        const { connection: c } = await json<{ connection: { lastFullSyncAt: string | null } }>(
          await staff('GET', `/channels/connections/${connection.id}`),
        );
        return c.lastFullSyncAt !== null && (await pending()) === 0;
      },
      60,
    );
    const externalRoom = (id: string): string =>
      mappings.roomTypes.find((m) => m.roomTypeId === id)!.externalId;
    const externalRate = (id: string): string =>
      mappings.ratePlans.find((m) => m.ratePlanId === id)!.externalId;
    const channels = Object.keys(CHANNELS) as ChannelCode[];
    const shown = (roomTypeId: string, date: string): (number | undefined)[] =>
      sim.state
        .channelsOf(externalPropertyId)
        .filter((c) => c.active)
        .map((c) => c.view.get(externalRoom(roomTypeId))?.get(date));

    // 1. Guests searching for dates on the hotel's own website.
    const searches = await run('Website search', n(3_000), 50, async (i) => {
      const from = 5 + (i % 150);
      const response = await fetch(
        `${api}/public/properties/${hotel.property.code}/availability?checkIn=${day(from)}&checkOut=${day(from + 1 + (i % 5))}&adults=2`,
        // Each guest has an address of their own, as they do in real life.
        { headers: { 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` } },
      );
      await response.arrayBuffer();
      return response.status;
    });
    results.push(searches);
    if (searches.p95 > LIMITS.searchP95) {
      failures.push(`Website search p95 ${searches.p95} ms is over ${LIMITS.searchP95} ms`);
    }

    // 2. Staff looking at the calendar: a month of every room.
    const calendar = await run('Calendar (30 days, 50 rooms)', n(600), 20, async (i) => {
      const from = i % 60;
      const response = await staff(
        'GET',
        `/calendar?from=${day(from)}&to=${day(from + 30)}&propertyIds=${hotel.property.id}`,
      );
      await response.arrayBuffer();
      return response.status;
    });
    results.push(calendar);
    if (calendar.p95 > LIMITS.calendarP95) {
      failures.push(`Calendar p95 ${calendar.p95} ms is over ${LIMITS.calendarP95} ms`);
    }

    // 3. Bookings arriving from the booking sites, each of which must close the room on the others.
    const bookings = n(300);
    const before = performance.now();
    for (let i = 0; i < bookings; i++) {
      // Spread over four months so that nights are not oversold: this part is about volume.
      const from = 10 + ((i * 7) % 110);
      sim.state.createBooking({
        propertyId: externalPropertyId,
        channel: channels[i % channels.length]!,
        rooms: [
          {
            roomTypeId: externalRoom(hotel.standard.roomType.id),
            ratePlanId: externalRate(hotel.standard.ratePlan.id),
            checkIn: day(from),
            checkOut: day(from + 1 + (i % 3)),
          },
        ],
        customer: { name: 'Guest', surname: `Number ${i}` },
      });
      // Bookings come in a stream, not all in the same instant.
      if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const drained = await until(
      'every booking to be recorded and every site to be told',
      async () => {
        const { rows } = await handle.db.execute<{ recorded: number; waiting: number }>(sql`
          SELECT (SELECT count(*) FROM reservations WHERE channel_reservation_code IS NOT NULL)::int AS recorded,
                 (SELECT count(*) FROM booking_revisions WHERE status IN ('received', 'failed'))::int AS waiting
        `);
        return rows[0]!.recorded >= bookings && rows[0]!.waiting === 0 && (await pending()) === 0;
      },
      LIMITS.bookingSyncSeconds,
    ).catch((err: Error) => {
      failures.push(err.message);
      return LIMITS.bookingSyncSeconds;
    });
    const bookingSeconds = (performance.now() - before) / 1000;
    results.push({
      name: 'Bookings from booking sites',
      requests: bookings,
      seconds: Math.round(bookingSeconds * 10) / 10,
      perSecond: Math.round(bookings / bookingSeconds),
      p50: 0,
      p95: 0,
      p99: 0,
      max: Math.round(drained * 1000),
      errors: 0,
    });
    const { rows: overbooked } = await handle.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM reservations WHERE overbooked`,
    );
    if (overbooked[0]!.count > 0) {
      failures.push(`${overbooked[0]!.count} bookings were recorded as overbooked`);
    }

    // 4. Rates being changed, each change going out to every site.
    const rateDays = new Set<string>();
    const rates = await run('Rate changes', n(200), 10, async (i) => {
      const from = 5 + (i % 170);
      rateDays.add(day(from));
      const response = await staff('POST', `/properties/${hotel.property.id}/rates`, {
        ratePlanId: hotel.standard.ratePlan.id,
        from: day(from),
        to: day(from + 1),
        change: { rate: 500_000 + i * 100 },
      });
      await response.arrayBuffer();
      return response.status;
    });
    results.push(rates);
    if (rates.p95 > LIMITS.rateChangeP95) {
      failures.push(`Rate change p95 ${rates.p95} ms is over ${LIMITS.rateChangeP95} ms`);
    }
    const rateSync = await until(
      'the rate changes to reach the booking sites',
      async () => (await pending()) === 0,
      LIMITS.rateSyncSeconds,
    ).catch((err: Error) => {
      failures.push(err.message);
      return LIMITS.rateSyncSeconds;
    });
    results.push({
      name: 'Rates reaching the booking sites',
      requests: rateDays.size,
      seconds: Math.round(rateSync * 10) / 10,
      perSecond: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: Math.round(rateSync * 1000),
      errors: 0,
    });

    // 5. The last room, wanted by many at the same moment. It is sold once.
    const night = day(200);
    const deluxe = hotel.deluxe;
    // Nine of the ten deluxe rooms are already taken that night.
    for (let i = 0; i < 9; i++) {
      await json(
        await staff('POST', '/reservations', {
          propertyId: hotel.property.id,
          source: 'phone',
          guest: { firstName: 'Early', lastName: `Bird ${i}` },
          rooms: [
            {
              roomTypeId: deluxe.roomType.id,
              ratePlanId: deluxe.ratePlan.id,
              checkIn: night,
              checkOut: addDays(night, 1),
              adults: 2,
            },
          ],
        }),
      );
    }
    const rush = await run(
      'Last room, 60 guests at once',
      60,
      60,
      async (i) => {
        const response = await fetch(`${api}/public/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': `172.20.${i}.9` },
          body: JSON.stringify({
            propertyCode: hotel.property.code,
            checkIn: night,
            checkOut: addDays(night, 1),
            rooms: [{ roomTypeId: deluxe.roomType.id, ratePlanId: deluxe.ratePlan.id, adults: 2 }],
            guest: { firstName: 'Rush', lastName: `Guest ${i}`, email: `rush${i}@example.com` },
            acceptTerms: true,
          }),
        });
        await response.arrayBuffer();
        return response.status;
      },
      [201, 409],
    );
    results.push(rush);
    const won = rush.samples.filter((s) => s.status === 201).length;
    const refused = rush.samples.filter((s) => s.status === 409).length;
    if (won !== 1 || refused !== 59) {
      failures.push(
        `The last room was sold ${won} times and refused ${refused} times (expected 1 and 59)`,
      );
    }
    await until(
      'the sold-out night to be closed on every site',
      async () => {
        const seen = shown(deluxe.roomType.id, night);
        return seen.length > 0 && seen.every((count) => count === 0);
      },
      30,
    ).catch((err: Error) => failures.push(err.message));

    const requests = results.reduce((sum, r) => sum + r.requests, 0);
    const errors = results.reduce((sum, r) => sum + r.errors, 0);
    if (errors / requests > LIMITS.errorShare) {
      failures.push(`${errors} of ${requests} requests failed`);
    }
  } finally {
    await worker.stop();
    await app.close();
    await sim.close();
    await handle.close();
    await recreateDatabase(database, false);
  }

  console.log('');
  console.table(
    results.map((r) => ({
      Scenario: r.name,
      Requests: r.requests,
      Seconds: r.seconds,
      'Per second': r.perSecond || '',
      'p50 ms': r.p50 || '',
      'p95 ms': r.p95 || '',
      'p99 ms': r.p99 || '',
      'Longest ms': r.max,
      Failed: r.errors,
    })),
  );
  if (failures.length > 0) {
    console.error(`\nThe run missed its limits:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('\nEvery limit was met.');
  process.exit(0);
}

await main();
