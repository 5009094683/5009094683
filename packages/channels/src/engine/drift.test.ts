import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, channelConnections } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { addDays, createReservation, todayIn, type DateString } from '@pms/domain';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from '@pms/domain/testing';
import { type FakeChannel, fakeChannelFor, useFakeChannels } from '../testing';
import { createConnection, saveMappings, updateConnection } from './connections';
import { dispatchDue } from './dispatcher';
import { checkDrift, connectionsDueForDriftCheck } from './drift';
import { routeOutbox } from './router';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;
let connectionId: string;
let channel: FakeChannel;

const day = (offset: number): DateString => addDays(todayIn('Asia/Kolkata'), offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  useFakeChannels();
});
afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  hotel = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 2 });
  const connection = await createConnection(t.db, org.admin, {
    propertyId: hotel.property.id,
    adapter: 'channex',
  });
  connectionId = connection.id;
  await saveMappings(t.db, org.admin, connectionId, {
    roomTypes: [
      { roomTypeId: hotel.standard.roomType.id, externalId: 'ext-std' },
      { roomTypeId: hotel.deluxe.roomType.id, externalId: 'ext-dlx' },
    ],
    ratePlans: [{ ratePlanId: hotel.standard.ratePlan.id, externalId: 'ext-std-bar' }],
  });
  await updateConnection(t.db, org.admin, connectionId, { status: 'active' });
  channel = fakeChannelFor(connectionId);
  await sync();
  channel.pushes.length = 0;
});

async function sync() {
  await routeOutbox(t.db);
  return dispatchDue(t.db);
}

const book = (checkIn: DateString, checkOut: DateString) =>
  createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'direct',
    guest: { firstName: 'Dev', lastName: 'Kapoor' },
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

const openDriftAlerts = async () =>
  (
    await t.db
      .select()
      .from(alerts)
      .where(eq(alerts.dedupeKey, `sync_drift:${connectionId}`))
  ).filter((a) => a.status !== 'resolved');

describe('drift check', () => {
  it('finds nothing when the channel holds what was sent', async () => {
    await book(day(3), day(5));
    await sync();
    const result = await checkDrift(t.db, connectionId);
    expect(result).toMatchObject({ outcome: 'checked', drifted: 0 });
    // 60 days of two room types, plus seven values a day for the mapped rate plan.
    expect(result.compared).toBe(60 * 2 + 60 * 7);
    const [row] = await t.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connectionId));
    expect(row).toMatchObject({ lastDriftCount: 0 });
    expect(row!.lastDriftCheckAt).not.toBeNull();
    expect(await openDriftAlerts()).toHaveLength(0);
  });

  it('finds values changed behind the PMS’s back, re-sends them and alerts', async () => {
    await book(day(3), day(5));
    await sync();
    // Someone reopens a sold night in the channel's own screen, and edits a price.
    channel.availability.get('ext-std')!.set(day(3), 3);
    channel.availability.get('ext-dlx')!.set(day(8), 0);
    channel.restrictions
      .get('ext-std-bar')!
      .set(day(6), { ...channel.restrictionOn('ext-std-bar', day(6))!, rate: 1 });
    channel.pushes.length = 0;

    const result = await checkDrift(t.db, connectionId);
    expect(result).toMatchObject({ outcome: 'checked', drifted: 3 });
    expect(result.sample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'availability', date: day(3), local: 2, remote: 3 }),
        expect.objectContaining({ kind: 'availability', date: day(8), local: 2, remote: 0 }),
        expect.objectContaining({
          kind: 'restrictions',
          date: day(6),
          field: 'rate',
          local: 450_000,
          remote: 1,
        }),
      ]),
    );
    const [alert] = await openDriftAlerts();
    expect(alert).toMatchObject({ kind: 'sync_drift', severity: 'warning' });

    // The differing days were queued; one push puts the channel right.
    await dispatchDue(t.db);
    expect(channel.pushes).toHaveLength(1);
    expect(channel.pushes[0]!.full).toBe(false);
    expect(channel.availabilityOn('ext-std', day(3))).toBe(2);
    expect(channel.availabilityOn('ext-dlx', day(8))).toBe(2);
    expect(channel.restrictionOn('ext-std-bar', day(6))!.rate).toBe(450_000);

    expect(await checkDrift(t.db, connectionId)).toMatchObject({ drifted: 0 });
    expect(await openDriftAlerts()).toHaveLength(0);
  });

  it('does not mistake a change that is still on its way for drift', async () => {
    await book(day(3), day(5));
    // Committed but not yet routed or sent.
    let result = await checkDrift(t.db, connectionId);
    expect(result).toMatchObject({ outcome: 'checked', drifted: 0 });
    // Routed to the work list but not yet sent.
    await routeOutbox(t.db);
    result = await checkDrift(t.db, connectionId);
    expect(result).toMatchObject({ outcome: 'checked', drifted: 0 });
    expect(await openDriftAlerts()).toHaveLength(0);
  });

  it('does not count a difference that disappears on the second look', async () => {
    channel.availability.get('ext-std')!.set(day(3), 0);
    const real = channel.adapter().fetchAri!;
    let looks = 0;
    const original = channel.adapter.bind(channel);
    channel.adapter = () => ({
      ...original(),
      capabilities: channel.capabilities,
      minPushIntervalMs: 0,
      fetchAri: async (range, currency) => {
        // A push lands between the two looks.
        if (++looks === 2) channel.availability.get('ext-std')!.set(day(3), 3);
        return real(range, currency);
      },
    });
    const result = await checkDrift(t.db, connectionId);
    expect(looks).toBe(2);
    expect(result).toMatchObject({ outcome: 'checked', drifted: 0 });
  });

  it('reports a channel that knows nothing about a mapped room', async () => {
    channel.availability.delete('ext-dlx');
    const result = await checkDrift(t.db, connectionId, { days: 5 });
    expect(result.drifted).toBe(5);
    expect(result.sample[0]).toMatchObject({ kind: 'availability', remote: null });
    await dispatchDue(t.db);
    expect(channel.availabilityOn('ext-dlx', day(0))).toBe(2);
  });

  it('skips connections that are off, or about to be fully restated', async () => {
    await t.db
      .update(channelConnections)
      .set({ fullSyncRequestedAt: new Date() })
      .where(eq(channelConnections.id, connectionId));
    expect(await checkDrift(t.db, connectionId)).toMatchObject({ outcome: 'skipped' });
    await t.db
      .update(channelConnections)
      .set({ fullSyncRequestedAt: null, status: 'paused' })
      .where(eq(channelConnections.id, connectionId));
    expect(await checkDrift(t.db, connectionId)).toMatchObject({ outcome: 'skipped' });
  });

  it('reports failure without raising drift when the channel cannot be read', async () => {
    const original = channel.adapter.bind(channel);
    channel.adapter = () => ({
      ...original(),
      capabilities: channel.capabilities,
      minPushIntervalMs: 0,
      fetchAri: async () => {
        throw new Error('The channel answered 503');
      },
    });
    expect(await checkDrift(t.db, connectionId)).toMatchObject({
      outcome: 'failed',
      error: 'The channel answered 503',
    });
    expect(await openDriftAlerts()).toHaveLength(0);
  });

  it('is due after each full sync has settled, and once a day after that', async () => {
    const schedule = { maxAgeHours: 24, settleMinutes: 10 };
    const minutes = (n: number) => new Date(Date.now() + n * 60_000);
    // Just fully synced: give the channel time to process it first.
    expect(await connectionsDueForDriftCheck(t.db, schedule)).not.toContain(connectionId);
    expect(await connectionsDueForDriftCheck(t.db, schedule, minutes(11))).toContain(connectionId);
    await checkDrift(t.db, connectionId);
    expect(await connectionsDueForDriftCheck(t.db, schedule, minutes(11))).not.toContain(
      connectionId,
    );
    expect(await connectionsDueForDriftCheck(t.db, schedule, minutes(25 * 60))).toContain(
      connectionId,
    );
    // A later full sync is verified in turn.
    await t.db
      .update(channelConnections)
      .set({ lastFullSyncAt: minutes(1) })
      .where(eq(channelConnections.id, connectionId));
    expect(await connectionsDueForDriftCheck(t.db, schedule, minutes(12))).toContain(connectionId);
  });
});
