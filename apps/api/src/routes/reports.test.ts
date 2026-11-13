import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@pms/db';
import { addDays, createReservation, monthOf, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  createTestVilla,
  type TestHotel,
  type TestVilla,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let hotel: TestHotel;
let villa: TestVilla;
let admin: TestClient;
/** Read-only at the hotel. */
let reader: TestClient;
/** Keeps the accounts of the villa. */
let accountant: TestClient;
let frontDesk: TestClient;
let housekeeper: TestClient;
let rival: TestClient;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);
const thisMonth = monthOf(today).start;
const lastMonth = monthOf(addDays(thisMonth, -1)).start;
const nextYear = Number(today.slice(0, 4)) + 1;

beforeAll(async () => {
  ctx = await createTestApp();
  hotel = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 4, deluxeRooms: 1 });
  villa = await createTestVilla(ctx.t.db, ctx.org);
  const signIn = async (role: Role, propertyId: string) =>
    ctx.login((await createTestUser(ctx.t.db, ctx.org.orgId, { role, propertyId })).email);
  admin = await ctx.admin();
  reader = await signIn('read_only', hotel.property.id);
  frontDesk = await signIn('front_desk', hotel.property.id);
  housekeeper = await signIn('housekeeping', hotel.property.id);
  accountant = await signIn('accountant', villa.property.id);
  const other = await createTestOrg(ctx.t.db, 'Rival Hotels');
  rival = await ctx.login(
    (await createTestUser(ctx.t.db, other.orgId, { role: 'org_admin' })).email,
  );

  await createReservation(ctx.t.db, ctx.org.admin, {
    propertyId: hotel.property.id,
    source: 'ota',
    channelCode: 'BDC',
    commissionAmount: 135_000,
    guest: { firstName: 'Asha', lastName: 'Rao' },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(5),
        checkOut: day(7),
        adults: 2,
      },
    ],
  });
  // A stay at the villa last month that has taken place.
  const stayed = await createReservation(ctx.t.db, ctx.org.admin, {
    propertyId: villa.property.id,
    source: 'phone',
    guest: { firstName: 'Private', lastName: 'Person' },
    rooms: [
      {
        roomTypeId: villa.whole.roomType.id,
        ratePlanId: villa.whole.ratePlan.id,
        checkIn: addDays(lastMonth, 3),
        checkOut: addDays(lastMonth, 5),
        adults: 2,
      },
    ],
  });
  await ctx.t.db.execute(
    `UPDATE reservation_rooms SET status = 'checked_out' WHERE reservation_id = '${stayed.id}';
     UPDATE reservations SET status = 'checked_out' WHERE id = '${stayed.id}'`,
  );
});
afterAll(async () => {
  await ctx.close();
});

const span = `from=${day(5)}&to=${day(7)}`;

describe('reports', () => {
  it('are shown for the properties the reader may see, and no others', async () => {
    const mine = await reader.get(`/reports/performance?${span}`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({
      currency: 'INR',
      groupBy: 'day',
      total: { available: 10, sold: 2, occupancyBp: 2_000, roomRevenue: 900_000, adr: 450_000 },
    });
    // The administrator sees both properties: the villa adds a room a night and no sales.
    expect((await admin.get(`/reports/performance?${span}`)).json().total).toMatchObject({
      available: 12,
      sold: 2,
    });
    const byProperty = await admin.get(`/reports/performance?${span}&groupBy=property`);
    expect(byProperty.json().rows.map((r: { label: string }) => r.label)).toEqual(
      [hotel.property.name, villa.property.name].sort(),
    );

    expect(
      (await reader.get(`/reports/performance?${span}&propertyIds=${villa.property.id}`))
        .statusCode,
    ).toBe(403);
    expect((await housekeeper.get(`/reports/performance?${span}`)).statusCode).toBe(403);
    expect((await ctx.anonymous().get(`/reports/performance?${span}`)).statusCode).toBe(401);
    expect((await rival.get(`/reports/performance?${span}`)).json()).toMatchObject({
      currency: null,
      rows: [],
    });
    // Another organisation's property cannot be asked for by its id.
    expect(
      (await rival.get(`/reports/performance?${span}&propertyIds=${hotel.property.id}`)).json()
        .rows,
    ).toEqual([]);
    expect((await reader.get(`/reports/performance?from=${day(7)}&to=${day(5)}`)).statusCode).toBe(
      400,
    );
    expect((await reader.get('/reports/performance?from=soon&to=later')).statusCode).toBe(400);
  });

  it('cover sources, pace, takings and travel agents', async () => {
    const mix = (await reader.get(`/reports/channel-mix?${span}`)).json();
    expect(mix.rows).toMatchObject([
      { key: 'BDC', channelCode: 'BDC', roomNights: 2, commission: 135_000, netRevenue: 765_000 },
    ]);
    const pace = (await reader.get(`/reports/pace?${span}`)).json();
    expect(pace).toMatchObject({ groupBy: 'day', total: { sold: 2, pickup7: { roomNights: 2 } } });
    expect(pace.rows).toHaveLength(2);
    expect((await reader.get(`/reports/revenue?${span}`)).json()).toMatchObject({
      days: [],
      total: { total: 0, paymentsTotal: 0 },
    });
    expect((await reader.get(`/reports/agent-commission?${span}`)).json()).toMatchObject({
      rows: [],
      total: { commission: 0 },
    });
    for (const path of ['channel-mix', 'pace', 'revenue', 'agent-commission']) {
      expect((await housekeeper.get(`/reports/${path}?${span}`)).statusCode).toBe(403);
    }
  });

  it('can be downloaded as a spreadsheet', async () => {
    const file = await reader.get(`/reports/performance?${span}&format=csv`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="performance-${day(5)}-to-${day(6)}.csv"`,
    );
    expect(file.headers['cache-control']).toBe('private, no-store');
    const lines = file.body.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('Occupancy and rates');
    expect(lines).toContain('Total,10,2,20,9000.00,4500.00,900.00');
    for (const path of ['channel-mix', 'pace', 'revenue', 'agent-commission']) {
      const other = await reader.get(`/reports/${path}?${span}&format=csv`);
      expect(other.headers['content-type'], path).toBe('text/csv; charset=utf-8');
    }
  });
});

describe('reports sent by email', () => {
  const body = {
    name: 'Morning figures',
    report: 'performance',
    period: 'next_30_days',
    frequency: 'daily',
    hour: 7,
    recipients: ['gm@example.com'],
  };

  it('cover only what their author may see', async () => {
    // Someone whose role is for one property has to say which properties the report covers.
    const everything = await reader.post('/reports/schedules', body);
    expect(everything.statusCode).toBe(403);
    expect(everything.json().error.message).toMatch(/Choose the properties/);
    expect(
      (await reader.post('/reports/schedules', { ...body, propertyIds: [villa.property.id] }))
        .statusCode,
    ).toBe(403);
    expect((await housekeeper.post('/reports/schedules', body)).statusCode).toBe(403);
    const mine = await reader.post('/reports/schedules', {
      ...body,
      name: 'Hotel only',
      propertyIds: [hotel.property.id],
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const all = await admin.post('/reports/schedules', body);
    expect(all.statusCode, all.body).toBe(201);
    expect(all.json()).toMatchObject({ propertyIds: null, groupBy: 'day', active: true });

    const seenByReader = (await reader.get('/reports/schedules')).json();
    expect(seenByReader.schedules.map((s: { name: string }) => s.name)).toEqual(['Hotel only']);
    expect(seenByReader.mailConfigured).toBe(true);
    expect(
      (await admin.get('/reports/schedules')).json().schedules.map((s: { name: string }) => s.name),
    ).toEqual(['Hotel only', 'Morning figures']);
    expect((await rival.get('/reports/schedules')).json().schedules).toEqual([]);

    // The reader cannot touch the schedule that covers everything, nor widen their own.
    const allId = all.json().id as string;
    const mineId = mine.json().id as string;
    expect((await reader.patch(`/reports/schedules/${allId}`, { hour: 9 })).statusCode).toBe(403);
    expect((await reader.delete(`/reports/schedules/${allId}`)).statusCode).toBe(403);
    expect((await reader.post(`/reports/schedules/${allId}/send`)).statusCode).toBe(403);
    expect(
      (await reader.patch(`/reports/schedules/${mineId}`, { propertyIds: null })).statusCode,
    ).toBe(403);
    expect((await rival.patch(`/reports/schedules/${mineId}`, { hour: 9 })).statusCode).toBe(404);
    const changed = await reader.patch(`/reports/schedules/${mineId}`, {
      frequency: 'weekly',
      weekday: 1,
    });
    expect(changed.json()).toMatchObject({ frequency: 'weekly', weekday: 1 });
    expect(
      (await reader.post('/reports/schedules', { ...body, recipients: ['nobody'] })).statusCode,
    ).toBe(403);
    expect(
      (await admin.post('/reports/schedules', { ...body, recipients: ['nobody'] })).json().error
        .message,
    ).toMatch(/is not an email address/);
  });

  it('can be sent at once, as an attachment', async () => {
    const [mine] = (await reader.get('/reports/schedules')).json().schedules;
    const before = ctx.mailer.sent.length;
    const sent = await reader.post(`/reports/schedules/${mine.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toEqual({ status: 'sent' });
    const mail = ctx.mailer.sent[before]!;
    expect(mail.to).toEqual(['gm@example.com']);
    expect(mail.subject).toMatch(/^Hotel only: /);
    const csv = String(mail.attachments![0]!.content);
    // Only the hotel: five rooms a night for thirty nights.
    expect(csv.split('\r\n').pop() ?? csv).toBe('');
    expect(csv).toMatch(/\r\nTotal,150,2,/);
    expect((await reader.delete(`/reports/schedules/${mine.id}`)).statusCode).toBe(204);
    expect((await reader.get('/reports/schedules')).json().schedules).toEqual([]);
  });
});

describe('villa owners', () => {
  let ownerId: string;
  let contractId: string;
  let statementId: string;
  let owner: TestClient;

  it('are kept by those who keep the accounts of the property', async () => {
    expect((await frontDesk.post('/owners', { name: 'No' })).statusCode).toBe(403);
    expect((await frontDesk.get('/owners')).statusCode).toBe(403);
    const created = await accountant.post('/owners', {
      name: 'Rohini Desai',
      email: 'rohini@example.com',
    });
    expect(created.statusCode, created.body).toBe(201);
    ownerId = created.json().id;

    const terms = {
      ownerId,
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      startsOn: addDays(lastMonth, -30),
      managementFeeBp: 2_000,
      ownerNightsPerYear: 14,
    };
    // The villa's accountant cannot sign a contract for the hotel.
    expect(
      (
        await accountant.post('/owner-contracts', {
          ...terms,
          propertyId: hotel.property.id,
          unitId: null,
        })
      ).statusCode,
    ).toBe(403);
    const contract = await accountant.post('/owner-contracts', terms);
    expect(contract.statusCode, contract.body).toBe(201);
    contractId = contract.json().id;
    expect((await accountant.post('/owner-contracts', terms)).statusCode).toBe(409);
    const patched = await accountant.patch(`/owner-contracts/${contractId}`, {
      ownerStayNoticeDays: 3,
    });
    expect(patched.json()).toMatchObject({ ownerStayNoticeDays: 3, managementFeeBp: 2_000 });

    expect((await accountant.get('/owners')).json().owners).toMatchObject([
      { id: ownerId, name: 'Rohini Desai', contracts: [{ id: contractId, unitName: 'Villa' }] },
    ]);
    expect((await accountant.get(`/owners/${ownerId}`)).json().contracts).toHaveLength(1);
    expect((await rival.get(`/owners/${ownerId}`)).statusCode).toBe(404);
    expect((await rival.get('/owners')).json().owners).toEqual([]);
    expect((await rival.patch(`/owner-contracts/${contractId}`, {})).statusCode).toBe(404);
  });

  it('get a statement each month, which the accounts team checks and issues', async () => {
    const cost = await accountant.post(`/owner-contracts/${contractId}/expenses`, {
      date: addDays(lastMonth, 4),
      category: 'maintenance',
      description: 'Garden tidy',
      amount: 100_000,
    });
    expect(cost.statusCode, cost.body).toBe(201);
    expect(
      (await accountant.get(`/owner-contracts/${contractId}/expenses`)).json().expenses,
    ).toHaveLength(1);
    expect(
      (await frontDesk.post(`/owner-contracts/${contractId}/expenses`, cost.json())).statusCode,
    ).toBe(403);

    const month = lastMonth.slice(0, 7);
    const draft = await accountant.post(`/owner-contracts/${contractId}/statements`, { month });
    expect(draft.statusCode, draft.body).toBe(200);
    statementId = draft.json().id;
    // Two nights at 25,000; a fifth to management, 18% tax on that, and the gardener.
    expect(draft.json()).toMatchObject({
      status: 'draft',
      ownerName: 'Rohini Desai',
      propertyName: villa.property.name,
      roomNights: 2,
      grossRevenue: 5_000_000,
      managementFee: 1_000_000,
      feeTax: 180_000,
      expenses: 100_000,
      payout: 3_720_000,
    });
    const adjusted = await accountant.patch(`/owner-statements/${statementId}`, {
      adjustments: [{ description: 'Goodwill', amount: 20_000 }],
    });
    expect(adjusted.json().payout).toBe(3_740_000);
    expect((await frontDesk.get(`/owner-statements/${statementId}`)).statusCode).toBe(403);
    expect((await rival.get(`/owner-statements/${statementId}`)).statusCode).toBe(404);
    expect((await rival.post(`/owner-statements/${statementId}/issue`)).statusCode).toBe(404);
    expect(
      (await accountant.post(`/owner-contracts/${contractId}/statements`, { month: 'May' }))
        .statusCode,
    ).toBe(400);

    const before = ctx.mailer.sent.length;
    const issued = await accountant.post(`/owner-statements/${statementId}/issue`);
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json()).toMatchObject({
      status: 'issued',
      number: `${villa.property.code}/OS/${month}/01`,
      payout: 3_740_000,
      ownerEmailed: true,
    });
    const mail = ctx.mailer.sent[before]!;
    expect(mail.to).toBe('rohini@example.com');
    expect(mail.text).toContain('Payable to you: ₹37,400');
    expect(mail.attachments).toHaveLength(1);
    // Once issued it is settled.
    expect(
      (await accountant.patch(`/owner-statements/${statementId}`, { notes: 'x' })).statusCode,
    ).toBe(409);
    expect((await accountant.delete(`/owner-statements/${statementId}`)).statusCode).toBe(409);
    expect((await accountant.delete(`/owner-expenses/${cost.json().id}`)).statusCode).toBe(409);

    const file = await accountant.get(`/owner-statements/${statementId}?format=csv`);
    expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(file.body).toContain('Payable to owner,37400.00');
    const paid = await accountant.post(`/owner-statements/${statementId}/paid`, {
      reference: 'NEFT 88',
    });
    expect(paid.json()).toMatchObject({ status: 'paid', paymentReference: 'NEFT 88' });
    expect(
      (await accountant.get(`/owner-statements?ownerId=${ownerId}&status=paid`)).json().statements,
    ).toHaveLength(1);
  });

  it('are invited to the portal by someone who manages users', async () => {
    expect((await accountant.post(`/owners/${ownerId}/portal-access`)).statusCode).toBe(403);
    const before = ctx.mailer.sent.length;
    const invited = await admin.post(`/owners/${ownerId}/portal-access`);
    expect(invited.statusCode, invited.body).toBe(201);
    expect(invited.json().inviteEmailed).toBe(true);
    expect(invited.json().inviteLink).toMatch(/\/reset-password\?token=.+&invite=1$/);
    expect(ctx.mailer.sent[before]!.to).toBe('rohini@example.com');
    const view = (await admin.get(`/owners/${ownerId}`)).json();
    expect(view.user).toMatchObject({ email: 'rohini@example.com', status: 'invited' });
    // The new sign-in can open the owner portal for this villa and nothing else.
    const users = (await admin.get('/users')).json().users as {
      id: string;
      grants: { role: string; propertyId: string | null }[];
    }[];
    expect(users.find((u) => u.id === view.user.id)!.grants).toEqual([
      { role: 'villa_owner', propertyId: villa.property.id },
    ]);
    expect((await admin.post(`/owners/${ownerId}/portal-access`)).statusCode).toBe(409);

    // The owner chooses a password with the link and signs in.
    const token = new URL(invited.json().inviteLink).searchParams.get('token');
    const redeemed = await ctx.anonymous().post('/auth/password-reset/redeem', {
      token,
      password: 'a long enough passphrase 42',
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    owner = await ctx.login('rohini@example.com', 'a long enough passphrase 42');
  });

  it('see their own villa, stays and statements in the portal, and nothing of the back office', async () => {
    const overview = await owner.get('/owner/overview');
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json()).toMatchObject({
      owner: { name: 'Rohini Desai' },
      contracts: [{ id: contractId, propertyName: villa.property.name, ownerNightsUsed: 0 }],
      statements: [{ id: statementId, status: 'paid', payout: 3_740_000 }],
    });
    const calendar = await owner.get(`/owner/calendar?from=${lastMonth}&to=${thisMonth}`);
    expect(calendar.json().stays).toMatchObject([{ source: 'phone', nights: 2 }]);
    expect(calendar.body).not.toMatch(/Private|Person/);
    expect((await owner.get('/owner/statements')).json().statements).toHaveLength(1);
    const file = await owner.get(`/owner/statements/${statementId}?format=csv`);
    expect(file.body).toContain('Payable to owner,37400.00');

    const stay = await owner.post('/owner/stays', {
      contractId,
      from: `${nextYear}-03-10`,
      to: `${nextYear}-03-13`,
    });
    expect(stay.statusCode, stay.body).toBe(201);
    expect(stay.json()).toMatchObject({ kind: 'owner_stay', startDate: `${nextYear}-03-10` });
    // Staff see it on the calendar like any closed dates.
    const blocks = (
      await admin.get(
        `/blocks?propertyIds=${villa.property.id}&from=${nextYear}-03-01&to=${nextYear}-04-01`,
      )
    ).json().blocks as { id: string; kind: string }[];
    expect(blocks).toMatchObject([{ id: stay.json().id, kind: 'owner_stay' }]);
    expect((await owner.delete(`/owner/stays/${stay.json().id}`)).statusCode).toBe(204);
    expect((await owner.delete(`/owner/stays/${stay.json().id}`)).statusCode).toBe(404);

    // Nothing of the back office is open to an owner.
    for (const path of [
      '/owners',
      '/owner-statements',
      `/owner-statements/${statementId}`,
      '/reservations',
      `/reports/performance?${span}`,
      `/properties/${villa.property.id}`,
      '/guests',
      '/alerts',
      '/inbox/conversations',
    ]) {
      expect((await owner.get(path)).statusCode, path).toBe(403);
    }
    expect((await owner.get('/properties')).json()).toEqual({ properties: [] });
    expect((await owner.get('/org')).json().settings).toEqual({});
    // And the portal is for owners: staff have the back office.
    expect((await admin.get('/owner/overview')).statusCode).toBe(403);
    expect((await accountant.get('/owner/statements')).statusCode).toBe(403);

    // Another owner sees nothing of this one's.
    const second = await createTestUser(ctx.t.db, ctx.org.orgId, { role: 'villa_owner' });
    const created = await admin.post('/owners', { name: 'Neighbour', userId: second.id });
    expect(created.statusCode, created.body).toBe(201);
    const neighbour = await ctx.login(second.email);
    expect((await neighbour.get('/owner/overview')).json()).toMatchObject({
      contracts: [],
      statements: [],
    });
    expect((await neighbour.get(`/owner/statements/${statementId}`)).statusCode).toBe(404);
    expect(
      (
        await neighbour.post('/owner/stays', {
          contractId,
          from: `${nextYear}-03-10`,
          to: `${nextYear}-03-13`,
        })
      ).statusCode,
    ).toBe(404);
  });
});
