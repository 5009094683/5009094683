import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  dailyStats,
  folioLines,
  housekeepingTasks,
  outbox,
  properties,
  reservationRooms,
  units,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createCompany, companyStatement, listCompanies } from './companies';
import { systemActor } from './context';
import { addDays, todayIn } from './dates';
import { DomainError } from './errors';
import {
  closeFolio,
  createFolio,
  getFolio,
  listFolios,
  moveLines,
  postCharge,
  recordPayment,
  refundPayment,
  reservationBalance,
  transferToCompany,
  voidLine,
} from './folios';
import { checkIn, checkOut, freeUnitsFor, frontDeskBoard, undoCheckIn } from './frontdesk';
import {
  createHousekeepingTask,
  housekeepingBoard,
  setHousekeepingStatus,
  updateHousekeepingTask,
} from './housekeeping';
import { getAvailability } from './inventory';
import {
  fiscalYearOf,
  invoiceNumber,
  issueCreditNote,
  issueInvoice,
  listInvoices,
} from './invoices';
import { listIssues, reportIssue, updateIssue } from './maintenance';
import { nightAuditStatus, runDueNightAudits, runNightAudit } from './nightaudit';
import { createReservation, loadReservation, updateReservation } from './reservations';
import { computeTax, saveTaxRule, taxRulesFor } from './taxes';
import {
  createTestHotel,
  createTestOrg,
  createTestVilla,
  type TestHotel,
  type TestOrg,
} from './testing';

let t: TestDatabase;
let org: TestOrg;

const TZ = 'Asia/Kolkata';
const today = todayIn(TZ);
const day = (offset: number) => addDays(today, offset);
/** A moment on the given hotel day, mid-morning in India. */
const at = (offset: number, hour = 10) =>
  new Date(`${day(offset)}T${String(hour).padStart(2, '0')}:00:00+05:30`);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
});
afterAll(async () => {
  await t.drop();
});

async function errorOf(promise: Promise<unknown>): Promise<DomainError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

/** A hotel whose rooms are clean and whose hotel day is today. Standard rooms are 4,500 a night, deluxe 7,000. */
async function hotel(
  options: { standardRooms?: number; deluxeRooms?: number } = {},
): Promise<TestHotel> {
  const h = await createTestHotel(t.db, org, { standardRooms: 3, deluxeRooms: 2, ...options });
  await t.db
    .update(properties)
    .set({ businessDate: today })
    .where(eq(properties.id, h.property.id));
  return h;
}

const book = (
  h: TestHotel,
  from: number,
  to: number,
  extra: {
    deluxe?: boolean;
    guest?: string;
    nightly?: number[];
    paymentCollect?: 'channel' | 'property';
    companyId?: string;
  } = {},
) =>
  createReservation(t.db, org.admin, {
    propertyId: h.property.id,
    source: extra.paymentCollect === 'channel' ? 'ota' : 'direct',
    channelCode: extra.paymentCollect === 'channel' ? 'ABB' : null,
    channelReservationCode: extra.paymentCollect === 'channel' ? 'HMABC12345' : null,
    paymentCollect: extra.paymentCollect,
    companyId: extra.companyId,
    guest: { firstName: extra.guest ?? 'Anita', lastName: 'Desai' },
    rooms: [
      {
        roomTypeId: extra.deluxe ? h.deluxe.roomType.id : h.standard.roomType.id,
        ratePlanId: extra.deluxe ? h.deluxe.ratePlan.id : h.standard.ratePlan.id,
        checkIn: day(from),
        checkOut: day(to),
        adults: 2,
        nightlyRates: extra.nightly,
      },
    ],
  });

const available = async (h: TestHotel, roomTypeId: string, date: string) =>
  (
    await getAvailability(t.db, {
      propertyId: h.property.id,
      range: { from: date, to: addDays(date, 1) },
      roomTypeIds: [roomTypeId],
    })
  )[0]!.available;

describe('tax', () => {
  const gstRooms = {
    slabs: [
      { upTo: 750_000, rateBp: 500 },
      { upTo: null, rateBp: 1_800 },
    ],
    components: [
      { code: 'CGST', shareBp: 5_000 },
      { code: 'SGST', shareBp: 5_000 },
    ],
  };

  it('chooses the rate by the price of one night, and splits it into components that add up', () => {
    expect(computeTax(gstRooms, 450_000)).toEqual({
      rateBp: 500,
      taxAmount: 22_500,
      taxes: [
        { code: 'CGST', rateBp: 250, amount: 11_250 },
        { code: 'SGST', rateBp: 250, amount: 11_250 },
      ],
    });
    // Exactly 7,500 is still the lower rate; one paisa more is not.
    expect(computeTax(gstRooms, 750_000).rateBp).toBe(500);
    expect(computeTax(gstRooms, 750_001)).toMatchObject({ rateBp: 1_800, taxAmount: 135_000 });
    // The rate goes by the price of one, not by the line total.
    expect(computeTax(gstRooms, 400_000, 3)).toMatchObject({ rateBp: 500, taxAmount: 60_000 });
  });

  it('rounds each component on its own, and mirrors a charge exactly when it is reversed', () => {
    const odd = computeTax(gstRooms, 333_333);
    // 2.5% of 3,333.33 is 83.33325: each half rounds to 83.33, and the total is their sum.
    expect(odd.taxes.map((x) => x.amount)).toEqual([8_333, 8_333]);
    expect(odd.taxAmount).toBe(16_666);
    const reversed = computeTax(gstRooms, -333_333);
    expect(reversed.taxAmount).toBe(-16_666);
    expect(reversed.taxes.map((x) => x.amount)).toEqual([-8_333, -8_333]);
    expect(computeTax(gstRooms, 0).taxAmount).toBe(0);
    expect(computeTax(null, 500_000)).toEqual({ rateBp: 0, taxAmount: 0, taxes: [] });
  });

  it('gives a property in India the GST rules the first time they are needed, and nothing elsewhere', async () => {
    const h = await hotel();
    const rules = await taxRulesFor(t.db, h.property.id);
    expect(rules.map((r) => r.category).sort()).toEqual([
      'extra',
      'fee',
      'food',
      'room',
      'service',
    ]);
    const room = rules.find((r) => r.category === 'room')!;
    expect(room).toMatchObject({
      serviceCode: '996311',
      slabs: gstRooms.slabs,
      components: gstRooms.components,
    });
    expect(rules.find((r) => r.category === 'food')!.slabs).toEqual([{ upTo: null, rateBp: 500 }]);
    // Asking again does not add them again.
    expect(await taxRulesFor(t.db, h.property.id)).toHaveLength(5);

    const abroad = await createTestHotel(t.db, org);
    await t.db
      .update(properties)
      .set({ country: 'AE' })
      .where(eq(properties.id, abroad.property.id));
    expect(await taxRulesFor(t.db, abroad.property.id)).toEqual([]);
  });

  it('lets a rule be replaced, without touching what was already charged', async () => {
    const h = await hotel();
    const r = await book(h, 0, 2);
    const before = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 100_000,
    });
    expect(before.taxAmount).toBe(5_000);
    await saveTaxRule(t.db, org.admin, h.property.id, {
      category: 'food',
      name: 'GST on food (specified premises)',
      serviceCode: '996331',
      slabs: [{ upTo: null, rateBp: 1_800 }],
      components: gstRooms.components,
    });
    const after = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Lunch',
      unitAmount: 100_000,
    });
    expect(after.taxAmount).toBe(18_000);
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    expect(folio!.lines.find((l) => l.id === before.id)!.taxAmount).toBe(5_000);
    // The other categories are still there.
    expect(await taxRulesFor(t.db, h.property.id)).toHaveLength(5);

    const bad = (input: Partial<Parameters<typeof saveTaxRule>[3]>) =>
      errorOf(
        saveTaxRule(t.db, org.admin, h.property.id, {
          category: 'food',
          name: 'x',
          slabs: [{ upTo: null, rateBp: 500 }],
          components: gstRooms.components,
          ...input,
        }),
      );
    expect((await bad({ slabs: [{ upTo: 1000, rateBp: 500 }] })).message).toMatch(/no upper limit/);
    expect((await bad({ components: [{ code: 'CGST', shareBp: 4_000 }] })).message).toMatch(
      /add up to 100%/,
    );
    expect((await bad({ slabs: [{ upTo: null, rateBp: 20_000 }] })).message).toMatch(
      /between 0% and 100%/,
    );
  });
});

describe('folios', () => {
  it('keeps a running account of charges, tax, payments and what is owed', async () => {
    const h = await hotel();
    const r = await book(h, 0, 2);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Dinner for two',
      unitAmount: 120_000,
    });
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'service',
      description: 'Laundry',
      unitAmount: 20_000,
      quantity: 3,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    expect(folio).toMatchObject({
      kind: 'guest',
      status: 'open',
      currency: 'INR',
      guestName: 'Anita Desai',
    });
    expect(folio!.billTo.name).toBe('Anita Desai');
    // Food at 5%, services at 18%.
    expect(folio!.totals).toEqual({
      charges: 180_000,
      taxes: 6_000 + 10_800,
      payments: 0,
      transfers: 0,
      balance: 196_800,
    });

    const paid = await recordPayment(t.db, org.admin, {
      folioId: folio!.id,
      method: 'upi',
      amount: 100_000,
      reference: 'UPI 4411223344',
    });
    expect(paid.duplicate).toBe(false);
    expect((await getFolio(t.db, org.orgId, folio!.id)).totals).toMatchObject({
      payments: 100_000,
      balance: 96_800,
    });
    expect(await reservationBalance(t.db, r.id)).toBe(96_800);
  });

  it('takes a discount off with its tax', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    const charge = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room',
      unitAmount: 450_000,
    });
    const discount = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'discount',
      description: 'Goodwill',
      unitAmount: 50_000,
    });
    expect(charge).toMatchObject({ amount: 450_000, taxAmount: 22_500 });
    expect(discount).toMatchObject({ amount: -50_000, taxAmount: -2_500 });
    expect(await reservationBalance(t.db, r.id)).toBe(420_000);
  });

  it('never deletes: a wrong entry is voided, with a reason, and stays visible', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    const line = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Minibar',
      unitAmount: 30_000,
    });
    expect((await errorOf(voidLine(t.db, org.admin, line.id, '  '))).message).toMatch(/why/);
    const voided = await voidLine(t.db, org.admin, line.id, 'Posted to the wrong room');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe('Posted to the wrong room');
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    expect(folio!.lines).toHaveLength(1);
    expect(folio!.totals.balance).toBe(0);
    // Voiding again changes nothing; a payment cannot be voided at all.
    expect((await voidLine(t.db, org.admin, line.id, 'again')).voidReason).toBe(
      'Posted to the wrong room',
    );
    const { line: payment } = await recordPayment(t.db, org.admin, {
      folioId: folio!.id,
      method: 'cash',
      amount: 1_000,
    });
    expect((await errorOf(voidLine(t.db, org.admin, payment.id, 'mistake'))).message).toMatch(
      /Refund it instead/,
    );
  });

  it('refuses to store a card number as a payment reference', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    const [folio] = await Promise.all([
      postCharge(t.db, org.admin, {
        reservationId: r.id,
        kind: 'fee',
        description: 'Late check-out',
        unitAmount: 50_000,
      }),
    ]).then(() => listFolios(t.db, org.orgId, r.id));
    const err = await errorOf(
      recordPayment(t.db, org.admin, {
        folioId: folio!.id,
        method: 'card',
        amount: 59_000,
        reference: '4111 1111 1111 1111',
      }),
    );
    expect(err.message).toMatch(/Card numbers are never stored/);
    const ok = await recordPayment(t.db, org.admin, {
      folioId: folio!.id,
      method: 'card',
      amount: 59_000,
      reference: 'Visa ending 1111, slip 000482',
    });
    expect(ok.payment.reference).toBe('Visa ending 1111, slip 000482');
  });

  it('records an online payment once however often the gateway reports it', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room',
      unitAmount: 450_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    const report = () =>
      recordPayment(t.db, systemActor(org.orgId, 'payments'), {
        folioId: folio!.id,
        method: 'online',
        amount: 472_500,
        provider: 'razorpay',
        providerPaymentId: 'pay_Test123',
      });
    const [a, b, c] = await Promise.all([report(), report(), report()]);
    expect([a, b, c].filter((x) => !x.duplicate)).toHaveLength(1);
    expect(new Set([a.payment.id, b.payment.id, c.payment.id]).size).toBe(1);
    expect(await reservationBalance(t.db, r.id)).toBe(0);
  });

  it('refunds no more than was paid', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room',
      unitAmount: 450_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    const { payment } = await recordPayment(t.db, org.admin, {
      folioId: folio!.id,
      method: 'card',
      amount: 472_500,
    });
    const first = await refundPayment(t.db, org.admin, payment.id, {
      amount: 100_000,
      reason: 'Room was noisy',
    });
    expect(first.payment).toMatchObject({
      amount: -100_000,
      refundOfPaymentId: payment.id,
      method: 'card',
    });
    expect(await reservationBalance(t.db, r.id)).toBe(100_000);
    // The bill says how each amount was paid and how much of a payment can still go back.
    const money = async () =>
      (await getFolio(t.db, org.orgId, folio!.id)).lines.map((l) => [l.kind, l.payment]);
    expect(await money()).toEqual([
      ['room', null],
      ['payment', { method: 'card', refundable: 372_500 }],
      ['refund', { method: 'card', refundable: 0 }],
    ]);
    expect(
      (await errorOf(refundPayment(t.db, org.admin, payment.id, { amount: 400_000, reason: 'x' })))
        .message,
    ).toMatch(/Only ₹3,725 of this payment is left to refund/);
    // With no amount, the rest is refunded.
    const rest = await refundPayment(t.db, org.admin, payment.id, { reason: 'Stay cancelled' });
    expect(rest.payment.amount).toBe(-372_500);
    expect(
      (await errorOf(refundPayment(t.db, org.admin, payment.id, { reason: 'again' }))).message,
    ).toMatch(/already been refunded in full/);
    expect((await money())[1]).toEqual(['payment', { method: 'card', refundable: 0 }]);
    // A refund cannot itself be refunded.
    expect(
      (await errorOf(refundPayment(t.db, org.admin, rest.payment.id, { reason: 'x' }))).code,
    ).toBe('invalid_state');
  });

  it('splits a bill: a second folio can take over a kind of charge, and charges can be moved', async () => {
    const h = await hotel();
    const company = await createCompany(t.db, org.admin, {
      name: 'Acme Travel Desk',
      gstin: '27AAACA1234A1Z5',
    });
    const r = await book(h, 0, 2);
    const extras = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 80_000,
    });
    const companyFolio = await createFolio(t.db, org.admin, r.id, {
      label: 'Room on company',
      companyId: company.id,
      routes: ['room'],
    });
    expect(companyFolio.billTo).toMatchObject({
      name: 'Acme Travel Desk',
      gstin: '27AAACA1234A1Z5',
      stateCode: '27',
    });

    // From now on room charges go to the company folio, everything else to the guest.
    const room = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room night',
      unitAmount: 450_000,
    });
    const minibar = await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Minibar',
      unitAmount: 10_000,
    });
    expect(room.folioId).toBe(companyFolio.id);
    expect(minibar.folioId).toBe(extras.folioId);

    expect(await moveLines(t.db, org.admin, [extras.id], companyFolio.id)).toBe(1);
    const folios = await listFolios(t.db, org.orgId, r.id);
    expect(folios.map((f) => [f.label, f.totals.balance])).toEqual([
      ['Guest folio', 10_500],
      ['Room on company', 472_500 + 84_000],
    ]);
    // Not across reservations.
    const other = await book(h, 0, 1);
    const elsewhere = await postCharge(t.db, org.admin, {
      reservationId: other.id,
      kind: 'food',
      description: 'Tea',
      unitAmount: 5_000,
    });
    expect(
      (await errorOf(moveLines(t.db, org.admin, [elsewhere.id], companyFolio.id))).message,
    ).toMatch(/same reservation/);
  });

  it('bills what is owed to a company account, within its credit limit', async () => {
    const h = await hotel();
    const company = await createCompany(t.db, org.admin, {
      name: 'Blue Ocean Exports',
      creditLimit: 1_000_000,
    });
    const r = await book(h, 0, 1);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room',
      unitAmount: 450_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    const moved = await transferToCompany(t.db, org.admin, folio!.id, company.id);
    expect(moved.amount).toBe(472_500);
    expect(await reservationBalance(t.db, r.id)).toBe(0);
    expect((await listCompanies(t.db, org.orgId, { search: 'blue ocean' }))[0]).toMatchObject({
      outstanding: 472_500,
    });

    // A second stay would take the company past its limit.
    const second = await book(h, 0, 1, { deluxe: true });
    await postCharge(t.db, org.admin, {
      reservationId: second.id,
      kind: 'room',
      description: 'Room',
      unitAmount: 700_000,
    });
    const [secondFolio] = await listFolios(t.db, org.orgId, second.id);
    expect(
      (await errorOf(transferToCompany(t.db, org.admin, secondFolio!.id, company.id))).message,
    ).toMatch(/would exceed its credit limit of ₹10,000 \(already owes ₹4,725\)/);

    // The company pays; its account shows both entries.
    await recordPayment(t.db, org.admin, {
      folioId: moved.accountFolioId,
      method: 'bank_transfer',
      amount: 472_500,
      reference: 'NEFT 88123',
    });
    const statement = await companyStatement(t.db, org.orgId, company.id);
    expect(statement.entries.map((e) => e.amount)).toEqual([472_500, -472_500]);
    expect(statement.company.outstanding).toBe(0);
    expect(
      (await errorOf(transferToCompany(t.db, org.admin, folio!.id, company.id))).message,
    ).toMatch(/Nothing is owed/);
  });

  it('closes only a folio that is settled', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'fee',
      description: 'Pet fee',
      unitAmount: 100_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    expect((await errorOf(closeFolio(t.db, org.admin, folio!.id))).message).toMatch(
      /₹1,180 is owed/,
    );
    await recordPayment(t.db, org.admin, { folioId: folio!.id, method: 'cash', amount: 118_000 });
    expect((await closeFolio(t.db, org.admin, folio!.id)).status).toBe('closed');
    expect(
      (
        await errorOf(
          postCharge(t.db, org.admin, {
            folioId: folio!.id,
            kind: 'food',
            description: 'Tea',
            unitAmount: 5_000,
          }),
        )
      ).message,
    ).toMatch(/closed/);
  });
});

describe('front desk', () => {
  it('checks a guest in to a free, clean room', async () => {
    const h = await hotel({ standardRooms: 2 });
    const r = await book(h, 0, 2);
    const checkedIn = await checkIn(t.db, org.admin, r.id);
    expect(checkedIn.status).toBe('in_house');
    expect(checkedIn.rooms[0]).toMatchObject({ status: 'in_house' });
    expect(checkedIn.rooms[0]!.unitId).not.toBeNull();
    expect(checkedIn.rooms[0]!.checkedInAt).not.toBeNull();
    // Checking in again is refused.
    expect((await errorOf(checkIn(t.db, org.admin, r.id))).code).toBe('invalid_state');

    const board = await frontDeskBoard(t.db, org.orgId, h.property.id);
    expect(board.date).toBe(today);
    expect(board.inHouse.map((s) => s.code)).toEqual([r.code]);
    expect(board.counts).toMatchObject({ arrivals: 0, arrived: 1, inHouse: 1 });
  });

  it('will not put a guest in a room that has not been cleaned, unless told to', async () => {
    const h = await hotel({ standardRooms: 1 });
    const unit = h.standard.units[0]!;
    await t.db.update(units).set({ housekeepingStatus: 'dirty' }).where(eq(units.id, unit.id));
    const r = await book(h, 0, 1);
    const err = await errorOf(checkIn(t.db, org.admin, r.id));
    expect(err.message).toBe(`${unit.name} has not been cleaned yet`);
    expect(err.details).toMatchObject({ reason: 'unit_dirty' });
    expect((await loadReservation(t.db, org.orgId, r.id)).status).toBe('confirmed');
    expect((await checkIn(t.db, org.admin, r.id, { allowDirty: true })).status).toBe('in_house');
  });

  it('refuses to check in before the stay starts, and lets staff choose the room', async () => {
    const h = await hotel({ standardRooms: 3 });
    const early = await book(h, 1, 3);
    expect((await errorOf(checkIn(t.db, org.admin, early.id))).message).toMatch(
      /This stay starts on/,
    );

    const r = await book(h, 0, 2);
    const roomId = r.rooms[0]!.id;
    const choices = await freeUnitsFor(t.db, org.orgId, r.id, roomId);
    expect(choices.length).toBeGreaterThan(0);
    const wanted = choices[choices.length - 1]!;
    const checkedIn = await checkIn(t.db, org.admin, r.id, { units: { [roomId]: wanted.id } });
    expect(checkedIn.rooms[0]!.unitId).toBe(wanted.id);

    // A room that someone else is in cannot be given out.
    const other = await book(h, 0, 1);
    const clash = await errorOf(
      checkIn(t.db, org.admin, other.id, { units: { [other.rooms[0]!.id]: wanted.id } }),
    );
    expect(clash.code).toBe('unit_occupied');
  });

  it('undoes a check-in made by mistake', async () => {
    const h = await hotel();
    const r = await book(h, 0, 2);
    await checkIn(t.db, org.admin, r.id);
    const undone = await undoCheckIn(t.db, org.admin, r.id);
    expect(undone.status).toBe('confirmed');
    expect(undone.rooms[0]!.checkedInAt).toBeNull();
  });

  it('on check-out charges the nights stayed, wants the bill settled, and sends the room for cleaning', async () => {
    const h = await hotel({ standardRooms: 2 });
    const r = await book(h, 0, 1);
    await checkIn(t.db, org.admin, r.id);
    // A same-day check-out still pays for the night.
    const owing = await errorOf(checkOut(t.db, org.admin, r.id));
    expect(owing.code).toBe('conflict');
    expect(owing.message).toMatch(/₹4,725 is still owed/);
    expect(owing.details).toMatchObject({ reason: 'balance_due', balance: 472_500 });
    // Nothing happened: the refusal undid the charge and the guest is still in.
    expect((await loadReservation(t.db, org.orgId, r.id)).status).toBe('in_house');
    expect(await reservationBalance(t.db, r.id)).toBe(0);

    const [folio] = await listFolios(t.db, org.orgId, r.id);
    await recordPayment(t.db, org.admin, {
      folioId: folio!.id,
      method: 'card',
      amount: 472_500,
      reference: 'slip 1001',
    });
    // Paying in advance of the charge leaves a credit, which check-out then uses.
    const result = await checkOut(t.db, org.admin, r.id);
    expect(result.balance).toBe(0);
    expect(result.reservation.status).toBe('checked_out');
    expect(result.reservation.rooms[0]!.checkedOutAt).not.toBeNull();

    const after = await getFolio(t.db, org.orgId, folio!.id);
    expect(after.status).toBe('closed');
    expect(after.lines.filter((l) => l.kind === 'room')).toHaveLength(1);
    const unitId = result.reservation.rooms[0]!.unitId!;
    const [unit] = await t.db.select().from(units).where(eq(units.id, unitId));
    expect(unit!.housekeepingStatus).toBe('dirty');
    const tasks = await t.db
      .select()
      .from(housekeepingTasks)
      .where(eq(housekeepingTasks.unitId, unitId));
    expect(tasks).toMatchObject([{ kind: 'departure', date: today, status: 'pending' }]);
  });

  it('gives back the nights of an early departure, and tells the channels', async () => {
    const h = await hotel({ standardRooms: 1 });
    const std = h.standard.roomType.id;
    const r = await book(h, 0, 4);
    expect(await available(h, std, day(2))).toBe(0);
    await checkIn(t.db, org.admin, r.id);
    await t.db.delete(outbox);
    const result = await checkOut(t.db, org.admin, r.id, { balance: 'leave_open' });
    expect(result.nightsReleased).toBe(3);
    expect(result.reservation).toMatchObject({
      checkIn: day(0),
      checkOut: day(1),
      status: 'checked_out',
    });
    // Only the night stayed is charged; the folio stays open because it is owed.
    expect(result.balance).toBe(472_500);
    expect((await listFolios(t.db, org.orgId, r.id))[0]!.status).toBe('open');
    expect(await available(h, std, day(1))).toBe(1);
    expect(await available(h, std, day(3))).toBe(1);
    const events = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    expect(events.some((e) => e.payload.roomTypeId === std)).toBe(true);
  });

  it('bills a company guest’s stay to the company at check-out', async () => {
    const h = await hotel();
    const company = await createCompany(t.db, org.admin, { name: 'Northwind Logistics' });
    const r = await book(h, 0, 1, { companyId: company.id });
    await checkIn(t.db, org.admin, r.id);
    const result = await checkOut(t.db, org.admin, r.id, { balance: 'bill_company' });
    expect(result.balance).toBe(0);
    expect((await listCompanies(t.db, org.orgId, { search: 'northwind' }))[0]!.outstanding).toBe(
      472_500,
    );
    expect((await listFolios(t.db, org.orgId, r.id))[0]!.status).toBe('closed');

    const walkIn = await book(h, 0, 1);
    await checkIn(t.db, org.admin, walkIn.id);
    expect(
      (await errorOf(checkOut(t.db, org.admin, walkIn.id, { balance: 'bill_company' }))).message,
    ).toMatch(/not linked to a company/);
  });

  it('lists who is arriving, leaving and staying', async () => {
    const h = await hotel({ standardRooms: 4 });
    const arriving = await book(h, 0, 2, { guest: 'Arriving' });
    const staying = await book(h, 0, 3, { guest: 'Staying' });
    await checkIn(t.db, org.admin, staying.id);
    await updateReservation(t.db, org.admin, arriving.id, {
      arrivalTime: '18:30',
      specialRequests: 'Ground floor',
    });
    const board = await frontDeskBoard(t.db, org.orgId, h.property.id);
    expect(board.arrivals).toMatchObject([
      {
        code: arriving.code,
        guestName: 'Arriving Desai',
        arrivalTime: '18:30',
        specialRequests: 'Ground floor',
        unitHousekeeping: 'clean',
      },
    ]);
    expect(board.inHouse.map((s) => s.guestName)).toEqual(['Staying Desai']);
    expect(board.departures).toEqual([]);
    // Tomorrow's board, looked at ahead of time: nobody is due out yet.
    const tomorrow = await frontDeskBoard(t.db, org.orgId, h.property.id, day(3));
    expect(tomorrow.departures.map((s) => s.guestName)).toEqual(['Staying Desai']);
  });
});

describe('night audit', () => {
  it('charges each occupied room for the night, once, and moves the hotel day on', async () => {
    const h = await hotel({ standardRooms: 3, deluxeRooms: 2 });
    const a = await book(h, 0, 2);
    const b = await book(h, 0, 3, { deluxe: true, nightly: [800_000, 700_000, 700_000] });
    await checkIn(t.db, org.admin, a.id);
    await checkIn(t.db, org.admin, b.id);

    const audit = await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    expect(audit).toMatchObject({ businessDate: today, status: 'completed' });
    expect(audit.summary).toMatchObject({
      roomChargesPosted: 2,
      stayovers: 2,
      noShows: [],
      pendingArrivals: [],
    });
    // 4,500 + 5% and 8,000 + 18% (above 7,500 a night).
    expect(audit.summary.roomRevenue).toBe(472_500 + 944_000);
    const status = await nightAuditStatus(t.db, org.orgId, h.property.id, at(0, 23));
    expect(status).toMatchObject({ businessDate: day(1), daysBehind: 0 });

    const [folioB] = await listFolios(t.db, org.orgId, b.id);
    expect(folioB!.lines).toMatchObject([
      {
        kind: 'room',
        businessDate: today,
        amount: 800_000,
        taxAmount: 144_000,
        source: 'night_audit',
      },
    ]);
    expect(folioB!.lines[0]!.taxes).toEqual([
      { code: 'CGST', rateBp: 900, amount: 72_000 },
      { code: 'SGST', rateBp: 900, amount: 72_000 },
    ]);
    // Worded for the bill and the invoice a guest reads, not as a date a database writes.
    expect(folioB!.lines[0]!.description).toMatch(
      /^Deluxe Room, night of \d{1,2} [A-Z][a-z]{2} \d{4}$/,
    );

    // The same day cannot be closed twice; the next one has not begun.
    expect(
      (await errorOf(runNightAudit(t.db, org.admin, h.property.id, at(0, 23)))).message,
    ).toMatch(/has not started yet/);

    // The next night: 7,000 is at or under 7,500, so 5%.
    const second = await runNightAudit(t.db, org.admin, h.property.id, at(1, 23));
    expect(second.summary.roomChargesPosted).toBe(2);
    const lines = (await listFolios(t.db, org.orgId, b.id))[0]!.lines;
    expect(lines.map((l) => [l.businessDate, l.amount, l.taxAmount])).toEqual([
      [today, 800_000, 144_000],
      [day(1), 700_000, 35_000],
    ]);
  });

  it('saves the day’s figures for reports', async () => {
    const h = await hotel({ standardRooms: 3, deluxeRooms: 2 });
    const a = await book(h, 0, 2);
    const ota = await book(h, 0, 1, { deluxe: true, paymentCollect: 'channel' });
    await checkIn(t.db, org.admin, a.id);
    await checkIn(t.db, org.admin, ota.id);
    await postCharge(t.db, org.admin, {
      reservationId: a.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 100_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, a.id);
    await recordPayment(t.db, org.admin, { folioId: folio!.id, method: 'cash', amount: 50_000 });
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));

    const [stats] = await t.db
      .select()
      .from(dailyStats)
      .where(and(eq(dailyStats.propertyId, h.property.id), eq(dailyStats.date, today)));
    expect(stats).toMatchObject({
      availableRooms: 5,
      soldRooms: 2,
      arrivals: 2,
      departures: 0,
      roomRevenue: 450_000 + 700_000,
      otherRevenue: 100_000,
      taxAmount: 22_500 + 35_000 + 5_000,
      byChannel: { DIRECT: { rooms: 1, revenue: 450_000 }, ABB: { rooms: 1, revenue: 700_000 } },
    });
    // Cash from the guest, plus what the channel collected for its booking.
    expect(stats!.paymentsReceived).toBe(50_000 + 735_000);
  });

  it('does not ask a guest to pay what the channel already collected', async () => {
    const h = await hotel();
    const r = await book(h, 0, 2, { paymentCollect: 'channel' });
    await checkIn(t.db, org.admin, r.id);
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    expect(folio!.lines.map((l) => [l.kind, l.amount + l.taxAmount])).toEqual([
      ['room', 472_500],
      ['payment', -472_500],
    ]);
    expect(folio!.lines[1]!.description).toBe('Payment (Collected by the channel) HMABC12345');
    expect(folio!.totals.balance).toBe(0);
  });

  it('lists guests who did not arrive and guests who did not leave, and tells staff', async () => {
    const h = await hotel({ standardRooms: 4 });
    const noShow = await book(h, 0, 2, { guest: 'Absent' });
    const overdue = await book(h, 0, 1, { guest: 'Lingering' });
    await checkIn(t.db, org.admin, overdue.id);
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    // Day two: the first guest never came, the second should have left and has not.
    const audit = await runNightAudit(t.db, org.admin, h.property.id, at(1, 23));
    expect(audit.summary.pendingArrivals).toEqual([`${noShow.code} Absent Desai`]);
    expect(audit.summary.overdueDepartures).toEqual([`${overdue.code} Lingering Desai`]);
    expect(audit.summary.warnings).toHaveLength(2);
    const [alert] = (
      await t.db
        .select()
        .from(alerts)
        .where(eq(alerts.dedupeKey, `night_audit_exceptions:${h.property.id}`))
    ).filter((a) => a.status !== 'resolved');
    expect(alert).toMatchObject({ kind: 'night_audit', severity: 'warning' });
    expect(alert!.body).toContain('Lingering Desai');
    // The booking that did not arrive is left for staff to decide.
    expect((await loadReservation(t.db, org.orgId, noShow.id)).status).toBe('confirmed');

    // The overstayed guest is charged for the extra night when checked out late.
    const result = await checkOut(t.db, org.admin, overdue.id, { balance: 'leave_open' });
    expect(result.reservation.checkOut).toBe(day(2));
    expect(
      (await listFolios(t.db, org.orgId, overdue.id))[0]!.lines.filter((l) => l.kind === 'room'),
    ).toHaveLength(2);
  });

  it('marks no-shows itself when the property has chosen that, and frees the rooms', async () => {
    const h = await hotel({ standardRooms: 1 });
    await t.db
      .update(properties)
      .set({ settings: { autoNoShow: true } })
      .where(eq(properties.id, h.property.id));
    const r = await book(h, 0, 3);
    const audit = await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    expect(audit.summary.noShows).toEqual([`${r.code} Anita Desai`]);
    expect((await loadReservation(t.db, org.orgId, r.id)).status).toBe('no_show');
    expect(await available(h, h.standard.roomType.id, day(1))).toBe(1);
  });

  it('writes the next day’s cleaning list and marks occupied rooms for service', async () => {
    const h = await hotel({ standardRooms: 3 });
    const leaving = await book(h, 0, 1, { guest: 'Leaving' });
    const staying = await book(h, 0, 3, { guest: 'Staying' });
    await checkIn(t.db, org.admin, leaving.id);
    await checkIn(t.db, org.admin, staying.id);
    const audit = await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    expect(audit.summary.housekeepingTasks).toBe(2);
    const board = await housekeepingBoard(t.db, org.orgId, h.property.id);
    expect(board.date).toBe(day(1));
    const byGuest = Object.fromEntries(
      board.units.filter((u) => u.guestName).map((u) => [u.guestName!, u]),
    );
    expect(byGuest['Leaving Desai']).toMatchObject({ occupancy: 'departing', status: 'dirty' });
    expect(byGuest['Leaving Desai']!.tasks).toMatchObject([
      { kind: 'departure', status: 'pending' },
    ]);
    expect(byGuest['Staying Desai']).toMatchObject({
      occupancy: 'occupied',
      status: 'dirty',
      departs: day(3),
    });
    expect(byGuest['Staying Desai']!.tasks).toMatchObject([{ kind: 'stayover' }]);
    expect(board.counts).toMatchObject({ dirty: 2, clean: 3, tasksOpen: 2, tasksDone: 0 });
  });

  it('runs by itself once the day has ended and the audit hour has come, catching up if it fell behind', async () => {
    const h = await hotel({ standardRooms: 2 });
    const r = await book(h, 0, 4);
    await checkIn(t.db, org.admin, r.id);
    const actorFor = (orgId: string) => systemActor(orgId, 'night-audit');
    const mine = (results: Awaited<ReturnType<typeof runDueNightAudits>>) =>
      results.filter((x) => x.propertyId === h.property.id);

    // Still the same day: nothing to close.
    expect(mine(await runDueNightAudits(t.db, actorFor, at(0, 23)))).toEqual([]);
    // Past midnight but before the audit hour (3 am): not yet.
    expect(mine(await runDueNightAudits(t.db, actorFor, at(1, 1)))).toEqual([]);
    // After the audit hour: yesterday is closed.
    expect(mine(await runDueNightAudits(t.db, actorFor, at(1, 4)))).toEqual([
      { propertyId: h.property.id, businessDate: today, ok: true },
    ]);
    expect(mine(await runDueNightAudits(t.db, actorFor, at(1, 5)))).toEqual([]);

    // The worker was down for two days: both missed days are closed, in order.
    expect(mine(await runDueNightAudits(t.db, actorFor, at(3, 9)))).toEqual([
      { propertyId: h.property.id, businessDate: day(1), ok: true },
      { propertyId: h.property.id, businessDate: day(2), ok: true },
    ]);
    const nights = (await listFolios(t.db, org.orgId, r.id))[0]!.lines.filter(
      (l) => l.kind === 'room',
    );
    expect(nights.map((l) => l.businessDate)).toEqual([day(0), day(1), day(2)]);

    // A property that turned the automatic run off is left alone.
    await t.db
      .update(properties)
      .set({ settings: { nightAuditHour: null } })
      .where(eq(properties.id, h.property.id));
    expect(mine(await runDueNightAudits(t.db, actorFor, at(5, 9)))).toEqual([]);
  });
});

describe('invoices', () => {
  it('names the financial year the way invoices are numbered', () => {
    expect(fiscalYearOf('2026-03-31', 'IN')).toBe('25-26');
    expect(fiscalYearOf('2026-04-01', 'IN')).toBe('26-27');
    expect(fiscalYearOf('2026-11-13', 'in')).toBe('26-27');
    expect(fiscalYearOf('2026-11-13', 'AE')).toBe('2026');
    const property = { code: 'SEABREEZE', settings: {} };
    expect(invoiceNumber(property, 'invoice', '26-27', 42)).toBe('SEAB/26-27/00042');
    expect(invoiceNumber(property, 'credit_note', '26-27', 7)).toBe('SEAB/26-27/C0007');
    expect(
      invoiceNumber({ code: 'X', settings: { invoicePrefix: 'gh-1' } }, 'invoice', '26-27', 123456),
    ).toBe('GH1/26-27/123456');
    // Never more than the sixteen characters a GST invoice number may have.
    expect(invoiceNumber(property, 'invoice', '26-27', 1234567).length).toBeLessThanOrEqual(16);
  });

  it('issues a tax invoice with the tax shown by component, once per charge', async () => {
    const h = await hotel();
    await t.db
      .update(properties)
      .set({
        legalName: 'Sea Breeze Hospitality Pvt Ltd',
        gstin: '30AAACS1234A1Z5',
        stateCode: '30',
        state: 'Goa',
      })
      .where(eq(properties.id, h.property.id));
    const r = await book(h, 0, 2, { deluxe: true, nightly: [800_000, 700_000] });
    await checkIn(t.db, org.admin, r.id);
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 100_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);

    const invoice = await issueInvoice(t.db, org.admin, folio!.id, {
      billTo: {
        name: 'Acme Corp',
        gstin: '27aaaca1234a1z5',
        stateCode: '27',
        state: 'Maharashtra',
      },
    });
    const fy = fiscalYearOf(day(1), 'IN');
    expect(invoice).toMatchObject({
      type: 'invoice',
      sequence: 1,
      fiscalYear: fy,
      issuedOn: day(1),
      currency: 'INR',
    });
    expect(invoice.number).toBe(`${h.property.code.slice(0, 4)}/${fy}/00001`);
    expect(invoice.seller).toMatchObject({
      name: 'Sea Breeze Hospitality Pvt Ltd',
      gstin: '30AAACS1234A1Z5',
      stateCode: '30',
    });
    expect(invoice.buyer).toMatchObject({ name: 'Acme Corp', gstin: '27AAACA1234A1Z5' });
    expect(invoice.lines).toMatchObject([
      {
        description: expect.stringContaining('Deluxe Room'),
        serviceCode: '996311',
        amount: 800_000,
        taxAmount: 144_000,
      },
      { description: 'Dinner', serviceCode: '996331', amount: 100_000, taxAmount: 5_000 },
    ]);
    expect(invoice.totals).toEqual({
      taxable: 900_000,
      taxes: { CGST: 74_500, SGST: 74_500 },
      taxTotal: 149_000,
      total: 1_049_000,
    });
    expect(invoice.reference).toMatchObject({ reservation: r.code, guest: 'Anita Desai' });

    // Those charges are now invoiced: they cannot be invoiced again, voided or moved.
    expect((await errorOf(issueInvoice(t.db, org.admin, folio!.id))).message).toMatch(
      /nothing on this folio left to invoice/,
    );
    const line = (await getFolio(t.db, org.orgId, folio!.id)).lines[0]!;
    expect(line.invoiceId).toBe(invoice.id);
    expect((await errorOf(voidLine(t.db, org.admin, line.id, 'oops'))).message).toMatch(
      /Issue a credit note/,
    );

    // A later charge goes on the next invoice.
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'service',
      description: 'Airport transfer',
      unitAmount: 150_000,
    });
    const next = await issueInvoice(t.db, org.admin, folio!.id);
    expect(next.sequence).toBe(2);
    expect(next.lines).toHaveLength(1);
    expect(next.buyer.name).toBe('Anita Desai');
    expect(
      (
        await errorOf(
          issueInvoice(t.db, org.admin, folio!.id, { billTo: { name: 'X', gstin: 'short' } }),
        )
      ).code,
    ).toBe('invalid_state');
  });

  it('corrects an invoice only by credit note, never for more than was invoiced', async () => {
    const h = await hotel();
    const r = await book(h, 0, 1);
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'room',
      description: 'Room night',
      unitAmount: 450_000,
    });
    await postCharge(t.db, org.admin, {
      reservationId: r.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 100_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, r.id);
    const invoice = await issueInvoice(t.db, org.admin, folio!.id);
    expect(await reservationBalance(t.db, r.id)).toBe(472_500 + 105_000);

    expect(
      (await errorOf(issueCreditNote(t.db, org.admin, invoice.id, { reason: ' ' }))).message,
    ).toMatch(/needs a reason/);
    const partial = await issueCreditNote(t.db, org.admin, invoice.id, {
      reason: 'Dinner was served cold',
      lines: [{ index: 1, amount: 40_000 }],
    });
    expect(partial).toMatchObject({
      type: 'credit_note',
      relatedInvoiceId: invoice.id,
      sequence: 1,
    });
    expect(partial.number).toMatch(/\/C0001$/);
    expect(partial.totals).toEqual({
      taxable: -40_000,
      taxes: { CGST: -1_000, SGST: -1_000 },
      taxTotal: -2_000,
      total: -42_000,
    });
    expect(partial.reference).toMatchObject({ invoice: invoice.number });
    // The folio owes that much less.
    expect(await reservationBalance(t.db, r.id)).toBe(472_500 + 105_000 - 42_000);

    expect(
      (
        await errorOf(
          issueCreditNote(t.db, org.admin, invoice.id, {
            reason: 'x',
            lines: [{ index: 1, amount: 100_001 }],
          }),
        )
      ).message,
    ).toMatch(/no more than the amount invoiced/);
    // Crediting the whole invoice now would exceed it.
    expect(
      (await errorOf(issueCreditNote(t.db, org.admin, invoice.id, { reason: 'Cancel everything' })))
        .message,
    ).toMatch(/add up to more than the invoice/);
    expect(
      (await errorOf(issueCreditNote(t.db, org.admin, partial.id, { reason: 'x' }))).message,
    ).toMatch(/only be issued against an invoice/);

    const listed = await listInvoices(t.db, org.orgId, { propertyIds: [h.property.id] });
    expect(listed.map((i) => i.type).sort()).toEqual(['credit_note', 'invoice']);
  });

  it('numbers invoices issued at the same moment without gaps or repeats', async () => {
    const h = await hotel({ standardRooms: 8 });
    const folioIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await book(h, 0, 1, { guest: `Guest${i}` });
      await postCharge(t.db, org.admin, {
        reservationId: r.id,
        kind: 'room',
        description: 'Room night',
        unitAmount: 450_000,
      });
      folioIds.push((await listFolios(t.db, org.orgId, r.id))[0]!.id);
    }
    const issued = await Promise.all(folioIds.map((id) => issueInvoice(t.db, org.admin, id)));
    expect(issued.map((i) => i.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(issued.map((i) => i.number)).size).toBe(8);
  });
});

describe('housekeeping', () => {
  it('marks a room clean when its task is done, and inspected only once it is clean', async () => {
    const h = await hotel({ standardRooms: 2 });
    const unit = h.standard.units[0]!;
    await setHousekeepingStatus(t.db, org.admin, [unit.id], 'dirty');
    const clean = await createHousekeepingTask(t.db, org.admin, {
      propertyId: h.property.id,
      unitId: unit.id,
      kind: 'departure',
    });
    const inspect = await createHousekeepingTask(t.db, org.admin, {
      propertyId: h.property.id,
      unitId: unit.id,
      kind: 'inspection',
    });
    expect(
      (
        await errorOf(
          createHousekeepingTask(t.db, org.admin, {
            propertyId: h.property.id,
            unitId: unit.id,
            kind: 'departure',
          }),
        )
      ).message,
    ).toMatch(/already has that task/);

    expect(
      (await errorOf(updateHousekeepingTask(t.db, org.admin, inspect.id, { status: 'done' })))
        .message,
    ).toMatch(/has not been cleaned/);
    const started = await updateHousekeepingTask(t.db, org.admin, clean.id, {
      status: 'in_progress',
      assignedTo: org.adminUserId,
    });
    expect(started.startedAt).not.toBeNull();
    const done = await updateHousekeepingTask(t.db, org.admin, clean.id, { status: 'done' });
    expect(done).toMatchObject({ status: 'done', completedBy: org.adminUserId });
    expect(
      (await t.db.select().from(units).where(eq(units.id, unit.id)))[0]!.housekeepingStatus,
    ).toBe('clean');
    await updateHousekeepingTask(t.db, org.admin, inspect.id, { status: 'done' });
    expect(
      (await t.db.select().from(units).where(eq(units.id, unit.id)))[0]!.housekeepingStatus,
    ).toBe('inspected');

    const board = await housekeepingBoard(t.db, org.orgId, h.property.id);
    expect(board.units.find((u) => u.unitId === unit.id)).toMatchObject({
      status: 'inspected',
      occupancy: 'vacant',
    });
    expect(board.counts).toMatchObject({ tasksOpen: 0, tasksDone: 2 });
  });

  it('flags the room a guest leaves and another arrives into the same day', async () => {
    const h = await hotel({ standardRooms: 1 });
    const out = await book(h, 0, 1, { guest: 'Out' });
    await checkIn(t.db, org.admin, out.id);
    await book(h, 1, 2, { guest: 'In' });
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    const board = await housekeepingBoard(t.db, org.orgId, h.property.id);
    const room = board.units.find((u) => u.unitId === h.standard.units[0]!.id)!;
    expect(room).toMatchObject({ occupancy: 'turnover' });
    expect(room.tasks).toMatchObject([{ kind: 'departure', priority: 'high' }]);
  });
});

describe('maintenance', () => {
  it('takes a room off sale while it is being fixed, and puts it back when it is done', async () => {
    const h = await hotel({ standardRooms: 2 });
    const std = h.standard.roomType.id;
    const unit = h.standard.units[0]!;
    await t.db.delete(outbox);
    const issue = await reportIssue(t.db, org.admin, {
      propertyId: h.property.id,
      unitId: unit.id,
      title: 'No hot water',
      priority: 'high',
      offSale: { from: day(0), to: day(3) },
    });
    expect(issue.blockId).not.toBeNull();
    expect(await available(h, std, day(0))).toBe(1);
    expect(await available(h, std, day(2))).toBe(1);
    expect(await available(h, std, day(3))).toBe(2);
    // The closure is queued for the channels like any other change.
    const events = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    expect(events.some((e) => e.payload.roomTypeId === std)).toBe(true);
    expect(
      (await t.db.select().from(units).where(eq(units.id, unit.id)))[0]!.housekeepingStatus,
    ).toBe('out_of_service');

    const [listed] = await listIssues(t.db, org.orgId, { propertyIds: [h.property.id] });
    expect(listed).toMatchObject({
      title: 'No hot water',
      unitName: unit.name,
      offSale: { from: day(0), to: day(3) },
    });

    // Parts are late: the closure is extended.
    await updateIssue(t.db, org.admin, issue.id, {
      status: 'in_progress',
      offSale: { from: day(0), to: day(5) },
    });
    expect(await available(h, std, day(4))).toBe(1);

    const resolved = await updateIssue(t.db, org.admin, issue.id, {
      status: 'resolved',
      resolution: 'Replaced the geyser',
    });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(await available(h, std, day(0))).toBe(2);
    expect(await available(h, std, day(4))).toBe(2);
    // Back in service, but it needs a clean before a guest goes in.
    expect(
      (await t.db.select().from(units).where(eq(units.id, unit.id)))[0]!.housekeepingStatus,
    ).toBe('dirty');
    expect(await listIssues(t.db, org.orgId, { propertyIds: [h.property.id] })).toEqual([]);
    expect(
      await listIssues(t.db, org.orgId, { propertyIds: [h.property.id], status: 'done' }),
    ).toHaveLength(1);
  });

  it('moves a hotel guest to another room when theirs is closed, but will not close a booked villa', async () => {
    const h = await hotel({ standardRooms: 2 });
    const r = await book(h, 1, 3);
    const unitId = r.rooms[0]!.unitId!;
    await reportIssue(t.db, org.admin, {
      propertyId: h.property.id,
      unitId,
      title: 'Leak in the ceiling',
      offSale: { from: day(0), to: day(4) },
    });
    const moved = await loadReservation(t.db, org.orgId, r.id);
    expect(moved.rooms[0]!.unitId).not.toBeNull();
    expect(moved.rooms[0]!.unitId).not.toBe(unitId);

    const villa = await createTestVilla(t.db, org);
    await createReservation(t.db, org.admin, {
      propertyId: villa.property.id,
      source: 'direct',
      guest: { firstName: 'Villa', lastName: 'Guest' },
      rooms: [
        { roomTypeId: villa.whole.roomType.id, checkIn: day(1), checkOut: day(3), adults: 4 },
      ],
    });
    const refused = await errorOf(
      reportIssue(t.db, org.admin, {
        propertyId: villa.property.id,
        unitId: villa.whole.units[0]!.id,
        title: 'Pool pump failed',
        offSale: { from: day(0), to: day(4) },
      }),
    );
    expect(refused.code).toBe('unit_occupied');
    // Nothing was recorded: not the issue, not the closure.
    expect(await listIssues(t.db, org.orgId, { propertyIds: [villa.property.id] })).toEqual([]);

    // An issue that is not about a room needs no closure.
    const general = await reportIssue(t.db, org.admin, {
      propertyId: villa.property.id,
      title: 'Gate light is out',
    });
    expect(general).toMatchObject({ unitId: null, blockId: null, status: 'open' });
    expect(
      (
        await errorOf(
          reportIssue(t.db, org.admin, {
            propertyId: villa.property.id,
            title: 'x',
            offSale: { from: day(0), to: day(1) },
          }),
        )
      ).message,
    ).toMatch(/Choose the unit/);
  });
});

describe('room charges are posted once', () => {
  it('whether by the night audit, by check-out, or by both', async () => {
    const h = await hotel();
    const r = await book(h, 0, 2);
    await checkIn(t.db, org.admin, r.id);
    await runNightAudit(t.db, org.admin, h.property.id, at(0, 23));
    // Hotel day two: the guest leaves a day early, after the first night was already charged.
    const result = await checkOut(t.db, org.admin, r.id, { balance: 'leave_open' });
    expect(result.reservation.checkOut).toBe(day(1));
    const lines = await t.db
      .select()
      .from(folioLines)
      .where(and(eq(folioLines.reservationRoomId, r.rooms[0]!.id), eq(folioLines.kind, 'room')));
    expect(lines.map((l) => l.businessDate)).toEqual([today]);
    expect(result.balance).toBe(472_500);
    const [room] = await t.db
      .select()
      .from(reservationRooms)
      .where(eq(reservationRooms.id, r.rooms[0]!.id));
    expect(room!.status).toBe('checked_out');
  });
});
