import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { checkWorkerLiveness } from '@pms/channels';
import { channelConnections, jobs, reservations } from '@pms/db';
import type { TestHotel } from '@pms/domain/testing';
import {
  WEBHOOK_SECRET,
  ariRequests,
  connectionOf,
  day,
  guestBooks,
  liveHotel,
  openAlerts,
  reservationFor,
  shownEverywhere,
  sleep,
  startStack,
  waitFor,
  type ConnectedProperty,
  type Stack,
} from './harness';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.stop();
});

const std = (hotel: TestHotel) => hotel.standard.roomType.id;

const bookDirect = async (hotel: TestHotel, checkIn: string, checkOut: string) => {
  const res = await stack.admin.post('/reservations', {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: { firstName: 'Kabir', lastName: 'Sethi' },
    rooms: [
      {
        roomTypeId: std(hotel),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn,
        checkOut,
        adults: 2,
      },
    ],
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string };
};

const reservationCount = async (propertyId: string) =>
  (await stack.api.t.db.select().from(reservations).where(eq(reservations.propertyId, propertyId)))
    .length;

const postWebhook = (body: string, headers: Record<string, string>) =>
  fetch(`${stack.apiUrl}/webhooks/channex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

describe('webhook deliveries that go wrong', () => {
  let hotel: TestHotel;
  let live: ConnectedProperty;
  beforeAll(async () => {
    ({ hotel, live } = await liveHotel(stack, { standardRooms: 5 }));
  });

  it('records a booking once when its webhook is delivered twice', async () => {
    stack.sim.state.faults.duplicateWebhooks = true;
    const booking = guestBooks(stack, live, 'BDC', {
      roomTypeId: std(hotel),
      checkIn: day(10),
      checkOut: day(12),
    });
    stack.sim.state.faults.duplicateWebhooks = false;
    await waitFor('the reservation', () => reservationFor(stack, booking.code));
    await stack.sim.sender.idle();
    await waitFor('both deliveries to be handled', async () => {
      const [{ n }] = (
        await stack.api.t.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'channel.pull' AND status IN ('pending', 'running')`,
        )
      ).rows as [{ n: number }];
      return n === 0;
    });
    expect(await reservationCount(hotel.property.id)).toBe(1);
    await waitFor('the push', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 4),
    );
    const delivered = stack.sim.state.deliveries.filter((d) => d.event === 'booking').slice(-2);
    expect(delivered.map((d) => d.status)).toEqual([200, 200]);
  });

  it('finds a booking whose webhook never arrived, by polling', async () => {
    stack.sim.state.faults.dropWebhooks = true;
    const booking = guestBooks(stack, live, 'ABB', {
      roomTypeId: std(hotel),
      checkIn: day(20),
      checkOut: day(22),
    });
    stack.sim.state.faults.dropWebhooks = false;
    await sleep(300);
    expect(await reservationFor(stack, booking.code)).toBeUndefined();

    // The regular poll comes round. Here its interval is made to have elapsed: the last
    // fetch was 16 minutes ago, and so was the last time a poll was queued.
    await stack.api.t.db.execute(
      sql`UPDATE jobs SET created_at = now() - interval '16 minutes'
          WHERE unique_key = ${`channel.pull:poll:${live.connectionId}`}`,
    );
    await stack.api.t.db
      .update(channelConnections)
      .set({ lastPullAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(channelConnections.id, live.connectionId));
    const reservation = await waitFor('the poll to find it', () =>
      reservationFor(stack, booking.code),
    );
    expect(reservation).toMatchObject({ channelCode: 'ABB', checkIn: day(20) });
    await waitFor(
      'the acknowledgement',
      () => stack.sim.state.feed(live.externalPropertyId).length === 0,
    );
    const rows = (
      await stack.admin.get(`/channels/revisions?connectionId=${live.connectionId}`)
    ).json() as {
      revisions: { receivedVia: string; checkIn: string }[];
    };
    expect(rows.revisions.find((r) => r.checkIn === day(20))).toMatchObject({
      receivedVia: 'poll',
    });
  });

  it('fetches on demand from the sync monitor', async () => {
    stack.sim.state.faults.dropWebhooks = true;
    const booking = guestBooks(stack, live, 'EXP', {
      roomTypeId: std(hotel),
      checkIn: day(30),
      checkOut: day(31),
    });
    stack.sim.state.faults.dropWebhooks = false;
    const res = await stack.admin.post(`/channels/connections/${live.connectionId}/pull`);
    expect(res.statusCode).toBe(202);
    await waitFor('the reservation', () => reservationFor(stack, booking.code));
  });

  it('refuses a webhook call without the shared secret, and acts on nothing in it', async () => {
    const body = JSON.stringify({
      event: 'booking',
      property_id: live.externalPropertyId,
      payload: { booking_id: 'x', revision_id: 'forged-revision' },
    });
    const queued = async () =>
      (
        await stack.api.t.db
          .select()
          .from(jobs)
          .where(sql`${jobs.payload}->>'revisionId' = 'forged-revision'`)
      ).length;

    expect((await postWebhook(body, {})).status).toBe(401);
    expect((await postWebhook(body, { 'x-channex-webhook-secret': 'wrong' })).status).toBe(401);
    expect(await queued()).toBe(0);

    // With the right secret the same call is accepted (and merely causes a fetch).
    const ok = await postWebhook(body, { 'x-channex-webhook-secret': WEBHOOK_SECRET });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, action: 'pull_queued' });
    expect(await queued()).toBe(1);
  });

  it('accepts a webhook for a property it does not know without failing', async () => {
    const res = await postWebhook(
      JSON.stringify({
        event: 'booking',
        property_id: '00000000-0000-4000-8000-00000000dead',
        payload: {},
      }),
      { 'x-channex-webhook-secret': WEBHOOK_SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'unknown_property' });
  });

  it('rejects a body that is not JSON', async () => {
    const res = await postWebhook('not json', { 'x-channex-webhook-secret': WEBHOOK_SECRET });
    expect(res.status).toBe(400);
  });
});

describe('when the channel manager is down', () => {
  it('keeps changes queued, says so, and delivers the latest state on recovery', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 5 });
    const logStart = stack.sim.state.requestLog.length;
    stack.sim.state.faults.outageUntil = Date.now() + 600_000;

    await bookDirect(hotel, day(10), day(11));
    await waitFor('the failure to be noticed', async () => {
      const c = await connectionOf(stack, live.connectionId);
      return c.consecutiveFailures >= 1 && c.pendingChanges >= 1;
    });
    let connection = await connectionOf(stack, live.connectionId);
    expect(connection.lastError).toMatch(/503/);
    expect(connection.nextAttemptAt).not.toBeNull();
    // Nothing reached the sites.
    expect(shownEverywhere(stack, live, std(hotel), day(10))).toEqual([5, 5, 5, 5, 5]);

    // More is sold while it is down, and a guest books on a site (the site still works; its message waits).
    await bookDirect(hotel, day(10), day(11));
    const onSite = guestBooks(stack, live, 'BDC', {
      roomTypeId: std(hotel),
      checkIn: day(10),
      checkOut: day(11),
    });
    await sleep(200);
    expect(await reservationFor(stack, onSite.code)).toBeUndefined();

    // Back up. Skip the remaining back-off rather than wait it out.
    stack.sim.state.faults.outageUntil = 0;
    await stack.api.t.db
      .update(channelConnections)
      .set({ nextAttemptAt: new Date() })
      .where(eq(channelConnections.id, live.connectionId));
    await stack.api.t.db.execute(sql`UPDATE jobs SET run_at = now() WHERE status = 'pending'`);

    await waitFor('the site booking to arrive', () => reservationFor(stack, onSite.code));
    // Two sold direct plus one on the site: three of five gone, everywhere.
    await waitFor('every site to catch up', () =>
      shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 2),
    );
    connection = await connectionOf(stack, live.connectionId);
    expect(connection).toMatchObject({
      status: 'active',
      consecutiveFailures: 0,
      lastError: null,
      pendingChanges: 0,
    });
    expect(await openAlerts(stack, 'sync_failure')).toHaveLength(0);
    // The failed attempts were plain retries of the same work, not a flood.
    expect(ariRequests(stack, logStart).filter((r) => r.status === 503).length).toBeLessThan(6);
  });

  it('raises an alert when the failures continue, and clears it afterwards', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 3 });
    stack.sim.state.faults.outageUntil = Date.now() + 600_000;
    await bookDirect(hotel, day(10), day(11));
    // Three attempts, each made as soon as the test skips the back-off.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await waitFor(
        `failure ${attempt}`,
        async () => (await connectionOf(stack, live.connectionId)).consecutiveFailures >= attempt,
      );
      await stack.api.t.db
        .update(channelConnections)
        .set({ nextAttemptAt: new Date() })
        .where(eq(channelConnections.id, live.connectionId));
    }
    const alerts = await waitFor('the alert', async () => {
      const open = (await openAlerts(stack, 'sync_failure')).filter(
        (a) => a.entityId === live.connectionId,
      );
      return open.length > 0 ? open : null;
    });
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect((await connectionOf(stack, live.connectionId)).status).toBe('error');

    stack.sim.state.faults.outageUntil = 0;
    await stack.api.t.db
      .update(channelConnections)
      .set({ nextAttemptAt: new Date() })
      .where(eq(channelConnections.id, live.connectionId));
    await waitFor(
      'recovery',
      async () => (await connectionOf(stack, live.connectionId)).status === 'active',
    );
    expect(
      (await openAlerts(stack, 'sync_failure')).filter((a) => a.entityId === live.connectionId),
    ).toHaveLength(0);
    expect(shownEverywhere(stack, live, std(hotel), day(10))).toEqual([2, 2, 2, 2, 2]);
  });

  it('applies several waiting changes to one booking in the order they happened', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 3 });
    stack.sim.state.faults.dropWebhooks = true;
    const t0 = Date.now() - 60_000;
    const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
    const booking = guestBooks(
      stack,
      live,
      'BDC',
      {
        roomTypeId: std(hotel),
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(10),
        checkOut: day(12),
      },
      { insertedAt: at(0) },
    );
    stack.sim.state.modifyBooking(booking.id, {
      rooms: [{ checkIn: day(14), checkOut: day(17) }],
      insertedAt: at(10),
    });
    const other = guestBooks(
      stack,
      live,
      'ABB',
      { roomTypeId: std(hotel), checkIn: day(14), checkOut: day(15) },
      { insertedAt: at(20) },
    );
    stack.sim.state.cancelBooking(other.id, { insertedAt: at(30) });
    stack.sim.state.faults.dropWebhooks = false;

    await stack.admin.post(`/channels/connections/${live.connectionId}/pull`);
    await waitFor(
      'everything to be acknowledged',
      () => stack.sim.state.feed(live.externalPropertyId).length === 0,
    );
    expect(await reservationFor(stack, booking.code)).toMatchObject({
      status: 'confirmed',
      checkIn: day(14),
      checkOut: day(17),
    });
    expect(await reservationFor(stack, other.code)).toMatchObject({ status: 'cancelled' });
    await waitFor('the sites to agree', () =>
      shownEverywhere(stack, live, std(hotel), day(14)).every((v) => v === 2),
    );
    expect(shownEverywhere(stack, live, std(hotel), day(10))).toEqual([3, 3, 3, 3, 3]);
  });
});

describe('rate limits', () => {
  it('waits as long as it is told and still delivers everything', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 6 });
    // Two requests per endpoint, then a pause of up to two seconds.
    stack.sim.state.ariLimitPerMinute = 2;
    stack.sim.state.ariWindowMs = 2_000;
    stack.sim.state.clearAriSlots();
    const logStart = stack.sim.state.requestLog.length;
    try {
      for (let i = 0; i < 5; i++) {
        await bookDirect(hotel, day(10), day(11));
        await sleep(120);
      }
      await waitFor(
        'all five to reach the sites',
        () => shownEverywhere(stack, live, std(hotel), day(10)).every((v) => v === 1),
        { timeoutMs: 15_000 },
      );
      const requests = ariRequests(stack, logStart);
      expect(requests.some((r) => r.status === 429)).toBe(true);
      // Being asked to slow down is not a failure of the connection.
      const connection = await connectionOf(stack, live.connectionId);
      expect(connection).toMatchObject({
        status: 'active',
        consecutiveFailures: 0,
        pendingChanges: 0,
      });
      expect(
        (await openAlerts(stack, 'sync_failure')).filter((a) => a.entityId === live.connectionId),
      ).toHaveLength(0);
    } finally {
      stack.sim.state.ariLimitPerMinute = 10_000;
      stack.sim.state.ariWindowMs = 60_000;
      stack.sim.state.clearAriSlots();
    }
  });
});

describe('values changed behind the PMS’s back', () => {
  it('finds them, puts them right and tells staff', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 3 });
    await bookDirect(hotel, day(5), day(6));
    await waitFor('the push', () =>
      shownEverywhere(stack, live, std(hotel), day(5)).every((v) => v === 2),
    );

    // Someone reopens the sold night, and drops a price, in the channel manager's own screen.
    const room = live.rooms[std(hotel)]!;
    const rate = live.rates[hotel.standard.ratePlan.id]!;
    stack.sim.state.availability.get(room)!.set(day(5), 3);
    stack.sim.state.distribute(room, [day(5)]);
    stack.sim.state.restrictions
      .get(rate)!
      .set(day(8), { ...stack.sim.state.restrictionOn(rate, day(8)), rate: 100 });
    expect(shownEverywhere(stack, live, std(hotel), day(5))).toEqual([3, 3, 3, 3, 3]);

    const res = await stack.admin.post(`/channels/connections/${live.connectionId}/drift-check`);
    expect(res.statusCode).toBe(202);
    await waitFor('the values to be restored', () => {
      return (
        shownEverywhere(stack, live, std(hotel), day(5)).every((v) => v === 2) &&
        stack.sim.state.restrictionOn(rate, day(8)).rate === 450_000
      );
    });
    const alerts = (await openAlerts(stack, 'sync_drift')).filter(
      (a) => a.entityId === live.connectionId,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain(day(5));
    expect((await connectionOf(stack, live.connectionId)).lastDriftCount).toBe(2);
  });
});

describe('bookings made before the PMS was connected', () => {
  it('are brought in by the import', async () => {
    const { hotel, live } = await liveHotel(stack, { standardRooms: 4 });
    // Two bookings the previous system had already received and acknowledged.
    stack.sim.state.faults.dropWebhooks = true;
    const a = guestBooks(stack, live, 'BDC', {
      roomTypeId: std(hotel),
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(40),
      checkOut: day(43),
    });
    const b = guestBooks(stack, live, 'AGO', {
      roomTypeId: std(hotel),
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(41),
      checkOut: day(42),
    });
    stack.sim.state.cancelBooking(b.id);
    for (const revision of stack.sim.state.feed(live.externalPropertyId))
      stack.sim.state.acknowledge(revision.id);
    stack.sim.state.faults.dropWebhooks = false;
    expect(await reservationFor(stack, a.code)).toBeUndefined();

    const res = await stack.admin.post(
      `/channels/connections/${live.connectionId}/import-bookings`,
    );
    expect(res.statusCode).toBe(202);
    const imported = await waitFor('the import', () => reservationFor(stack, a.code));
    expect(imported).toMatchObject({
      status: 'confirmed',
      channelCode: 'BDC',
      checkIn: day(40),
      checkOut: day(43),
    });
    // The cancelled one is not created.
    expect(await reservationFor(stack, b.code)).toBeUndefined();
    await waitFor('the sites to reflect it', () =>
      shownEverywhere(stack, live, std(hotel), day(41)).every((v) => v === 3),
    );

    // Importing again changes nothing.
    await stack.admin.post(`/channels/connections/${live.connectionId}/import-bookings`);
    await sleep(400);
    expect(await reservationCount(hotel.property.id)).toBe(1);
  });
});

describe('channel events', () => {
  it('warns when a site is disconnected and clears the warning when it is back', async () => {
    const { live } = await liveHotel(stack);
    const sim = stack.sim.state;
    const channel = sim.channelsOf(live.externalPropertyId).find((c) => c.code === 'AGO')!;
    channel.active = false;
    sim.onEvent('deactivate_channel', live.externalPropertyId, {
      title: 'Agoda',
      channel_id: channel.id,
      ota_name: 'Agoda',
    });
    const alerts = await waitFor('the alert', async () => {
      const open = (await openAlerts(stack, 'channel_disconnected')).filter(
        (a) => a.entityId === live.connectionId,
      );
      return open.length > 0 ? open : null;
    });
    expect(alerts[0]).toMatchObject({ severity: 'critical' });
    expect(alerts[0]!.title).toContain('Agoda');

    channel.active = true;
    sim.onEvent('activate_channel', live.externalPropertyId, {
      title: 'Agoda',
      channel_id: channel.id,
      ota_name: 'Agoda',
    });
    await waitFor('the alert to clear', async () =>
      (await openAlerts(stack, 'channel_disconnected')).every(
        (a) => a.entityId !== live.connectionId,
      ),
    );
  });

  it('passes on a sync error reported by a site', async () => {
    const { live } = await liveHotel(stack);
    stack.sim.state.onEvent('sync_error', live.externalPropertyId, {
      channel: 'Expedia',
      channel_name: 'Expedia',
      channel_id: 'c1',
      error_type: 'general_error',
    });
    const alerts = await waitFor('the alert', async () => {
      const open = (await openAlerts(stack, 'sync_failure')).filter(
        (a) => a.entityId === live.connectionId,
      );
      return open.length > 0 ? open : null;
    });
    expect(alerts[0]!.title).toMatch(/Expedia did not accept an update/);
  });
});

describe('when no sync worker is running', () => {
  it('says so loudly, queues the work, and catches up when one starts', async () => {
    const idle = await startStack({ startWorker: false });
    try {
      // Bring a property live by hand, without a worker to do the first sync.
      const { createTestHotel } = await import('@pms/domain/testing');
      const hotel = await createTestHotel(idle.api.t.db, idle.api.org, { standardRooms: 3 });
      const connection = (
        await idle.admin.post('/channels/connections', {
          propertyId: hotel.property.id,
          adapter: 'channex',
        })
      ).json() as { id: string };
      const provisioned = (
        await idle.admin.post(`/channels/connections/${connection.id}/channex/provision`)
      ).json() as { externalPropertyId: string };
      await idle.admin.patch(`/channels/connections/${connection.id}`, { status: 'active' });

      const status = (await idle.admin.get('/channels/status')).json() as {
        worker: { alive: boolean };
      };
      expect(status.worker.alive).toBe(false);
      // The API notices on its own timer; here that check is run directly.
      await checkWorkerLiveness(idle.api.t.db);
      const [alert] = await openAlerts(idle, 'sync_failure');
      expect(alert).toMatchObject({ severity: 'critical' });
      expect(alert!.title).toMatch(/sync worker is not running/);

      await idle.admin.post('/reservations', {
        propertyId: hotel.property.id,
        source: 'phone',
        guest: { firstName: 'Kabir', lastName: 'Sethi' },
        rooms: [
          {
            roomTypeId: hotel.standard.roomType.id,
            checkIn: day(10),
            checkOut: day(11),
            adults: 2,
          },
        ],
      });
      await sleep(200);
      expect(ariRequests(idle)).toHaveLength(0);

      await idle.worker.start();
      const room = [...idle.sim.state.roomTypes.values()].find(
        (r) => r.propertyId === provisioned.externalPropertyId && r.title === 'Standard Room',
      )!;
      await waitFor(
        'the queued work to be sent',
        () => idle.sim.state.availabilityOn(room.id, day(10)) === 2,
      );
      await waitFor(
        'the alert to clear',
        async () => (await openAlerts(idle, 'sync_failure')).length === 0,
      );
      expect(
        ((await idle.admin.get('/channels/status')).json() as { worker: { alive: boolean } }).worker
          .alive,
      ).toBe(true);
    } finally {
      await idle.stop();
    }
  });
});

describe('signed webhooks', () => {
  it('accepts deliveries signed by the channel manager and refuses anything else', async () => {
    const secret = 'whsec_integration_signing_secret';
    const signed = await startStack({ signingSecret: secret });
    try {
      const { hotel, live } = await liveHotel(signed, { standardRooms: 2 });
      const booking = signed.sim.state.createBooking({
        propertyId: live.externalPropertyId,
        channel: 'BDC',
        rooms: [
          {
            roomTypeId: live.rooms[hotel.standard.roomType.id]!,
            ratePlanId: null,
            checkIn: day(10),
            checkOut: day(11),
          },
        ],
      });
      // A genuine, signed delivery gets through.
      await waitFor('the reservation', async () => {
        const res = await signed.admin.get(`/reservations?search=${booking.otaReservationCode}`);
        return (res.json() as { reservations: unknown[] }).reservations.length === 1;
      });

      const body = JSON.stringify({
        event: 'booking',
        property_id: live.externalPropertyId,
        payload: { revision_id: 'r' },
      });
      const call = (headers: Record<string, string>) =>
        fetch(`${signed.apiUrl}/webhooks/channex`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-channex-webhook-secret': WEBHOOK_SECRET,
            ...headers,
          },
          body,
        });
      const sign = (timestamp: string, key = secret, payload = body) =>
        createHmac('sha256', key).update(`${timestamp}.${payload}`).digest('hex');
      const now = String(Math.floor(Date.now() / 1000));

      // The shared secret alone is not enough once signing is on.
      expect((await call({})).status).toBe(401);
      expect(
        (
          await call({
            'x-hmac-timestamp': now,
            'x-hmac-signature-256': sign(now, 'another-secret'),
          })
        ).status,
      ).toBe(401);
      // A signature over a different body.
      expect(
        (await call({ 'x-hmac-timestamp': now, 'x-hmac-signature-256': sign(now, secret, '{}') }))
          .status,
      ).toBe(401);
      // A genuine signature replayed ten minutes later.
      const old = String(Math.floor(Date.now() / 1000) - 600);
      expect(
        (await call({ 'x-hmac-timestamp': old, 'x-hmac-signature-256': sign(old) })).status,
      ).toBe(401);
      // Correct, and correct as the second of two signatures during a key rotation.
      expect(
        (await call({ 'x-hmac-timestamp': now, 'x-hmac-signature-256': sign(now) })).status,
      ).toBe(200);
      expect(
        (
          await call({
            'x-hmac-timestamp': now,
            'x-hmac-signature-256': `${sign(now, 'old-key')},${sign(now)}`,
          })
        ).status,
      ).toBe(200);
    } finally {
      await signed.stop();
    }
  });
});
