import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { properties, type Role } from '@pms/db';
import { addDays, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let admin: TestClient;
let frontDesk: TestClient;
let housekeeper: TestClient;
let accountant: TestClient;
let reader: TestClient;
let hotel: TestHotel;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await ctx.admin();
  hotel = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 3, deluxeRooms: 1 });
  await ctx.t.db
    .update(properties)
    .set({ businessDate: today })
    .where(eq(properties.id, hotel.property.id));
  const signIn = async (role: Role) => {
    const user = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role,
      propertyId: hotel.property.id,
    });
    return ctx.login(user.email);
  };
  frontDesk = await signIn('front_desk');
  housekeeper = await signIn('housekeeping');
  accountant = await signIn('accountant');
  reader = await signIn('read_only');
});
afterAll(async () => {
  await ctx.close();
});

const book = async (from: number, to: number) => {
  const res = await frontDesk.post('/reservations', {
    propertyId: hotel.property.id,
    source: 'walk_in',
    guest: { firstName: 'Farah', lastName: 'Khan' },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(from),
        checkOut: day(to),
        adults: 2,
      },
    ],
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; code: string; rooms: { id: string }[] };
};

describe('a stay, from arrival to invoice', () => {
  it('runs through the front desk, the folio and the invoice', async () => {
    const r = await book(0, 1);

    const board = (await frontDesk.get(`/properties/${hotel.property.id}/front-desk`)).json();
    expect(board.arrivals.map((s: { code: string }) => s.code)).toContain(r.code);

    const choices = await frontDesk.get(`/reservations/${r.id}/rooms/${r.rooms[0]!.id}/free-units`);
    expect(choices.json().units.length).toBe(3);

    const checkedIn = await frontDesk.post(`/reservations/${r.id}/check-in`, {});
    expect(checkedIn.statusCode).toBe(200);
    expect(checkedIn.json().status).toBe('in_house');

    const charge = await frontDesk.post(`/reservations/${r.id}/charges`, {
      kind: 'food',
      description: 'Breakfast',
      unitAmount: 40_000,
      quantity: 2,
    });
    expect(charge.statusCode).toBe(201);
    expect(charge.json()).toMatchObject({ amount: 80_000, taxAmount: 4_000 });

    // Check-out is refused while money is owed, and says how much.
    const refused = await frontDesk.post(`/reservations/${r.id}/check-out`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'conflict',
      details: { reason: 'balance_due', balance: 472_500 + 84_000 },
    });

    const folios = (await frontDesk.get(`/reservations/${r.id}/folios`)).json();
    const folioId = folios.folios[0].id as string;
    const paid = await frontDesk.post(`/folios/${folioId}/payments`, {
      method: 'upi',
      amount: 556_500,
      reference: 'UPI 778812',
    });
    expect(paid.statusCode).toBe(201);
    const out = await frontDesk.post(`/reservations/${r.id}/check-out`, {});
    expect(out.statusCode).toBe(200);
    expect(out.json()).toMatchObject({ balance: 0, reservation: { status: 'checked_out' } });

    // The folio closed with the stay; it can still be invoiced.
    const invoice = await frontDesk.post(`/folios/${folioId}/invoices`, {
      billTo: { name: 'Farah Khan', gstin: null },
    });
    expect(invoice.statusCode).toBe(201);
    expect(invoice.json()).toMatchObject({
      type: 'invoice',
      sequence: 1,
      totals: { taxable: 530_000, taxTotal: 26_500, total: 556_500 },
    });
    const after = (await frontDesk.get(`/reservations/${r.id}/folios`)).json();
    expect(after.balance).toBe(0);
    expect(after.invoices).toHaveLength(1);

    // Only accounting may issue a credit note, and only they may refund.
    const invoiceId = invoice.json().id as string;
    const breakfast = (invoice.json().lines as { description: string }[]).findIndex(
      (l) => l.description === 'Breakfast',
    );
    const creditBody = { reason: 'Breakfast was not served', lines: [{ index: breakfast }] };
    expect(
      (await frontDesk.post(`/invoices/${invoiceId}/credit-notes`, creditBody)).statusCode,
    ).toBe(403);
    const credit = await accountant.post(`/invoices/${invoiceId}/credit-notes`, creditBody);
    expect(credit.statusCode).toBe(201);
    expect(credit.json().totals.total).toBe(-84_000);

    const paymentId = paid.json().payment.id as string;
    const refundBody = { amount: 84_000, reason: 'Breakfast was not served' };
    expect((await frontDesk.post(`/payments/${paymentId}/refund`, refundBody)).statusCode).toBe(
      403,
    );
    // The credit note reopened the folio, which now shows the guest in credit.
    const credited = (await accountant.get(`/reservations/${r.id}/folios`)).json();
    expect(credited).toMatchObject({ balance: -84_000, folios: [{ status: 'open' }] });
    expect((await accountant.post(`/payments/${paymentId}/refund`, refundBody)).statusCode).toBe(
      201,
    );
    expect((await accountant.get(`/reservations/${r.id}/folios`)).json().balance).toBe(0);

    const listed = (await accountant.get(`/invoices?propertyIds=${hotel.property.id}`)).json();
    expect(listed.invoices.map((i: { type: string }) => i.type).sort()).toEqual([
      'credit_note',
      'invoice',
    ]);
    expect((await accountant.get(`/invoices/${invoiceId}`)).json().number).toBe(
      invoice.json().number,
    );
  });
});

describe('who may do what', () => {
  it('keeps money away from housekeeping, and changes away from read-only users', async () => {
    const r = await book(0, 2);
    const hk = `/properties/${hotel.property.id}/housekeeping`;
    expect((await housekeeper.get(hk)).statusCode).toBe(200);
    expect((await housekeeper.get(`/reservations/${r.id}/folios`)).statusCode).toBe(403);
    expect((await housekeeper.post(`/reservations/${r.id}/check-in`, {})).statusCode).toBe(403);

    // The board says who is coming and going. What they owe is on it only for those who may see bills.
    const boardFor = async (client: TestClient) =>
      (await client.get(`/properties/${hotel.property.id}/front-desk`)).json().arrivals as {
        code: string;
        balance: number | null;
      }[];
    expect((await boardFor(housekeeper)).find((s) => s.code === r.code)).toMatchObject({
      balance: null,
    });
    expect((await boardFor(reader)).find((s) => s.code === r.code)).toMatchObject({ balance: 0 });

    expect((await reader.get(`/properties/${hotel.property.id}/front-desk`)).statusCode).toBe(200);
    expect((await reader.get(`/reservations/${r.id}/folios`)).statusCode).toBe(200);
    expect((await reader.post(`/reservations/${r.id}/check-in`, {})).statusCode).toBe(403);
    expect(
      (
        await reader.post(`/reservations/${r.id}/charges`, {
          kind: 'food',
          description: 'x',
          unitAmount: 100,
        })
      ).statusCode,
    ).toBe(403);
    expect((await reader.post(`${hk}/refresh`)).statusCode).toBe(403);

    expect((await frontDesk.post(`/properties/${hotel.property.id}/night-audit`)).statusCode).toBe(
      403,
    );
    expect(
      (await ctx.anonymous().get(`/properties/${hotel.property.id}/front-desk`)).statusCode,
    ).toBe(401);
    expect(
      (
        await frontDesk.put(`/properties/${hotel.property.id}/tax-rules/room`, {
          name: 'No tax',
          slabs: [{ upTo: null, rateBp: 0 }],
          components: [{ code: 'TAX', shareBp: 10_000 }],
        })
      ).statusCode,
    ).toBe(403);
  });

  it('hides another organisation’s folios, invoices and tasks', async () => {
    const r = await book(0, 1);
    await frontDesk.post(`/reservations/${r.id}/charges`, {
      kind: 'food',
      description: 'Tea',
      unitAmount: 5_000,
    });
    const folioId = (await frontDesk.get(`/reservations/${r.id}/folios`)).json().folios[0]
      .id as string;

    const other = await createTestOrg(ctx.t.db, 'Rival Hotels');
    const rival = await ctx.login(
      (await createTestUser(ctx.t.db, other.orgId, { role: 'org_admin' })).email,
    );
    expect((await rival.get(`/folios/${folioId}`)).statusCode).toBe(404);
    expect(
      (await rival.post(`/folios/${folioId}/payments`, { method: 'cash', amount: 100 })).statusCode,
    ).toBe(404);
    expect((await rival.get(`/reservations/${r.id}/folios`)).statusCode).toBe(404);
    expect((await rival.get(`/properties/${hotel.property.id}/housekeeping`)).statusCode).toBe(404);
    expect((await rival.get('/companies')).json().companies).toEqual([]);

    // A reservation cannot be tied to another organisation's company.
    const theirs = await rival.post('/companies', { name: 'Rival Travel' });
    expect(theirs.statusCode).toBe(201);
    const linked = await frontDesk.patch(`/reservations/${r.id}`, { companyId: theirs.json().id });
    expect(linked.statusCode).toBe(404);
  });
});

describe('night audit, housekeeping and maintenance over the API', () => {
  it('closes the day, lists the cleaning, and takes a room off sale for repairs', async () => {
    const status = (await accountant.get(`/properties/${hotel.property.id}/night-audit`)).json();
    expect(status.status).toMatchObject({ businessDate: today, daysBehind: 0, automaticAt: 3 });

    const audit = await accountant.post(`/properties/${hotel.property.id}/night-audit`);
    expect(audit.statusCode).toBe(201);
    expect(audit.json()).toMatchObject({ businessDate: today, status: 'completed' });
    // The next day has not begun by the calendar, so it cannot be closed yet.
    expect((await accountant.post(`/properties/${hotel.property.id}/night-audit`)).statusCode).toBe(
      409,
    );
    expect(
      (await accountant.get(`/properties/${hotel.property.id}/night-audit`)).json().audits,
    ).toHaveLength(1);

    const board = (await housekeeper.get(`/properties/${hotel.property.id}/housekeeping`)).json();
    expect(board.date).toBe(day(1));
    const unit = board.units.find((u: { occupancy: string }) => u.occupancy === 'vacant');
    const task = await housekeeper.post('/housekeeping/tasks', {
      propertyId: hotel.property.id,
      unitId: unit.unitId,
      kind: 'deep_clean',
    });
    expect(task.statusCode).toBe(201);
    const done = await housekeeper.patch(`/housekeeping/tasks/${task.json().id}`, {
      status: 'done',
    });
    expect(done.json().status).toBe('done');
    const staff = (await housekeeper.get(`/properties/${hotel.property.id}/staff`)).json().staff;
    expect(staff.length).toBeGreaterThan(0);
    expect(staff.every((s: { roles: string[] }) => s.roles.length > 0)).toBe(true);

    // Housekeeping may see maintenance but not report it; the admin can.
    const issueBody = {
      propertyId: hotel.property.id,
      unitId: unit.unitId,
      title: 'Air conditioner leaking',
      priority: 'high',
      offSale: { from: day(5), to: day(7) },
    };
    expect((await housekeeper.post('/maintenance', issueBody)).statusCode).toBe(403);
    const issue = await admin.post('/maintenance', issueBody);
    expect(issue.statusCode).toBe(201);
    const listed = (await housekeeper.get(`/maintenance?propertyIds=${hotel.property.id}`)).json();
    expect(listed.issues).toMatchObject([
      { title: 'Air conditioner leaking', offSale: { from: day(5), to: day(7) } },
    ]);
    const availability = (
      await admin.get(`/properties/${hotel.property.id}/availability?from=${day(5)}&to=${day(6)}`)
    ).json();
    const standard =
      availability.days.find((d: { roomTypeId: string }) => d.roomTypeId === unit.roomTypeId) ??
      availability.days[0];
    expect(standard.outOfOrder + standard.blocked).toBeGreaterThan(0);
    const resolved = await admin.patch(`/maintenance/${issue.json().id}`, { status: 'resolved' });
    expect(resolved.json().status).toBe('resolved');
  });

  it('manages companies and their accounts', async () => {
    const created = await accountant.post('/companies', {
      name: 'Zenith Pharma',
      gstin: '27AAACZ1234A1Z5',
      creditLimit: 5_000_000,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ stateCode: '27', kind: 'corporate' });
    expect((await frontDesk.post('/companies', { name: 'Not allowed' })).statusCode).toBe(403);
    expect((await accountant.post('/companies', { name: 'Bad', gstin: 'XYZ' })).statusCode).toBe(
      400,
    );
    const found = (await frontDesk.get('/companies?search=zenith')).json();
    expect(found.companies).toMatchObject([{ name: 'Zenith Pharma', outstanding: 0 }]);
    const companyId = created.json().id;
    const statement = await accountant.get(`/companies/${companyId}/statement`);
    expect(statement.json()).toMatchObject({ entries: [], company: { name: 'Zenith Pharma' } });

    // A stay booked for the company, then billed to it, shows on its account.
    const r = await book(20, 22);
    const linked = await frontDesk.patch(`/reservations/${r.id}`, { companyId });
    expect(linked.json().company).toMatchObject({ id: companyId, name: 'Zenith Pharma' });
    const extra = { kind: 'extra', description: 'Airport transfer', unitAmount: 250_000 };
    expect((await frontDesk.post(`/reservations/${r.id}/charges`, extra)).statusCode).toBe(201);
    const [folio] = (await accountant.get(`/reservations/${r.id}/folios`)).json().folios;
    const billed = await accountant.post(`/folios/${folio.id}/bill-company`, { companyId });
    expect(billed.statusCode).toBe(200);
    const owed = (await accountant.get('/companies?search=zenith')).json().companies[0];
    expect(owed.outstanding).toBeGreaterThan(0);
    expect(
      (await accountant.get(`/companies/${companyId}/statement`)).json().entries,
    ).not.toHaveLength(0);

    // Someone who keeps the books of another property sees the company, not this property's money.
    const elsewhere = await createTestHotel(ctx.t.db, ctx.org, { standardRooms: 1 });
    const other = await createTestUser(ctx.t.db, ctx.org.orgId, {
      role: 'accountant',
      propertyId: elsewhere.property.id,
    });
    const otherAccountant = await ctx.login(other.email);
    expect((await otherAccountant.get('/companies?search=zenith')).json().companies).toMatchObject([
      { name: 'Zenith Pharma', outstanding: 0 },
    ]);
    expect((await otherAccountant.get(`/companies/${companyId}/statement`)).json()).toMatchObject({
      entries: [],
      accounts: [],
      company: { outstanding: 0 },
    });
    expect((await admin.get('/companies?search=zenith')).json().companies[0].outstanding).toBe(
      owed.outstanding,
    );
  });
});
