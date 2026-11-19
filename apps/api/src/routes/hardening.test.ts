import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@pms/db';
import { addDays, createReservation, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let hotel: TestHotel;
let admin: TestClient;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  ctx = await createTestApp({ METRICS_TOKEN: 'metrics-secret-token' });
  hotel = await createTestHotel(ctx.t.db, ctx.org);
  admin = await ctx.admin();
});
afterAll(async () => {
  await ctx.close();
});

const signIn = async (role: Role, propertyId: string | null) =>
  ctx.login((await createTestUser(ctx.t.db, ctx.org.orgId, { role, propertyId })).email);

/** A guest whose only stay is over. */
async function pastGuest(lastName: string): Promise<string> {
  const reservation = await createReservation(ctx.t.db, ctx.org.admin, {
    propertyId: hotel.property.id,
    source: 'phone',
    guest: { firstName: 'Kabir', lastName, email: `${lastName.toLowerCase()}@example.com` },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(-5),
        checkOut: day(-3),
        adults: 2,
      },
    ],
  });
  await ctx.t.db.execute(
    `UPDATE reservation_rooms SET status = 'checked_out' WHERE reservation_id = '${reservation.id}';
     UPDATE reservations SET status = 'checked_out' WHERE id = '${reservation.id}'`,
  );
  return reservation.guestId!;
}

describe('a guest\u2019s own data', () => {
  it('is copied out and erased only by roles that span the organisation', async () => {
    const guestId = await pastGuest('Sethi');
    const frontDesk = await signIn('front_desk', hotel.property.id);
    const housekeeper = await signIn('housekeeping', null);
    const localManager = await signIn('general_manager', hotel.property.id);
    const manager = await signIn('general_manager', null);
    const other = await createTestOrg(ctx.t.db, 'Rival Hotels');
    const rival = await ctx.login(
      (await createTestUser(ctx.t.db, other.orgId, { role: 'org_admin' })).email,
    );

    // The front desk of one property can see the guest, but a full copy spans properties.
    expect((await frontDesk.get(`/guests/${guestId}`)).statusCode).toBe(200);
    expect((await frontDesk.get(`/guests/${guestId}/export`)).statusCode).toBe(403);
    expect((await housekeeper.get(`/guests/${guestId}/export`)).statusCode).toBe(403);
    expect((await rival.get(`/guests/${guestId}/export`)).statusCode).toBe(404);
    const copy = await manager.get(`/guests/${guestId}/export`);
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.headers['content-disposition']).toBe(
      `attachment; filename="guest-data-${guestId}.json"`,
    );
    expect(copy.headers['cache-control']).toBe('private, no-store');
    expect(copy.json()).toMatchObject({
      profile: { firstName: 'Kabir', lastName: 'Sethi', email: 'sethi@example.com' },
      stays: [{ property: hotel.property.name, checkIn: day(-5), status: 'checked_out' }],
    });

    for (const client of [frontDesk, housekeeper, localManager]) {
      expect((await client.post(`/guests/${guestId}/erase`)).statusCode).toBe(403);
    }
    expect((await rival.post(`/guests/${guestId}/erase`)).statusCode).toBe(404);
    expect((await manager.post(`/guests/${guestId}/erase`)).statusCode).toBe(204);
    const after = (await admin.get(`/guests/${guestId}`)).json();
    expect(after.guest).toMatchObject({ name: 'Former guest', email: null, phone: null });
    expect(after.stays).toMatchObject([{ guestName: 'Former guest', checkIn: day(-5) }]);
    // Erased is erased: the profile cannot be filled in again, and no longer comes up in a search.
    expect(
      (await admin.patch(`/guests/${guestId}`, { email: 'back@example.com' })).statusCode,
    ).toBe(409);
    expect((await admin.get('/guests?query=Sethi')).json().guests).toEqual([]);
  });
});

describe('figures for monitoring', () => {
  it('are served only to a caller with the token', async () => {
    await admin.get('/properties');
    const get = (authorization?: string) =>
      ctx.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: authorization ? { authorization } : {},
      });
    expect((await get()).statusCode).toBe(404);
    expect((await get('Bearer wrong-token')).statusCode).toBe(404);
    // A signed-in administrator is not a monitoring system either.
    expect((await admin.get('/metrics')).statusCode).toBe(404);

    const metrics = await get('Bearer metrics-secret-token');
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    const text = metrics.body;
    expect(text).toMatch(/^pms_outbox_pending \d+$/m);
    expect(text).toMatch(/^pms_sync_queue_oldest_seconds \d+(\.\d+)?$/m);
    expect(text).toMatch(/^pms_workers_alive 0$/m);
    expect(text).toMatch(/^pms_worker_last_seen_seconds -1$/m);
    expect(text).toMatch(
      /^pms_http_request_duration_seconds_count\{method="GET",route="\/properties",status="2xx"\} [1-9]\d*$/m,
    );
    // Addresses with ids in them are counted under their route, and guests are never named.
    expect(text).toContain('route="/guests/:id"');
    expect(text).not.toMatch(/Kabir|Sethi|example\.com/);
  });

  it('are not served at all where no token is set', async () => {
    const plain = await createTestApp();
    try {
      const answer = await plain.app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer anything' },
      });
      expect(answer.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
