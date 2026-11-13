import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { parseCalendar, saveIcalFeeds, type IcalFeedView } from '@pms/channels';
import { inventoryBlocks, reservations } from '@pms/db';
import { createTestUser, createTestVilla, type TestVilla } from '@pms/domain/testing';
import { day, openAlerts, sleep, startStack, waitFor, type Stack } from './harness';

let stack: Stack;
let host: http.Server;
let hostUrl: string;
/** What each channel's calendar address currently returns. */
const calendars = new Map<string, { status: number; body: string }>();

const ics = (
  ...events: { uid: string; from: string; to: string; summary: string; description?: string }[]
) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Channel//EN',
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTART;VALUE=DATE:${e.from.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${e.to.replace(/-/g, '')}`,
      `SUMMARY:${e.summary}`,
      ...(e.description ? [`DESCRIPTION:${e.description}`] : []),
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
    '',
  ].join('\r\n');

const serve = (path: string, body: string, status = 200) => calendars.set(path, { status, body });

beforeAll(async () => {
  stack = await startStack();
  host = http.createServer((req, res) => {
    const entry = calendars.get(req.url ?? '');
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(entry.status, { 'content-type': 'text/calendar' });
    res.end(entry.body);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  hostUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});
afterAll(async () => {
  host.closeAllConnections();
  await new Promise((resolve) => host.close(resolve));
  await stack.stop();
});

interface Listed {
  villa: TestVilla;
  connectionId: string;
  unitId: string;
  airbnb: IcalFeedView;
  vrbo: IcalFeedView;
  /** Path of the Airbnb calendar on the test host. */
  path: string;
}

let seq = 0;

/** A villa listed on Airbnb and Vrbo by calendar, with nothing in either calendar yet. */
async function listedVilla(options: { bedrooms?: number } = {}): Promise<Listed> {
  const villa = await createTestVilla(stack.api.t.db, stack.api.org, options);
  const unitId = villa.whole.units[0]!.id;
  const path = `/airbnb-${++seq}.ics`;
  serve(path, ics());
  const created = await stack.admin.post('/channels/connections', {
    propertyId: villa.property.id,
    adapter: 'ical',
  });
  expect(created.statusCode).toBe(201);
  const connectionId = (created.json() as { id: string }).id;
  const saved = await stack.admin.put(`/channels/connections/${connectionId}/ical/feeds`, {
    feeds: [
      { unitId, label: 'Airbnb', importUrl: `${hostUrl}${path}` },
      { unitId, label: 'Vrbo', importUrl: null },
    ],
  });
  expect(saved.statusCode).toBe(200);
  const feeds = (saved.json() as { feeds: IcalFeedView[] }).feeds;
  const listed = { villa, connectionId, unitId, path, airbnb: feeds[0]!, vrbo: feeds[1]! };
  // The worker reads a new connection's calendars on its own within moments. Let that
  // happen now, while they are empty, so that from here on only the test decides when
  // a read takes place (the next automatic one is five minutes away).
  await read(listed);
  await waitFor('automatic reads to settle', async () => {
    const { rows } = await stack.api.t.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM jobs
      WHERE kind = 'channel.pull' AND status IN ('pending', 'running')
        AND payload->>'connectionId' = ${connectionId}
    `);
    return rows[0]!.n === 0;
  });
  return listed;
}

/** Reads the channel calendars now, as the five-minute poll would, and waits for the read to finish. */
async function read(listed: Listed): Promise<void> {
  const before = await finishedReads(listed.connectionId);
  const res = await stack.admin.post(`/channels/connections/${listed.connectionId}/pull`);
  expect(res.statusCode).toBe(202);
  // A read that failed is waiting to be retried; do not wait out its back-off.
  await stack.api.t.db.execute(
    sql`UPDATE jobs SET run_at = now()
        WHERE kind = 'channel.pull' AND status = 'pending' AND payload->>'connectionId' = ${listed.connectionId}`,
  );
  await waitFor(
    'the calendars to be read',
    async () => (await finishedReads(listed.connectionId)) > before,
  );
}

/** Attempts to read this connection's calendars that have run to the end, successfully or not. */
async function finishedReads(connectionId: string): Promise<number> {
  const { rows } = await stack.api.t.db.execute<{ n: number }>(sql`
    SELECT coalesce(sum(CASE WHEN status = 'running' THEN attempts - 1 ELSE attempts END), 0)::int AS n
    FROM jobs WHERE kind = 'channel.pull' AND payload->>'connectionId' = ${connectionId}
  `);
  return rows[0]!.n;
}

const reservationsOf = async (listed: Listed) =>
  stack.api.t.db
    .select()
    .from(reservations)
    .where(eq(reservations.connectionId, listed.connectionId));

const blocksOf = async (listed: Listed) =>
  stack.api.t.db
    .select()
    .from(inventoryBlocks)
    .where(and(eq(inventoryBlocks.connectionId, listed.connectionId)));

const fetchExport = async (feed: IcalFeedView, headers: Record<string, string> = {}) =>
  fetch(feed.exportUrl, { headers });

describe('reading a channel’s calendar', () => {
  let listed: Listed;
  beforeEach(async () => {
    listed = await listedVilla();
  });

  it('records a booking found in the calendar, on the unit, marked for staff to complete', async () => {
    serve(
      listed.path,
      ics({
        uid: 'abb-1@airbnb.com',
        from: day(12),
        to: day(15),
        summary: 'Reserved',
        description:
          'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMQ2X7Y9ZT\\nPhone Number (Last 4 Digits): 4821',
      }),
    );
    await read(listed);
    const [reservation] = await reservationsOf(listed);
    expect(reservation).toMatchObject({
      status: 'confirmed',
      source: 'ota',
      channelCode: 'ABB',
      channelReservationCode: 'HMQ2X7Y9ZT',
      guestName: 'Guest (Airbnb)',
      checkIn: day(12),
      checkOut: day(15),
      needsReview: true,
      overbooked: false,
    });
    expect(reservation!.reviewReason).toMatch(/Airbnb calendar, which gives dates only/);
    const detail = (await stack.admin.get(`/reservations/${reservation!.id}`)).json() as {
      rooms: { unitId: string }[];
    };
    expect(detail.rooms[0]!.unitId).toBe(listed.unitId);

    // Reading the same calendar again changes nothing.
    await read(listed);
    expect(await reservationsOf(listed)).toHaveLength(1);
  });

  it('records closed dates as a block, not as a guest', async () => {
    serve(
      listed.path,
      ics({
        uid: 'abb-block@airbnb.com',
        from: day(20),
        to: day(22),
        summary: 'Airbnb (Not available)',
      }),
    );
    await read(listed);
    expect(await reservationsOf(listed)).toHaveLength(0);
    const [block] = await blocksOf(listed);
    expect(block).toMatchObject({
      unitId: listed.unitId,
      kind: 'block',
      source: 'ical',
      startDate: day(20),
      endDate: day(22),
      releasedAt: null,
    });
    expect(block!.reason).toBe('Airbnb calendar: Airbnb (Not available)');

    // The closure is lifted on Airbnb: after it has been absent twice, the block is released.
    serve(listed.path, ics());
    await read(listed);
    expect((await blocksOf(listed))[0]!.releasedAt).toBeNull();
    await read(listed);
    expect((await blocksOf(listed))[0]!.releasedAt).not.toBeNull();
  });

  it('follows a change of dates, and cancels only after the booking is gone from two reads', async () => {
    const entry = { uid: 'abb-2@airbnb.com', summary: 'Reserved' };
    serve(listed.path, ics({ ...entry, from: day(12), to: day(15) }));
    await read(listed);
    serve(listed.path, ics({ ...entry, from: day(13), to: day(17) }));
    await read(listed);
    let [reservation] = await reservationsOf(listed);
    expect(reservation).toMatchObject({ checkIn: day(13), checkOut: day(17), status: 'confirmed' });

    // One empty read could be a hiccup on the channel's side.
    serve(listed.path, ics());
    await read(listed);
    [reservation] = await reservationsOf(listed);
    expect(reservation!.status).toBe('confirmed');
    // It is back: nothing happened.
    serve(listed.path, ics({ ...entry, from: day(13), to: day(17) }));
    await read(listed);
    serve(listed.path, ics());
    await read(listed);
    expect((await reservationsOf(listed))[0]!.status).toBe('confirmed');
    // Gone twice in a row: cancelled.
    await read(listed);
    [reservation] = await reservationsOf(listed);
    expect(reservation).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'Cancelled on Airbnb',
    });

    // And if the channel lists it again later, it is taken as a booking again.
    serve(listed.path, ics({ ...entry, from: day(13), to: day(17) }));
    await read(listed);
    const all = await reservationsOf(listed);
    expect(all.filter((r) => r.status === 'confirmed')).toHaveLength(1);
  });

  it('ignores stays that are already over', async () => {
    serve(
      listed.path,
      ics({ uid: 'old@airbnb.com', from: day(-10), to: day(-7), summary: 'Reserved' }),
    );
    await read(listed);
    expect(await reservationsOf(listed)).toHaveLength(0);
  });

  it('records a booking that collides with one already in the PMS, and raises the alarm', async () => {
    const direct = await stack.admin.post('/reservations', {
      propertyId: listed.villa.property.id,
      source: 'phone',
      guest: { firstName: 'Ishaan', lastName: 'Verma' },
      rooms: [
        {
          roomTypeId: listed.villa.whole.roomType.id,
          checkIn: day(30),
          checkOut: day(33),
          adults: 4,
        },
      ],
    });
    expect(direct.statusCode).toBe(201);
    // Airbnb sold two of the same nights before it read our calendar.
    serve(
      listed.path,
      ics({ uid: 'abb-clash@airbnb.com', from: day(31), to: day(34), summary: 'Reserved' }),
    );
    await read(listed);
    const [clash] = await reservationsOf(listed);
    expect(clash).toMatchObject({ status: 'confirmed', overbooked: true, checkIn: day(31) });
    const alerts = await openAlerts(stack, 'overbooking');
    expect(alerts.some((a) => a.entityId === clash!.id && a.severity === 'critical')).toBe(true);
    // The first booking keeps the villa.
    const kept = (
      await stack.admin.get(`/reservations/${(direct.json() as { id: string }).id}`)
    ).json() as {
      rooms: { unitId: string | null }[];
      overbooked: boolean;
    };
    expect(kept).toMatchObject({ overbooked: false });
    expect(kept.rooms[0]!.unitId).toBe(listed.unitId);
  });

  it('does not add a block where the PMS already has the dates taken', async () => {
    await stack.admin.post('/reservations', {
      propertyId: listed.villa.property.id,
      source: 'phone',
      guest: { firstName: 'Ishaan', lastName: 'Verma' },
      rooms: [
        {
          roomTypeId: listed.villa.whole.roomType.id,
          checkIn: day(40),
          checkOut: day(43),
          adults: 4,
        },
      ],
    });
    serve(
      listed.path,
      ics({
        uid: 'echo@airbnb.com',
        from: day(40),
        to: day(43),
        summary: 'Airbnb (Not available)',
      }),
    );
    await read(listed);
    expect(await blocksOf(listed)).toHaveLength(0);
    expect(await openAlerts(stack, 'overbooking')).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ propertyId: listed.villa.property.id }),
      ]),
    );
  });

  it('tells staff when a calendar cannot be read, and stops telling them once it can', async () => {
    serve(listed.path, 'Service unavailable', 503);
    await read(listed);
    // The only calendar with an address failed, so the whole fetch failed.
    const failing = await waitFor('the alert', async () => {
      const open = (await openAlerts(stack, 'inbound_failure')).filter(
        (a) => a.entityId === listed.connectionId,
      );
      return open.length > 0 ? open : null;
    });
    expect(failing[0]!.body).toMatch(/Airbnb answered 503/);
    const feeds = (
      await stack.admin.get(`/channels/connections/${listed.connectionId}/ical/feeds`)
    ).json() as {
      feeds: IcalFeedView[];
    };
    // The screen shows which calendar failed and why, and when it was last read properly.
    expect(feeds.feeds[0]).toMatchObject({
      label: 'Airbnb',
      error: 'Airbnb answered 503',
      lastReadAt: listed.airbnb.lastReadAt ?? expect.any(String),
    });

    serve(
      listed.path,
      ics({ uid: 'abb-ok@airbnb.com', from: day(12), to: day(13), summary: 'Reserved' }),
    );
    await read(listed);
    await waitFor('the alert to clear', async () =>
      (await openAlerts(stack, 'inbound_failure')).every((a) => a.entityId !== listed.connectionId),
    );
    expect(await reservationsOf(listed)).toHaveLength(1);
  });

  it('reports one unreadable calendar while still reading the others', async () => {
    const second = `/booking-${++seq}.ics`;
    serve(second, 'gone', 500);
    serve(
      listed.path,
      ics({ uid: 'abb-ok@airbnb.com', from: day(12), to: day(13), summary: 'Reserved' }),
    );
    const saved = await stack.admin.put(`/channels/connections/${listed.connectionId}/ical/feeds`, {
      feeds: [
        {
          id: listed.airbnb.id,
          unitId: listed.unitId,
          label: 'Airbnb',
          importUrl: listed.airbnb.importUrl,
        },
        { unitId: listed.unitId, label: 'Booking.com', importUrl: `${hostUrl}${second}` },
      ],
    });
    expect(saved.statusCode).toBe(200);
    await read(listed);
    expect(await reservationsOf(listed)).toHaveLength(1);
    const alerts = (await openAlerts(stack, 'calendar_feed_failure')).filter(
      (a) => a.entityId === listed.connectionId,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toMatch(/Booking\.com answered 500/);

    serve(second, ics());
    await read(listed);
    expect(
      (await openAlerts(stack, 'calendar_feed_failure')).filter(
        (a) => a.entityId === listed.connectionId,
      ),
    ).toHaveLength(0);
  });
});

describe('the calendar offered to a channel', () => {
  it('lists every night the unit is taken, without guest details, and leaves out what the channel itself sold', async () => {
    const listed = await listedVilla();
    const { villa } = listed;
    // A direct booking, a block, and a booking that came from Airbnb's calendar.
    const direct = await stack.admin.post('/reservations', {
      propertyId: villa.property.id,
      source: 'phone',
      guest: { firstName: 'Zoya', lastName: 'Fernandes' },
      rooms: [
        { roomTypeId: villa.whole.roomType.id, checkIn: day(10), checkOut: day(13), adults: 4 },
      ],
    });
    expect(direct.statusCode).toBe(201);
    const block = await stack.admin.post('/blocks', {
      propertyId: villa.property.id,
      unitId: listed.unitId,
      kind: 'owner_stay',
      startDate: day(20),
      endDate: day(24),
      reason: 'Owner family visit',
    });
    expect(block.statusCode).toBe(201);
    serve(
      listed.path,
      ics({ uid: 'abb-9@airbnb.com', from: day(30), to: day(32), summary: 'Reserved' }),
    );
    await read(listed);

    const forAirbnb = await fetchExport(listed.airbnb);
    expect(forAirbnb.status).toBe(200);
    expect(forAirbnb.headers.get('content-type')).toMatch(/text\/calendar/);
    const text = await forAirbnb.text();
    const airbnbView = parseCalendar(text, 'Asia/Kolkata').events;
    expect(airbnbView.map((e) => [e.start, e.end, e.summary])).toEqual([
      [day(10), day(13), 'Reserved'],
      [day(20), day(24), 'Not available'],
    ]);
    // Nothing that identifies a guest or says why dates are closed.
    expect(text).not.toMatch(/Zoya|Fernandes|Owner family/);

    // Vrbo is told about the Airbnb booking too.
    const vrboView = parseCalendar(
      await (await fetchExport(listed.vrbo)).text(),
      'Asia/Kolkata',
    ).events;
    expect(vrboView.map((e) => [e.start, e.end])).toEqual([
      [day(10), day(13)],
      [day(20), day(24)],
      [day(30), day(32)],
    ]);

    // A cancellation in the PMS disappears from the calendar.
    await stack.admin.post(`/reservations/${(direct.json() as { id: string }).id}/cancel`, {});
    const after = parseCalendar(
      await (await fetchExport(listed.airbnb)).text(),
      'Asia/Kolkata',
    ).events;
    expect(after.map((e) => e.start)).toEqual([day(20)]);
  });

  it('shows the whole villa as taken when one of its bedrooms is booked', async () => {
    const listed = await listedVilla({ bedrooms: 3 });
    const res = await stack.admin.post('/reservations', {
      propertyId: listed.villa.property.id,
      source: 'phone',
      guest: { firstName: 'Zoya', lastName: 'Fernandes' },
      rooms: [
        {
          roomTypeId: listed.villa.bedrooms!.roomType.id,
          checkIn: day(10),
          checkOut: day(12),
          adults: 2,
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const events = parseCalendar(
      await (await fetchExport(listed.vrbo)).text(),
      'Asia/Kolkata',
    ).events;
    expect(events.map((e) => [e.start, e.end, e.summary])).toEqual([
      [day(10), day(12), 'Reserved'],
    ]);
  });

  it('answers only to the exact address it gave out', async () => {
    const listed = await listedVilla();
    const good = await fetchExport(listed.vrbo);
    expect(good.status).toBe(200);
    const etag = good.headers.get('etag')!;
    expect((await fetchExport(listed.vrbo, { 'if-none-match': etag })).status).toBe(304);

    const url = new URL(listed.vrbo.exportUrl);
    const tampered = url.toString().replace(/.{4}\.ics$/, 'AAAA.ics');
    expect((await fetch(tampered)).status).toBe(404);
    // The right token for one calendar does not open another.
    const swapped = listed.vrbo.exportUrl.replace(listed.vrbo.id, listed.airbnb.id);
    expect((await fetch(swapped)).status).toBe(404);
    expect((await fetch(`${url.origin}/ical/not-a-calendar/whatever.ics`)).status).toBe(404);
  });

  it('keeps the addresses from people who cannot manage channels', async () => {
    const listed = await listedVilla();
    const reader = await createTestUser(stack.api.t.db, stack.api.org.orgId, { role: 'read_only' });
    const client = await stack.api.login(reader.email);
    const res = await client.get(`/channels/connections/${listed.connectionId}/ical/feeds`);
    expect(res.statusCode).toBe(200);
    const feeds = (
      res.json() as {
        feeds: { label: string; exportUrl: string | null; importUrl: string | null }[];
      }
    ).feeds;
    expect(feeds.map((f) => [f.label, f.exportUrl, f.importUrl])).toEqual([
      ['Airbnb', null, null],
      ['Vrbo', null, null],
    ]);
    expect(
      (await client.put(`/channels/connections/${listed.connectionId}/ical/feeds`, { feeds: [] }))
        .statusCode,
    ).toBe(403);
  });
});

describe('saving calendars', () => {
  it('validates what it is given', async () => {
    const listed = await listedVilla();
    const other = await createTestVilla(stack.api.t.db, stack.api.org);
    const put = (feeds: unknown[]) =>
      stack.admin.put(`/channels/connections/${listed.connectionId}/ical/feeds`, { feeds });
    expect(
      (await put([{ unitId: other.whole.units[0]!.id, label: 'Airbnb' }])).json(),
    ).toMatchObject({
      error: { message: expect.stringMatching(/not part of this property/) },
    });
    expect(
      (
        await put([
          { unitId: listed.unitId, label: 'Airbnb', importUrl: 'ftp://example.com/x.ics' },
        ])
      ).statusCode,
    ).toBe(400);
    const twice = await put([
      { unitId: listed.unitId, label: 'Airbnb', importUrl: `${hostUrl}/a.ics` },
      { unitId: listed.unitId, label: 'Vrbo', importUrl: `${hostUrl}/a.ics` },
    ]);
    expect(twice.json()).toMatchObject({
      error: { message: expect.stringMatching(/listed twice/) },
    });

    // In production only https addresses are accepted.
    await expect(
      saveIcalFeeds(
        stack.api.t.db,
        stack.api.org.admin,
        listed.connectionId,
        [
          {
            unitId: listed.unitId,
            label: 'Airbnb',
            importUrl: 'http://calendar.example.com/x.ics',
          },
        ],
        { API_PUBLIC_URL: 'https://pms.example.com/api', isProduction: true },
      ),
    ).rejects.toThrow(/must start with https/);
  });

  it('keeps the address given to a channel stable across saves', async () => {
    const listed = await listedVilla();
    const again = await stack.admin.put(`/channels/connections/${listed.connectionId}/ical/feeds`, {
      feeds: [
        { id: listed.vrbo.id, unitId: listed.unitId, label: 'Vrbo (renamed)', importUrl: null },
        {
          id: listed.airbnb.id,
          unitId: listed.unitId,
          label: 'Airbnb',
          importUrl: listed.airbnb.importUrl,
        },
      ],
    });
    const feeds = (again.json() as { feeds: IcalFeedView[] }).feeds;
    expect(feeds.find((f) => f.id === listed.vrbo.id)!.exportUrl).toBe(listed.vrbo.exportUrl);
    expect(feeds.find((f) => f.id === listed.airbnb.id)!.exportUrl).toBe(listed.airbnb.exportUrl);
    expect(feeds.find((f) => f.id === listed.airbnb.id)!.channelCode).toBe('ABB');
    await sleep(0);
  });
});
