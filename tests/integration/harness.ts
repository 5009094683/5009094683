import { eq } from 'drizzle-orm';
import { createTestApp, type TestApp, type TestClient } from '@pms/api/testing';
import { resetChannexThrottle, type ConnectionSummary } from '@pms/channels';
import { resetEnvCache } from '@pms/config';
import { alerts } from '@pms/db';
import { addDays, todayIn, type DateString } from '@pms/domain';
import {
  createTestHotel,
  createTestVilla,
  type TestHotel,
  type TestVilla,
} from '@pms/domain/testing';
import { buildSim, type ChannelCode, type Sim } from '@pms/ota-sim';
import { silentLogger, Worker } from '@pms/worker';

export const SIM_API_KEY = 'integration-test-key';
export const WEBHOOK_SECRET = 'integration-webhook-secret';

export interface Stack {
  sim: Sim;
  simUrl: string;
  api: TestApp;
  apiUrl: string;
  admin: TestClient;
  worker: Worker;
  stop(): Promise<void>;
}

export interface StackOptions {
  /** Extra environment for the API and worker. */
  env?: Record<string, string>;
  /** Sign the simulator's webhooks (and expect the API to verify them). */
  signingSecret?: string;
  startWorker?: boolean;
}

/**
 * Starts the real API and the real worker against a fresh database, plus the
 * OTA simulator standing in for the channel manager. They talk over real
 * HTTP on local ports, as they would in production.
 */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const sim = buildSim({
    apiKeys: [SIM_API_KEY],
    signingSecret: options.signingSecret,
    webhookRetryDelaysMs: [40, 80, 160, 320],
    nonAckedCheckMs: 0,
  });
  const { url: simUrl, apiUrl: channexUrl } = await sim.listen();
  // Tests issue many pushes in a short time; the limit has its own test.
  sim.state.ariLimitPerMinute = 10_000;

  const overrides: Record<string, string> = {
    CHANNEX_API_KEY: SIM_API_KEY,
    CHANNEX_BASE_URL: channexUrl,
    CHANNEX_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CHANNEX_MIN_PUSH_INTERVAL_MS: '0',
    OTA_SIM_URL: simUrl,
    ...(options.signingSecret ? { CHANNEX_WEBHOOK_SIGNING_SECRET: options.signingSecret } : {}),
    ...options.env,
  };
  // Adapters read the process environment, so it has to agree with what the API is given.
  Object.assign(process.env, overrides);
  resetEnvCache();
  resetChannexThrottle();

  const api = await createTestApp(overrides);
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  const address = api.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const apiUrl = `http://127.0.0.1:${port}`;
  // The address the channel manager is told to call back on.
  api.env.API_PUBLIC_URL = apiUrl;

  const worker = new Worker({
    handle: api.t,
    env: api.env,
    log: silentLogger,
    // The same in-memory mail server and file store as the API, so tests can look at what was sent.
    mailer: api.mailer,
    files: api.files,
    timings: {
      syncIdleMs: 250,
      syncDebounceMs: 10,
      jobIdleMs: 100,
      scheduleMs: 400,
      heartbeatMs: 2_000,
    },
  });
  if (options.startWorker !== false) await worker.start();

  return {
    sim,
    simUrl,
    api,
    apiUrl,
    admin: await api.admin(),
    worker,
    async stop() {
      await worker.stop();
      await api.close();
      await sim.close();
    },
  };
}

export const TZ = 'Asia/Kolkata';
export const day = (offset: number): DateString => addDays(todayIn(TZ), offset);

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 40));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function ok<T>(
  res: { statusCode: number; body: string; json(): unknown },
  expected = [200, 201, 202],
): T {
  if (!expected.includes(res.statusCode))
    throw new Error(`Unexpected ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

export interface ConnectedProperty {
  propertyId: string;
  connectionId: string;
  /** The property's id in the simulated channel manager. */
  externalPropertyId: string;
  /** PMS room type id -> channel manager room type id */
  rooms: Record<string, string>;
  /** PMS rate plan id -> channel manager rate plan id */
  rates: Record<string, string>;
}

/**
 * Takes a PMS property live through the API, the way an administrator would:
 * add the connection, set the property up in the channel manager, register
 * the webhook, switch the connection on, and wait for the first full sync.
 */
export async function goLive(stack: Stack, propertyId: string): Promise<ConnectedProperty> {
  const { admin } = stack;
  const connection = ok<ConnectionSummary>(
    await admin.post('/channels/connections', { propertyId, adapter: 'channex' }),
  );
  const provisioned = ok<{ externalPropertyId: string }>(
    await admin.post(`/channels/connections/${connection.id}/channex/provision`),
  );
  ok(await admin.post('/channels/channex/webhook'));
  const mappings = ok<{
    roomTypes: { roomTypeId: string; externalId: string }[];
    ratePlans: { ratePlanId: string; externalId: string }[];
  }>(await admin.get(`/channels/connections/${connection.id}/mappings`));
  ok(await admin.patch(`/channels/connections/${connection.id}`, { status: 'active' }));
  // Going live sends everything once, and the worker makes its first check for waiting
  // bookings. Waiting for both means that afterwards only the test causes anything.
  await waitFor('the first full sync and the first check for bookings', async () => {
    const c = await connectionOf(stack, connection.id);
    return c.lastFullSyncAt !== null && c.pendingChanges === 0 && c.lastPullAt !== null;
  });
  return {
    propertyId,
    connectionId: connection.id,
    externalPropertyId: provisioned.externalPropertyId,
    rooms: Object.fromEntries(mappings.roomTypes.map((m) => [m.roomTypeId, m.externalId])),
    rates: Object.fromEntries(mappings.ratePlans.map((m) => [m.ratePlanId, m.externalId])),
  };
}

export async function connectionOf(stack: Stack, connectionId: string): Promise<ConnectionSummary> {
  const res = await stack.admin.get(`/channels/connections/${connectionId}`);
  const body = ok<{ connection: ConnectionSummary }>(res);
  // Dates arrive as text over HTTP.
  return body.connection;
}

export async function liveHotel(
  stack: Stack,
  options: { standardRooms?: number; deluxeRooms?: number } = {},
): Promise<{ hotel: TestHotel; live: ConnectedProperty }> {
  const hotel = await createTestHotel(stack.api.t.db, stack.api.org, options);
  return { hotel, live: await goLive(stack, hotel.property.id) };
}

export async function liveVilla(
  stack: Stack,
): Promise<{ villa: TestVilla; live: ConnectedProperty }> {
  const villa = await createTestVilla(stack.api.t.db, stack.api.org);
  return { villa, live: await goLive(stack, villa.property.id) };
}

/** What one booking site shows as bookable for a room on a date (null: it has never been told). */
export function shownOn(
  stack: Stack,
  live: ConnectedProperty,
  channel: ChannelCode,
  roomTypeId: string,
  date: string,
): number | null {
  const sim = stack.sim.state.channelsOf(live.externalPropertyId).find((c) => c.code === channel);
  return sim?.view.get(live.rooms[roomTypeId]!)?.get(date) ?? null;
}

/** What every connected site shows for a room on a date. */
export function shownEverywhere(
  stack: Stack,
  live: ConnectedProperty,
  roomTypeId: string,
  date: string,
): (number | null)[] {
  return stack.sim.state
    .channelsOf(live.externalPropertyId)
    .filter((c) => c.active)
    .map((c) => c.view.get(live.rooms[roomTypeId]!)?.get(date) ?? null);
}

/** A guest books on a site. Returns the simulator's booking id and the site's confirmation code. */
export function guestBooks(
  stack: Stack,
  live: ConnectedProperty,
  channel: ChannelCode,
  stay: {
    roomTypeId: string;
    ratePlanId?: string | null;
    checkIn: string;
    checkOut: string;
    adults?: number;
  },
  options: {
    force?: boolean;
    guest?: { name: string; surname: string; mail?: string; phone?: string };
    silent?: boolean;
    insertedAt?: string;
  } = {},
): { id: string; code: string } {
  const booking = stack.sim.state.createBooking({
    propertyId: live.externalPropertyId,
    channel,
    rooms: [
      {
        roomTypeId: live.rooms[stay.roomTypeId] ?? stay.roomTypeId,
        ratePlanId: stay.ratePlanId ? (live.rates[stay.ratePlanId] ?? stay.ratePlanId) : null,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: stay.adults,
      },
    ],
    customer: options.guest,
    force: options.force,
    silent: options.silent,
    insertedAt: options.insertedAt,
  });
  return { id: booking.id, code: booking.otaReservationCode };
}

export interface ReservationSummary {
  id: string;
  code: string;
  status: string;
  channelCode: string | null;
  channelReservationCode: string | null;
  checkIn: string;
  checkOut: string;
  guestName: string;
  overbooked: boolean;
  needsReview: boolean;
  totalAmount: number;
}

/** The PMS reservation for a site's confirmation code, once it exists. */
export async function reservationFor(
  stack: Stack,
  code: string,
): Promise<ReservationSummary | undefined> {
  const res = await stack.admin.get(`/reservations?search=${encodeURIComponent(code)}&limit=50`);
  const body = ok<{ reservations: ReservationSummary[] }>(res);
  return body.reservations.find((r) => r.channelReservationCode === code);
}

export async function openAlerts(stack: Stack, kind?: string) {
  const rows = await stack.api.t.db
    .select()
    .from(alerts)
    .where(eq(alerts.orgId, stack.api.org.orgId));
  return rows.filter((a) => a.status !== 'resolved' && (!kind || a.kind === kind));
}

/** ARI requests the simulator has received, optionally only since a point in its log. */
export function ariRequests(stack: Stack, since = 0) {
  return stack.sim.state.requestLog
    .slice(since)
    .filter(
      (r) => r.method === 'POST' && (r.path === '/availability' || r.path === '/restrictions'),
    );
}
