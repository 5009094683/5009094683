import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@pms/db';
import { addDays, releaseDueGroupRooms, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let frontDesk: TestClient;
let housekeeper: TestClient;
let reader: TestClient;
let elsewhere: TestClient;
let hotel: TestHotel;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  ctx = await createTestApp();
  hotel = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 4, deluxeRooms: 1 });
  const other = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 1, deluxeRooms: 1 });
  const signIn = async (role: Role, propertyId = hotel.property.id) => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, { role, propertyId });
    return ctx.login(user.email);
  };
  frontDesk = await signIn('front_desk');
  housekeeper = await signIn('housekeeping');
  reader = await signIn('read_only');
  elsewhere = await signIn('front_desk', other.property.id);
});
afterAll(async () => {
  await ctx.close();
});

interface Group {
  id: string;
  code: string;
  status: string;
  leftNights: number;
  bookings: number;
  holds: { id: string; quantity: number }[];
  nights: { date: string; held: number; booked: number; left: number }[];
  reservations: { id: string; code: string; guestName: string }[];
}

const availability = async (client: TestClient, from: number, to: number, groupId?: string) => {
  const res = await client.get(
    `/properties/${hotel.property.id}/availability?from=${day(from)}&to=${day(to)}` +
      `&roomTypeIds=${hotel.standard.roomType.id}${groupId ? `&groupId=${groupId}` : ''}`,
  );
  expect(res.statusCode).toBe(200);
  return (res.json().days as { available: number }[]).map((d) => d.available);
};

describe('group bookings over the API', () => {
  let group: Group;

  it('lets the front desk start a group, and keeps others to what their role allows', async () => {
    const body = {
      name: 'Kapoor anniversary',
      contactName: 'Rhea Kapoor',
      contactEmail: 'rhea@example.com',
      cutoffDate: day(10),
      holds: [{ roomTypeId: hotel.standard.roomType.id, from: day(20), to: day(22), quantity: 3 }],
    };
    const path = `/properties/${hotel.property.id}/groups`;
    expect((await reader.post(path, body)).statusCode).toBe(403);
    expect((await housekeeper.post(path, body)).statusCode).toBe(403);
    expect((await elsewhere.post(path, body)).statusCode).toBe(403);
    expect((await frontDesk.post(path, { ...body, name: ' ' })).statusCode).toBe(400);
    expect((await frontDesk.post(path, { ...body, surprise: true })).statusCode).toBe(201);

    const created = await frontDesk.post(path, { ...body, name: 'Second party', holds: [] });
    expect(created.statusCode).toBe(201);

    const list = await reader.get(path);
    expect(list.statusCode).toBe(200);
    const groups = list.json().groups as (Group & { name: string; from: string | null })[];
    // Soonest first; a group with no dates yet comes last.
    expect(groups.map((g) => g.name)).toEqual(['Kapoor anniversary', 'Second party']);
    expect(groups[0]).toMatchObject({ from: day(20), heldNights: 6, leftNights: 6, bookings: 0 });
    group = (await reader.get(`/groups/${groups[0]!.id}`)).json() as Group;
    expect(group.holds).toHaveLength(1);

    // Reading needs access to reservations at that property.
    expect((await housekeeper.get(path)).statusCode).toBe(200);
    expect((await elsewhere.get(path)).statusCode).toBe(403);
    expect((await elsewhere.get(`/groups/${group.id}`)).statusCode).toBe(403);
    const search = await reader.get(`${path}?search=anniversary&status=all`);
    expect(search.json().groups).toHaveLength(1);
  });

  it('shows the group its own rooms, and books a rooming list from them', async () => {
    expect(await availability(frontDesk, 20, 22)).toEqual([1, 1]);
    expect(await availability(frontDesk, 20, 22, group.id)).toEqual([4, 4]);

    const list = {
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(20),
      checkOut: day(22),
      nightlyRate: 350_000,
      guests: [
        { firstName: 'Rhea', lastName: 'Kapoor' },
        { firstName: 'Kabir', lastName: 'Kapoor' },
      ],
    };
    expect((await reader.post(`/groups/${group.id}/rooming-list`, list)).statusCode).toBe(403);
    const res = await frontDesk.post(`/groups/${group.id}/rooming-list`, list);
    expect(res.statusCode).toBe(201);
    const made = res.json() as {
      group: Group;
      reservations: { code: string; totalAmount: number }[];
    };
    expect(made.reservations.map((r) => r.totalAmount)).toEqual([700_000, 700_000]);
    expect(made.group).toMatchObject({ bookings: 2, leftNights: 2 });
    // What the public can book has not moved.
    expect(await availability(frontDesk, 20, 22)).toEqual([1, 1]);

    // A single booking joins the group through the ordinary reservation route.
    const single = await frontDesk.post('/reservations', {
      propertyId: hotel.property.id,
      source: 'phone',
      guest: { firstName: 'Late', lastName: 'Cousin' },
      groupId: group.id,
      rooms: [
        {
          roomTypeId: hotel.standard.roomType.id,
          ratePlanId: hotel.standard.ratePlan.id,
          checkIn: day(20),
          checkOut: day(21),
          adults: 1,
        },
      ],
    });
    expect(single.statusCode).toBe(201);
    expect(single.json().group).toMatchObject({ id: group.id, name: 'Kapoor anniversary' });
    expect(await availability(frontDesk, 20, 22)).toEqual([1, 1]);

    // ...and out of it again: it now needs the one room left for the public on that night.
    const out = await frontDesk.put(`/reservations/${single.json().id}/group`, { groupId: null });
    expect(out.statusCode).toBe(200);
    expect(out.json().group).toBeNull();
    expect(await availability(frontDesk, 20, 22)).toEqual([0, 1]);
    expect(
      (await reader.put(`/reservations/${single.json().id}/group`, { groupId: group.id }))
        .statusCode,
    ).toBe(403);
  });

  it('changes and releases held rooms', async () => {
    const hold = group.holds[0]!;
    const path = `/groups/${group.id}/holds`;
    expect((await reader.patch(`${path}/${hold.id}`, { quantity: 2 })).statusCode).toBe(403);
    const fewer = await frontDesk.patch(`${path}/${hold.id}`, { quantity: 2 });
    expect(fewer.statusCode).toBe(200);
    expect((fewer.json() as Group).leftNights).toBe(0);
    expect(await availability(frontDesk, 20, 22)).toEqual([1, 2]);

    // The deluxe room is free; hold it too, then give it up.
    const more = await frontDesk.post(path, {
      roomTypeId: hotel.deluxe.roomType.id,
      from: day(20),
      to: day(22),
      quantity: 1,
    });
    expect(more.statusCode).toBe(201);
    const added = (more.json() as Group).holds.find((h) => h.id !== hold.id)!;
    // Two of the one deluxe room cannot be held: the message says why.
    const tooMany = await frontDesk.patch(`${path}/${added.id}`, { quantity: 2 });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.message).toBe('Quantity must be between 1 and 1');
    expect((await frontDesk.delete(`${path}/${added.id}`)).statusCode).toBe(200);
    expect((await frontDesk.delete(`${path}/${added.id}`)).statusCode).toBe(404);

    // Cancelling is refused while bookings stand; releasing keeps them.
    const refused = await frontDesk.post(`/groups/${group.id}/cancel`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(
      '2 bookings of this group still stand. Cancel them first.',
    );
    const released = await frontDesk.post(`/groups/${group.id}/release`, {});
    expect(released.json()).toMatchObject({ status: 'closed', heldNights: 0, bookings: 2 });
  });

  it('releases unbooked rooms once the cut-off day is over', async () => {
    const res = await frontDesk.post(`/properties/${hotel.property.id}/groups`, {
      name: 'Tour group',
      cutoffDate: day(1),
      holds: [{ roomTypeId: hotel.standard.roomType.id, from: day(40), to: day(42), quantity: 2 }],
    });
    const tour = res.json() as Group;
    expect(await availability(frontDesk, 40, 42)).toEqual([2, 2]);
    expect(await releaseDueGroupRooms(ctx.t.db, new Date())).toEqual([]);
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect((await releaseDueGroupRooms(ctx.t.db, later)).map((g) => g.groupId)).toEqual([tour.id]);
    expect(await availability(frontDesk, 40, 42)).toEqual([4, 4]);
    expect((await reader.get(`/groups/${tour.id}`)).json()).toMatchObject({ status: 'closed' });
  });

  it('keeps another organisation out', async () => {
    const stranger = await createTestOrg(ctx.t.db, 'Other Hotels');
    const theirs = await createTestHotel(ctx.t.db, stranger);
    const user = await createTestUser(ctx.t.db, stranger.orgId, { role: 'org_admin' });
    const client = await ctx.login(user.email);
    expect((await client.get(`/groups/${group.id}`)).statusCode).toBe(404);
    expect((await client.get(`/properties/${hotel.property.id}/groups`)).statusCode).toBe(404);
    expect(
      (
        await client.get(
          `/properties/${theirs.property.id}/availability?from=${day(20)}&to=${day(22)}&groupId=${group.id}`,
        )
      ).statusCode,
    ).toBe(404);
  });
});
