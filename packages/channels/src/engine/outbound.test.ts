import { eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, channelConnections, syncLog, syncQueue } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import {
  addDays,
  cancelReservation,
  createBlock,
  createReservation,
  setRates,
  todayIn,
  type DateString,
} from '@pms/domain';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from '@pms/domain/testing';
import { type FakeChannel, fakeChannelFor, useFakeChannels } from '../testing';
import { createConnection, listConnections, saveMappings, updateConnection } from './connections';
import {
  compressDays,
  connectionsDue,
  dispatchConnection,
  dispatchDue,
  nextDispatchAt,
} from './dispatcher';
import { routeOutbox } from './router';
import { requestDueFullSyncs } from './schedule';

let t: TestDatabase;
let org: TestOrg;

const TZ = 'Asia/Kolkata';
const day = (offset: number): DateString => addDays(todayIn(TZ), offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  useFakeChannels();
});
afterAll(async () => {
  await t.drop();
});

interface Connected {
  hotel: TestHotel;
  connectionId: string;
  channel: FakeChannel;
}

/** A hotel connected to its own in-memory channel, with its first full sync already delivered. */
async function connectHotel(
  options: { standardRooms?: number; deluxeRooms?: number } = {},
): Promise<Connected> {
  const hotel = await createTestHotel(t.db, org, options);
  const connection = await createConnection(t.db, org.admin, {
    propertyId: hotel.property.id,
    adapter: 'channex',
  });
  await saveMappings(t.db, org.admin, connection.id, {
    roomTypes: [
      { roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' },
      { roomTypeId: hotel.deluxe.roomType.id, externalId: 'ext-dlx' },
    ],
    ratePlans: [
      { ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' },
      { ratePlanId: hotel.deluxe.ratePlan.id, externalId: 'ext-dlx-bar' },
    ],
  });
  await updateConnection(t.db, org.admin, connection.id, { status: 'active' });
  const channel = fakeChannelFor(connection.id);
  await sync();
  channel.pushes.length = 0;
  return { hotel, connectionId: connection.id, channel };
}

/** What the worker does on every wake-up: fan the outbox out, then send. */
async function sync(now: Date = new Date()) {
  await routeOutbox(t.db);
  return dispatchDue(t.db, now);
}

const book = (hotel: TestHotel, checkIn: DateString, checkOut: DateString) =>
  createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'direct',
    guest: { firstName: 'Meera', lastName: 'Iyer' },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn,
        checkOut,
        adults: 2,
      },
    ],
  });

const connectionRow = async (id: string) =>
  (await t.db.select().from(channelConnections).where(eq(channelConnections.id, id)))[0]!;

const queueSize = async (id: string) =>
  (await t.db.select().from(syncQueue).where(eq(syncQueue.connectionId, id))).length;

const openAlerts = async (dedupeKey: string) =>
  (await t.db.select().from(alerts).where(eq(alerts.dedupeKey, dedupeKey))).filter(
    (a) => a.status !== 'resolved',
  );

describe('compressDays', () => {
  it('joins consecutive days that carry the same value', () => {
    const runs = compressDays(
      [
        { date: '2027-03-01', value: 3 },
        { date: '2027-03-02', value: 3 },
        { date: '2027-03-03', value: 2 },
        { date: '2027-03-04', value: 3 },
        { date: '2027-03-06', value: 3 },
      ],
      (a, b) => a === b,
    );
    expect(runs).toEqual([
      { from: '2027-03-01', to: '2027-03-02', value: 3 },
      { from: '2027-03-03', to: '2027-03-03', value: 2 },
      { from: '2027-03-04', to: '2027-03-04', value: 3 },
      { from: '2027-03-06', to: '2027-03-06', value: 3 },
    ]);
  });
});

describe('going live', () => {
  it('refuses to switch on a connection that has nothing mapped', async () => {
    const hotel = await createTestHotel(t.db, org);
    const connection = await createConnection(t.db, org.admin, {
      propertyId: hotel.property.id,
      adapter: 'channex',
    });
    await expect(
      updateConnection(t.db, org.admin, connection.id, { status: 'active' }),
    ).rejects.toThrow(/Map at least one room type/);
  });

  it('allows one connection of each kind per property', async () => {
    const hotel = await createTestHotel(t.db, org);
    await createConnection(t.db, org.admin, { propertyId: hotel.property.id, adapter: 'channex' });
    await expect(
      createConnection(t.db, org.admin, { propertyId: hotel.property.id, adapter: 'channex' }),
    ).rejects.toThrow(/already has/);
  });

  it('sends the whole horizon in one push when the connection is switched on', async () => {
    const hotel = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 2 });
    const connection = await createConnection(t.db, org.admin, {
      propertyId: hotel.property.id,
      adapter: 'channex',
    });
    const channel = fakeChannelFor(connection.id);
    await saveMappings(t.db, org.admin, connection.id, {
      roomTypes: [
        { roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' },
        { roomTypeId: hotel.deluxe.roomType.id, externalId: 'ext-dlx' },
      ],
      ratePlans: [{ ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' }],
    });
    // Changes made before going live are not queued one by one; the first full sync covers them.
    await book(hotel, day(5), day(7));
    await sync();
    expect(channel.pushes).toHaveLength(0);

    await updateConnection(t.db, org.admin, connection.id, { status: 'active' });
    const results = await sync();
    expect(results).toMatchObject([{ outcome: 'pushed', full: true }]);
    expect(channel.pushes).toHaveLength(1);
    expect(channel.pushes[0]!.full).toBe(true);

    const last = day(hotel.property.inventoryHorizonDays - 1);
    expect(channel.availabilityOn('ext-std', day(0))).toBe(3);
    expect(channel.availabilityOn('ext-std', day(5))).toBe(2);
    expect(channel.availabilityOn('ext-std', day(6))).toBe(2);
    expect(channel.availabilityOn('ext-std', day(7))).toBe(3);
    expect(channel.availabilityOn('ext-std', last)).toBe(3);
    expect(channel.availabilityOn('ext-std', addDays(last, 1))).toBeUndefined();
    expect(channel.availabilityOn('ext-dlx', day(5))).toBe(2);
    expect(channel.restrictionOn('ext-std-bar', day(5))).toMatchObject({
      rate: 450_000,
      stopSell: false,
    });
    // Identical days travel as ranges, not one entry per day.
    expect(channel.pushes[0]!.availability.length).toBeLessThan(10);

    const row = await connectionRow(connection.id);
    expect(row.fullSyncRequestedAt).toBeNull();
    expect(row.lastFullSyncAt).not.toBeNull();
  });
});

describe('pushing changes', () => {
  let c: Connected;
  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3, deluxeRooms: 2 });
  });

  it('sends a reservation to the channel as new availability for exactly its nights', async () => {
    await book(c.hotel, day(10), day(13));
    const results = await sync();
    expect(results).toMatchObject([{ outcome: 'pushed', full: false }]);
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.pushes[0]!.availability).toEqual([
      {
        roomTypeId: c.hotel.standard.roomType.id,
        externalRoomTypeId: 'ext-std',
        dateFrom: day(10),
        dateTo: day(12),
        availability: 2,
      },
    ]);
    expect(c.channel.pushes[0]!.restrictions).toEqual([]);
    expect(await queueSize(c.connectionId)).toBe(0);
  });

  it('gives the rooms back when the reservation is cancelled', async () => {
    const reservation = await book(c.hotel, day(10), day(12));
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
    await cancelReservation(t.db, org.admin, reservation.id);
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(3);
  });

  it('closes dates on the channel when they are blocked', async () => {
    await createBlock(t.db, org.admin, {
      propertyId: c.hotel.property.id,
      roomTypeId: c.hotel.deluxe.roomType.id,
      kind: 'maintenance',
      startDate: day(20),
      endDate: day(23),
      quantity: 2,
      reason: 'Repainting',
    });
    await sync();
    expect(c.channel.availabilityOn('ext-dlx', day(19))).toBe(2);
    expect(c.channel.availabilityOn('ext-dlx', day(20))).toBe(0);
    expect(c.channel.availabilityOn('ext-dlx', day(22))).toBe(0);
    expect(c.channel.availabilityOn('ext-dlx', day(23))).toBe(2);
  });

  it('sends rate and restriction changes', async () => {
    await setRates(t.db, org.admin, {
      propertyId: c.hotel.property.id,
      ratePlanId: c.hotel.standard.ratePlan.id,
      range: { from: day(30), to: day(33) },
      change: { rate: 520_000, minStayArrival: 2, stopSell: true },
    });
    await sync();
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.pushes[0]!.availability).toEqual([]);
    expect(c.channel.pushes[0]!.restrictions).toMatchObject([
      {
        externalRatePlanId: 'ext-std-bar',
        dateFrom: day(30),
        dateTo: day(32),
        rate: 520_000,
        currency: 'INR',
        minStayArrival: 2,
        stopSell: true,
      },
    ]);
    expect(c.channel.restrictionOn('ext-std-bar', day(33))).toMatchObject({
      rate: 450_000,
      stopSell: false,
    });
  });

  it('batches many changes into one push', async () => {
    await book(c.hotel, day(10), day(12));
    await book(c.hotel, day(11), day(14));
    await book(c.hotel, day(40), day(41));
    await setRates(t.db, org.admin, {
      propertyId: c.hotel.property.id,
      ratePlanId: c.hotel.deluxe.ratePlan.id,
      range: { from: day(10), to: day(11) },
      change: { rate: 800_000 },
    });
    await sync();
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
    expect(c.channel.availabilityOn('ext-std', day(11))).toBe(1);
    expect(c.channel.availabilityOn('ext-std', day(13))).toBe(2);
    expect(c.channel.availabilityOn('ext-std', day(40))).toBe(2);
    expect(c.channel.restrictionOn('ext-dlx-bar', day(10))?.rate).toBe(800_000);
  });

  it('does nothing when nothing changed', async () => {
    expect(await sync()).toEqual([]);
    expect(await dispatchConnection(t.db, c.connectionId)).toMatchObject({ outcome: 'idle' });
    expect(c.channel.pushes).toHaveLength(0);
  });

  it('never tells the channel about more rooms than exist, and never a negative number', async () => {
    for (let i = 0; i < 3; i++) await book(c.hotel, day(50), day(51));
    // A channel booking that arrives when the house is full is recorded over capacity.
    await createReservation(
      t.db,
      org.admin,
      {
        propertyId: c.hotel.property.id,
        source: 'ota',
        guest: { firstName: 'Late', lastName: 'Arrival' },
        rooms: [
          {
            roomTypeId: c.hotel.standard.roomType.id,
            checkIn: day(50),
            checkOut: day(51),
            adults: 1,
          },
        ],
      },
      { allowOverbooking: true },
    );
    await sync();
    expect(c.channel.availabilityOn('ext-std', day(50))).toBe(0);
  });

  it('drops changes for dates outside the window channels sell', async () => {
    const beyond = c.hotel.property.inventoryHorizonDays + 5;
    await t.db.insert(syncQueue).values({
      connectionId: c.connectionId,
      kind: 'availability',
      roomTypeId: c.hotel.standard.roomType.id,
      dateFrom: day(beyond),
      dateTo: day(beyond + 2),
    });
    expect(await dispatchConnection(t.db, c.connectionId)).toMatchObject({ outcome: 'idle' });
    expect(c.channel.pushes).toHaveLength(0);
    expect(await queueSize(c.connectionId)).toBe(0);
  });

  it('records each push in the sync log with how long the change waited', async () => {
    await book(c.hotel, day(10), day(11));
    await sync();
    const all = await t.db
      .select()
      .from(syncLog)
      .where(eq(syncLog.connectionId, c.connectionId))
      .orderBy(syncLog.id);
    const last = all[all.length - 1]!;
    expect(last).toMatchObject({
      direction: 'out',
      operation: 'ari.push',
      status: 'ok',
      itemCount: 1,
    });
    expect(last.lagMs).toBeGreaterThanOrEqual(0);
    expect(last.lagMs).toBeLessThan(10_000);
  });
});

describe('when the channel fails', () => {
  let c: Connected;
  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3, deluxeRooms: 2 });
  });

  it('keeps the change queued, backs off, and delivers the latest values on retry', async () => {
    await book(c.hotel, day(10), day(11));
    c.channel.failNextPush(503);
    const t0 = new Date();
    expect(await sync(t0)).toMatchObject([{ outcome: 'failed' }]);
    expect(c.channel.pushes).toHaveLength(0);
    expect(await queueSize(c.connectionId)).toBe(1);

    let row = await connectionRow(c.connectionId);
    expect(row.consecutiveFailures).toBe(1);
    expect(row.status).toBe('active');
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(t0.getTime());

    // Inside the back-off nothing is sent, however often the worker wakes.
    expect(await connectionsDue(t.db, t0)).not.toContain(c.connectionId);
    expect(await dispatchConnection(t.db, c.connectionId, t0)).toMatchObject({
      outcome: 'deferred',
    });
    expect((await nextDispatchAt(t.db))!.getTime()).toBe(row.nextAttemptAt!.getTime());

    // More sells while the channel is down.
    await book(c.hotel, day(10), day(11));
    const later = new Date(row.nextAttemptAt!.getTime() + 1);
    expect(await sync(later)).toMatchObject([{ outcome: 'pushed' }]);
    // One push, carrying the value as it is now (not 2, the value at the first attempt).
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(1);
    row = await connectionRow(c.connectionId);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeNull();
    expect(await queueSize(c.connectionId)).toBe(0);
  });

  it('waits as long as the channel asks when it is rate limited, without counting a failure', async () => {
    await book(c.hotel, day(10), day(11));
    c.channel.failNextPush(429, { retryAfterMs: 42_000 });
    const t0 = new Date();
    await sync(t0);
    const row = await connectionRow(c.connectionId);
    expect(row.nextAttemptAt!.getTime() - t0.getTime()).toBe(42_000);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.status).toBe('active');
    expect(await openAlerts(`sync_failure:${c.connectionId}`)).toHaveLength(0);

    await sync(new Date(t0.getTime() + 42_001));
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
  });

  it('raises an alert after repeated failures and clears it on recovery', async () => {
    await book(c.hotel, day(10), day(11));
    let now = new Date();
    for (let i = 0; i < 3; i++) {
      c.channel.failNextPush(502);
      await sync(now);
      now = new Date((await connectionRow(c.connectionId)).nextAttemptAt!.getTime() + 1);
    }
    let row = await connectionRow(c.connectionId);
    expect(row.status).toBe('error');
    expect(row.consecutiveFailures).toBe(3);
    const [alert] = await openAlerts(`sync_failure:${c.connectionId}`);
    expect(alert).toMatchObject({ kind: 'sync_failure', severity: 'critical' });

    // Changes made while the connection is failing are still queued for it.
    await book(c.hotel, day(10), day(11));
    await sync(now);
    row = await connectionRow(c.connectionId);
    expect(row.status).toBe('active');
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(1);
    expect(await openAlerts(`sync_failure:${c.connectionId}`)).toHaveLength(0);
  });

  it('alerts at once when the failure will not fix itself', async () => {
    await book(c.hotel, day(10), day(11));
    c.channel.failNextPush(401);
    await sync();
    const row = await connectionRow(c.connectionId);
    expect(row.status).toBe('error');
    const [alert] = await openAlerts(`sync_failure:${c.connectionId}`);
    expect(alert!.body).toMatch(/will not fix itself/);
  });

  it('reports values the channel refused while accepting the rest', async () => {
    await book(c.hotel, day(10), day(11));
    c.channel.warnings = ['Rate plan ext-std-bar: rate below minimum'];
    await sync();
    expect(await openAlerts(`sync_warning:${c.connectionId}`)).toHaveLength(1);
    c.channel.warnings = [];
    await book(c.hotel, day(10), day(11));
    await sync();
    expect(await openAlerts(`sync_warning:${c.connectionId}`)).toHaveLength(0);
  });
});

describe('ordering and concurrency', () => {
  let c: Connected;
  beforeEach(async () => {
    c = await connectHotel({ standardRooms: 3, deluxeRooms: 2 });
  });

  it('lets only one worker push a connection at a time', async () => {
    await book(c.hotel, day(10), day(11));
    await routeOutbox(t.db);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    c.channel.onPush = async () => {
      entered();
      await gate;
    };
    const first = dispatchConnection(t.db, c.connectionId);
    await inFlight;
    // A second worker finds the connection taken and leaves it alone.
    expect(await dispatchConnection(t.db, c.connectionId)).toMatchObject({ outcome: 'skipped' });
    release();
    expect(await first).toMatchObject({ outcome: 'pushed' });
    c.channel.onPush = null;
    expect(c.channel.pushes).toHaveLength(1);
  });

  it('does not lose a change that commits while a push is in flight', async () => {
    await book(c.hotel, day(10), day(11));
    await routeOutbox(t.db);
    c.channel.onPush = async () => {
      c.channel.onPush = null;
      // Sold while the previous values are on the wire.
      await book(c.hotel, day(10), day(11));
      await routeOutbox(t.db);
    };
    await dispatchConnection(t.db, c.connectionId);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
    // The newer change is still queued, and the next push carries it.
    expect(await queueSize(c.connectionId)).toBe(1);
    await dispatchConnection(t.db, c.connectionId);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(1);
    expect(await queueSize(c.connectionId)).toBe(0);
  });

  it('keeps to the channel’s minimum interval between pushes', async () => {
    c.channel.minPushIntervalMs = 6_000;
    const t0 = new Date();
    await book(c.hotel, day(10), day(11));
    await sync(t0);
    expect(c.channel.pushes).toHaveLength(1);
    await book(c.hotel, day(10), day(11));
    await book(c.hotel, day(12), day(13));
    // Too soon: held back, then sent together.
    expect(await sync(new Date(t0.getTime() + 2_000))).toEqual([]);
    expect(c.channel.pushes).toHaveLength(1);
    await sync(new Date(t0.getTime() + 6_001));
    expect(c.channel.pushes).toHaveLength(2);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(1);
    expect(c.channel.availabilityOn('ext-std', day(12))).toBe(2);
  });

  it('routes each change only to connections that map the room type', async () => {
    const other = await connectHotel();
    await book(c.hotel, day(10), day(11));
    await sync();
    expect(c.channel.pushes).toHaveLength(1);
    expect(other.channel.pushes).toHaveLength(0);
  });
});

describe('pausing and resuming', () => {
  it('queues nothing while paused and restates everything on resume', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    await updateConnection(t.db, org.admin, c.connectionId, { status: 'paused' });
    await book(c.hotel, day(10), day(11));
    await sync();
    expect(c.channel.pushes).toHaveLength(0);
    expect(await queueSize(c.connectionId)).toBe(0);

    await updateConnection(t.db, org.admin, c.connectionId, { status: 'active' });
    await sync();
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.pushes[0]!.full).toBe(true);
    expect(c.channel.availabilityOn('ext-std', day(10))).toBe(2);
  });

  it('restates everything after mappings change', async () => {
    const c = await connectHotel({ standardRooms: 3 });
    await saveMappings(t.db, org.admin, c.connectionId, {
      roomTypes: [{ roomTypeId: c.hotel.standard.roomType.id, externalId: 'ext-std-new' }],
    });
    await sync();
    expect(c.channel.pushes).toHaveLength(1);
    expect(c.channel.pushes[0]!.full).toBe(true);
    expect(c.channel.availabilityOn('ext-std-new', day(3))).toBe(3);
    // The deluxe type is no longer mapped, so it is no longer sent.
    expect(
      c.channel.pushes[0]!.availability.every((a) => a.externalRoomTypeId === 'ext-std-new'),
    ).toBe(true);
  });
});

describe('the sync monitor summary', () => {
  it('reports pending changes and the age of the oldest', async () => {
    const c = await connectHotel();
    await book(c.hotel, day(10), day(11));
    await routeOutbox(t.db);
    const [summary] = (await listConnections(t.db, org.orgId, [c.hotel.property.id]))!;
    expect(summary).toMatchObject({
      id: c.connectionId,
      status: 'active',
      pendingChanges: 1,
      mappedRoomTypes: 2,
      mappedRatePlans: 2,
      capabilities: { ari: true },
    });
    expect(summary!.oldestPendingAt).toBeInstanceOf(Date);
    await dispatchDue(t.db);
    const [after] = await listConnections(t.db, org.orgId, [c.hotel.property.id]);
    expect(after).toMatchObject({ pendingChanges: 0, oldestPendingAt: null });
  });
});

describe('the nightly full sync', () => {
  it('is requested once, in the small hours at the property, a few properties at a time', async () => {
    const a = await connectHotel();
    const b = await connectHotel();
    const c = await connectHotel();
    const mine = [a.connectionId, b.connectionId, c.connectionId];
    // Leave only these three eligible.
    await t.db
      .update(channelConnections)
      .set({ status: 'paused' })
      .where(notInArray(channelConnections.id, mine));
    await t.db.update(channelConnections).set({ lastFullSyncAt: new Date('2027-02-09T12:00:00Z') });

    // 09:00 UTC is 14:30 in Kolkata: not the time for it.
    const afternoon = new Date('2027-02-10T09:00:00Z');
    expect(await requestDueFullSyncs(t.db, afternoon)).toEqual([]);

    // 21:30 UTC is 03:00 in Kolkata.
    const night = new Date('2027-02-10T21:30:00Z');
    const first = await requestDueFullSyncs(t.db, night);
    expect(first).toHaveLength(2);
    const second = await requestDueFullSyncs(t.db, new Date(night.getTime() + 30_000));
    expect(second).toHaveLength(1);
    expect([...first, ...second].sort()).toEqual([...mine].sort());
    expect(await requestDueFullSyncs(t.db, new Date(night.getTime() + 60_000))).toEqual([]);

    await dispatchDue(t.db, night);
    expect(a.channel.pushes[0]!.full).toBe(true);
    // Done for tonight: it is not asked for again an hour later.
    expect(await requestDueFullSyncs(t.db, new Date(night.getTime() + 3600_000))).toEqual([]);
  });
});
