import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alerts, inventoryBlocks, outbox, ownerContracts, ownerExpenses } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createBlock, releaseBlock } from './blocks';
import type { Actor } from './context';
import { addDays, diffDays, monthOf, todayIn } from './dates';
import { getAvailability } from './inventory';
import {
  addOwnerExpense,
  cancelOwnerStay,
  createContract,
  createOwner,
  draftDueOwnerStatements,
  draftOwnerStatement,
  getOwner,
  getOwnerStatement,
  issueOwnerStatement,
  listOwnerStatements,
  markOwnerStatementPaid,
  ownerCalendar,
  ownerOverview,
  ownerStatementCsv,
  ownerStatementFor,
  ownerStatementsFor,
  removeOwnerExpense,
  requestOwnerStay,
  updateContract,
  updateOwner,
  updateOwnerStatement,
  type OwnerContractRow,
  type OwnerRow,
} from './owners';
import { cancelReservation, createReservation } from './reservations';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  createTestVilla,
  type TestOrg,
  type TestVilla,
} from './testing';

let t: TestDatabase;
let org: TestOrg;
let villa: TestVilla;
let owner: OwnerRow;
let contract: OwnerContractRow;
let ownerActor: Actor;

const today = todayIn('Asia/Kolkata');
const thisMonth = monthOf(today).start;
const lastMonth = monthOf(addDays(thisMonth, -1)).start;
const lastMonthName = lastMonth.slice(0, 7);
/** A date in last month, counted from its first day. */
const lm = (n: number) => addDays(lastMonth, n);
/** A year far enough ahead that notice and the turn of the year do not get in the way. */
const nextYear = Number(today.slice(0, 4)) + 1;

/** A stay that has taken place: booked for dates in the past and marked as departed. */
async function stayed(
  from: string,
  to: string,
  extra: Partial<Parameters<typeof createReservation>[2]> & { bedroom?: boolean } = {},
) {
  const { bedroom, ...rest } = extra;
  const type = bedroom ? villa.bedrooms! : villa.whole;
  const reservation = await createReservation(t.db, org.admin, {
    propertyId: villa.property.id,
    source: 'phone',
    guest: { firstName: 'Private', lastName: 'Person' },
    rooms: [
      {
        roomTypeId: type.roomType.id,
        ratePlanId: type.ratePlan.id,
        checkIn: from,
        checkOut: to,
        adults: 2,
      },
    ],
    ...rest,
  });
  await t.db.execute(
    `UPDATE reservation_rooms SET status = 'checked_out' WHERE reservation_id = '${reservation.id}';
     UPDATE reservations SET status = 'checked_out' WHERE id = '${reservation.id}'`,
  );
  return reservation;
}

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  // A villa at 25,000 a night that is also sold by the bedroom at 9,000.
  villa = await createTestVilla(t.db, org, { bedrooms: 2 });
  owner = await createOwner(t.db, org.admin, {
    name: 'Rohini Desai',
    email: 'Rohini@Example.com',
    gstin: '30aaacd1234e1z5',
  });
  contract = await createContract(t.db, org.admin, {
    ownerId: owner.id,
    propertyId: villa.property.id,
    unitId: villa.whole.units[0]!.id,
    startsOn: addDays(lastMonth, -60),
    managementFeeBp: 2_000,
    ownerNightsPerYear: 10,
    ownerStayNoticeDays: 7,
  });
  const user = await createTestUser(t.db, org.orgId, {
    role: 'villa_owner',
    propertyId: villa.property.id,
  });
  ownerActor = user.actor;
  await updateOwner(t.db, org.admin, owner.id, { userId: user.id });

  // Last month: the whole villa for three nights from Booking.com, a bedroom for two nights
  // by phone, a booking that was cancelled, and a stay from Airbnb that ran into this month.
  await stayed(lm(2), lm(5), { source: 'ota', channelCode: 'BDC', commissionAmount: 1_125_000 });
  await stayed(lm(8), lm(10), { bedroom: true });
  const cancelled = await createReservation(t.db, org.admin, {
    propertyId: villa.property.id,
    source: 'phone',
    guest: { firstName: 'Never', lastName: 'Came' },
    rooms: [
      {
        roomTypeId: villa.whole.roomType.id,
        ratePlanId: villa.whole.ratePlan.id,
        checkIn: lm(12),
        checkOut: lm(14),
        adults: 2,
      },
    ],
  });
  await cancelReservation(t.db, org.admin, cancelled.id);
  await stayed(addDays(thisMonth, -2), addDays(thisMonth, 1), {
    source: 'ota',
    channelCode: 'ABB',
    commissionAmount: 750_000,
  });
});
afterAll(async () => {
  await t.drop();
});

describe('owners and their contracts', () => {
  it('keeps an owner\u2019s details tidy and shows their contracts', async () => {
    const view = await getOwner(t.db, org.orgId, owner.id);
    expect(view).toMatchObject({
      name: 'Rohini Desai',
      email: 'rohini@example.com',
      gstin: '30AAACD1234E1Z5',
      user: { id: ownerActor.userId },
    });
    expect(view.contracts).toMatchObject([
      {
        id: contract.id,
        propertyName: villa.property.name,
        unitName: 'Villa',
        model: 'revenue_share',
        managementFeeBp: 2_000,
        feeBasis: 'net',
        feeTaxBp: 1_800,
        commissionOnOwner: true,
        fixedRent: null,
      },
    ]);
    await expect(createOwner(t.db, org.admin, { name: '  ' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(updateOwner(t.db, org.admin, owner.id, { gstin: 'not-a-gstin' })).rejects.toThrow(
      /GSTIN/,
    );
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(getOwner(t.db, rival.orgId, owner.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('links a portal sign-in only when it holds the villa owner role, and to one owner only', async () => {
    const frontDesk = await createTestUser(t.db, org.orgId, { role: 'front_desk' });
    await expect(updateOwner(t.db, org.admin, owner.id, { userId: frontDesk.id })).rejects.toThrow(
      /villa owner role/,
    );
    const second = await createOwner(t.db, org.admin, { name: 'Second Owner' });
    await expect(
      updateOwner(t.db, org.admin, second.id, { userId: ownerActor.userId }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      updateOwner(t.db, org.admin, second.id, { userId: rival.adminUserId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets a unit be under one contract at a time', async () => {
    const other = await createOwner(t.db, org.admin, { name: 'Another Owner' });
    const base = { ownerId: other.id, propertyId: villa.property.id, startsOn: today };
    // The same villa, one of its bedrooms, and the whole property all collide with the villa's contract.
    for (const unitId of [villa.whole.units[0]!.id, villa.bedrooms!.units[0]!.id, null]) {
      await expect(createContract(t.db, org.admin, { ...base, unitId })).rejects.toMatchObject({
        code: 'conflict',
      });
    }
    // The database refuses it too, should anything get past the check.
    await expect(
      t.db.insert(ownerContracts).values({
        orgId: org.orgId,
        ownerId: other.id,
        propertyId: villa.property.id,
        unitId: villa.whole.units[0]!.id,
        startsOn: today,
      }),
    ).rejects.toThrow();

    // Another property is free, and so is this one once the first contract has ended.
    const hotel = await createTestHotel(t.db, org);
    const elsewhere = await createContract(t.db, org.admin, {
      ...base,
      propertyId: hotel.property.id,
      model: 'fixed_rent',
      fixedRent: 3_000_000,
    });
    expect(elsewhere).toMatchObject({ unitId: null, model: 'fixed_rent', fixedRent: 3_000_000 });
    await expect(
      updateContract(t.db, org.admin, elsewhere.id, { endsOn: addDays(today, -1) }),
    ).rejects.toThrow(/cannot end before it starts/);
    await expect(
      createContract(t.db, org.admin, { ...base, propertyId: hotel.property.id, unitId: null }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await updateContract(t.db, org.admin, elsewhere.id, { endsOn: addDays(today, 30) });
    const after = await createContract(t.db, org.admin, {
      ...base,
      propertyId: hotel.property.id,
      startsOn: addDays(today, 31),
    });
    await expect(
      updateContract(t.db, org.admin, after.id, { startsOn: addDays(today, 30) }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('checks the terms', async () => {
    const base = {
      ownerId: owner.id,
      propertyId: villa.property.id,
      unitId: villa.bedrooms!.units[1]!.id,
      startsOn: today,
    };
    await expect(
      createContract(t.db, org.admin, { ...base, managementFeeBp: 12_000 }),
    ).rejects.toThrow(/between 0% and 100%/);
    await expect(createContract(t.db, org.admin, { ...base, model: 'fixed_rent' })).rejects.toThrow(
      /needs the rent/,
    );
    await expect(createContract(t.db, org.admin, { ...base, fixedRent: 100 })).rejects.toThrow(
      /Only a fixed-rent contract/,
    );
    await expect(
      createContract(t.db, org.admin, { ...base, unitId: org.adminUserId }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the monthly statement', () => {
  it('pays the owner for the nights guests stayed, less commission, fee, tax and costs', async () => {
    const expense = await addOwnerExpense(t.db, org.admin, {
      contractId: contract.id,
      date: lm(6),
      category: 'maintenance',
      description: 'Pool pump repair',
      amount: 300_000,
    });
    const draft = await draftOwnerStatement(t.db, org.admin, contract.id, lastMonthName);
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      ownerId: owner.id,
      propertyId: villa.property.id,
      periodStart: lastMonth,
      periodEnd: thisMonth,
      currency: 'INR',
      roomNights: 7,
      // 75,000 for the villa, 18,000 for the bedroom, and two of the three Airbnb nights.
      grossRevenue: 14_300_000,
      // Booking.com's 11,250 and two thirds of Airbnb's 7,500.
      channelCommission: 1_625_000,
      // A fifth of what is left after commission, and 18% tax on that fee.
      managementFee: 2_535_000,
      feeTax: 456_300,
      expenses: 300_000,
      adjustments: 0,
      payout: 9_383_700,
    });
    expect(draft.lines.stays).toMatchObject([
      { source: 'BDC', unitName: 'Villa', nights: 3, revenue: 7_500_000, commission: 1_125_000 },
      { source: 'phone', unitName: 'Bedroom 1', nights: 2, revenue: 1_800_000, commission: 0 },
      { source: 'ABB', unitName: 'Villa', nights: 2, revenue: 5_000_000, commission: 500_000 },
    ]);
    // The owner sees which bookings, never who the guests were.
    expect(JSON.stringify(draft.lines)).not.toMatch(/Private|Person|Never/);
    expect(draft.lines.expenses).toEqual([
      {
        id: expense.id,
        date: lm(6),
        category: 'maintenance',
        description: 'Pool pump repair',
        amount: 300_000,
      },
    ]);

    // Working it out again changes nothing; a correction is kept when it is.
    const adjusted = await updateOwnerStatement(t.db, org.admin, draft.id, {
      adjustments: [{ description: 'Goodwill for the pump outage', amount: 50_000 }],
      notes: 'Pump replaced on the 7th.',
    });
    expect(adjusted).toMatchObject({ adjustments: 50_000, payout: 9_433_700 });
    const again = await draftOwnerStatement(t.db, org.admin, contract.id, lastMonthName);
    expect(again).toMatchObject({
      id: draft.id,
      adjustments: 50_000,
      payout: 9_433_700,
      notes: 'Pump replaced on the 7th.',
    });
    await expect(
      updateOwnerStatement(t.db, org.admin, draft.id, {
        adjustments: [{ description: '', amount: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(draftOwnerStatement(t.db, org.admin, contract.id, '2026-13')).rejects.toThrow(
      /YYYY-MM/,
    );
  });

  it('is fixed once issued, and only a month that has ended can be issued', async () => {
    const current = await draftOwnerStatement(t.db, org.admin, contract.id, thisMonth.slice(0, 7));
    // The last night of the Airbnb stay fell in this month.
    expect(current).toMatchObject({ roomNights: 1, grossRevenue: 2_500_000 });
    expect(current.channelCommission).toBe(250_000);
    await expect(issueOwnerStatement(t.db, org.admin, current.id)).rejects.toThrow(
      /is not over yet/,
    );

    const [draft] = await listOwnerStatements(t.db, org.orgId, {
      contractId: contract.id,
      status: 'draft',
    }).then((list) => list.filter((s) => s.periodStart === lastMonth));
    const issued = await issueOwnerStatement(t.db, org.admin, draft!.id);
    expect(issued).toMatchObject({
      status: 'issued',
      number: `${villa.property.code}/OS/${lastMonthName}/01`,
      payout: 9_433_700,
      issuedBy: org.adminUserId,
    });
    expect(issued.issuedAt).toBeInstanceOf(Date);

    // Nothing about that month can change any more.
    const [cost] = await t.db
      .select()
      .from(ownerExpenses)
      .where(eq(ownerExpenses.contractId, contract.id));
    expect(cost!.statementId).toBe(issued.id);
    await expect(removeOwnerExpense(t.db, org.admin, cost!.id)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await expect(
      addOwnerExpense(t.db, org.admin, {
        contractId: contract.id,
        date: lm(20),
        description: 'Late invoice',
        amount: 10_000,
      }),
    ).rejects.toThrow(/already been issued/);
    await expect(
      draftOwnerStatement(t.db, org.admin, contract.id, lastMonthName),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(
      updateOwnerStatement(t.db, org.admin, issued.id, { notes: 'Changed my mind' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(issueOwnerStatement(t.db, org.admin, issued.id)).rejects.toMatchObject({
      code: 'invalid_state',
    });
    // The contract cannot be cut short to before a month already accounted for.
    await expect(
      updateContract(t.db, org.admin, contract.id, { endsOn: addDays(lastMonth, -1) }),
    ).rejects.toThrow(/statement has been issued/);

    // A cost that turns up later goes on the next statement.
    const late = await addOwnerExpense(t.db, org.admin, {
      contractId: contract.id,
      date: thisMonth,
      description: 'Late invoice for the pump',
      amount: 10_000,
    });
    const next = await draftOwnerStatement(t.db, org.admin, contract.id, thisMonth.slice(0, 7));
    expect(next.expenses).toBe(10_000);
    await removeOwnerExpense(t.db, org.admin, late.id);

    await expect(markOwnerStatementPaid(t.db, org.admin, current.id)).rejects.toThrow(
      /Issue the statement/,
    );
    const paid = await markOwnerStatementPaid(t.db, org.admin, issued.id, {
      reference: 'NEFT 4417',
      paidAt: new Date(`${thisMonth}T12:00:00Z`),
    });
    expect(paid).toMatchObject({ status: 'paid', paymentReference: 'NEFT 4417' });
    expect(paid.paidAt).toEqual(new Date(`${thisMonth}T12:00:00Z`));

    // The terms change afterwards. The issued statement still says what it was worked out
    // on; a draft follows the contract as it now stands.
    const before = await getOwnerStatement(t.db, org.orgId, issued.id);
    expect(before).toMatchObject({
      model: 'revenue_share',
      managementFeeBp: 2_000,
      commissionOnOwner: true,
      fixedRent: null,
    });
    await updateContract(t.db, org.admin, contract.id, { managementFeeBp: 2_500 });
    expect(await getOwnerStatement(t.db, org.orgId, issued.id)).toMatchObject({
      managementFeeBp: 2_000,
      payout: 9_433_700,
    });
    const redone = await draftOwnerStatement(t.db, org.admin, contract.id, thisMonth.slice(0, 7));
    expect(await getOwnerStatement(t.db, org.orgId, redone.id)).toMatchObject({
      managementFeeBp: 2_500,
    });
    await updateContract(t.db, org.admin, contract.id, { managementFeeBp: 2_000 });
    await draftOwnerStatement(t.db, org.admin, contract.id, thisMonth.slice(0, 7));
    // Statements can be asked for by month and by property.
    expect(
      (await listOwnerStatements(t.db, org.orgId, { month: lastMonthName })).map((x) => x.id),
    ).toEqual([issued.id]);
    expect(
      await listOwnerStatements(t.db, org.orgId, {
        month: lastMonthName,
        propertyId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toEqual([]);
  });

  it('counts the nights a guest in house has stayed, not the ones still to come', async () => {
    const place = await createTestVilla(t.db, org);
    const landlord = await createOwner(t.db, org.admin, { name: 'Halfway Owner' });
    const terms = await createContract(t.db, org.admin, {
      ownerId: landlord.id,
      propertyId: place.property.id,
      unitId: place.whole.units[0]!.id,
      startsOn: addDays(today, -90),
      managementFeeBp: 0,
    });
    // Arrived yesterday, leaving in three days.
    const stay = await createReservation(t.db, org.admin, {
      propertyId: place.property.id,
      source: 'phone',
      guest: { firstName: 'Still', lastName: 'Here' },
      rooms: [
        {
          roomTypeId: place.whole.roomType.id,
          ratePlanId: place.whole.ratePlan.id,
          checkIn: addDays(today, -1),
          checkOut: addDays(today, 3),
          adults: 2,
        },
      ],
    });
    await t.db.execute(
      `UPDATE reservation_rooms SET status = 'in_house' WHERE reservation_id = '${stay.id}';
       UPDATE reservations SET status = 'in_house' WHERE id = '${stay.id}'`,
    );
    const month = monthOf(addDays(today, -1)).start.slice(0, 7);
    const draft = await draftOwnerStatement(t.db, org.admin, terms.id, month);
    expect(draft).toMatchObject({ roomNights: 1, grossRevenue: 2_500_000 });
    expect(draft.lines.stays).toMatchObject([{ nights: 1, revenue: 2_500_000 }]);
  });

  it('reads as a spreadsheet', async () => {
    const [statement] = await listOwnerStatements(t.db, org.orgId, { status: 'paid' });
    const csv = ownerStatementCsv(await getOwnerStatement(t.db, org.orgId, statement!.id));
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(`Owner statement,${villa.property.code}/OS/${lastMonthName}/01`);
    expect(lines).toContain('Owner,Rohini Desai');
    expect(lines).toContain(`Property,"${villa.property.name}, Villa"`);
    expect(lines).toContain('Room revenue,143000.00');
    expect(lines).toContain('Commission,-16250.00');
    expect(lines).toContain('Management fee,-25350.00');
    expect(lines).toContain('Tax on management fee,-4563.00');
    expect(lines).toContain('Payable to owner,94337.00');
    expect(lines).toContain(`Pool pump repair,${lm(6)},maintenance,3000.00`);
  });

  it('pays an agreed rent for the part of the month a fixed-rent contract covers', async () => {
    const hotel = await createTestHotel(t.db, org);
    const landlord = await createOwner(t.db, org.admin, { name: 'Fixed Rent Owner' });
    const start = lm(14);
    const rented = await createContract(t.db, org.admin, {
      ownerId: landlord.id,
      propertyId: hotel.property.id,
      startsOn: start,
      model: 'fixed_rent',
      fixedRent: 3_000_000,
    });
    const statement = await draftOwnerStatement(t.db, org.admin, rented.id, lastMonthName);
    const covered = diffDays(start, thisMonth);
    const days = diffDays(lastMonth, thisMonth);
    expect(statement).toMatchObject({
      managementFee: 0,
      feeTax: 0,
      channelCommission: 0,
      payout: Math.round((3_000_000 * covered) / days),
    });
    await expect(
      draftOwnerStatement(t.db, org.admin, rented.id, addDays(lastMonth, -1).slice(0, 7)),
    ).rejects.toThrow(/does not cover that month/);
  });

  it('is prepared by itself once a month has ended, and the accounts team is told once', async () => {
    const fresh = await createTestOrg(t.db, 'Fresh Villas');
    const place = await createTestVilla(t.db, fresh);
    const someone = await createOwner(t.db, fresh.admin, { name: 'New Owner' });
    await createContract(t.db, fresh.admin, {
      ownerId: someone.id,
      propertyId: place.property.id,
      startsOn: addDays(lastMonth, -10),
    });
    const before = (await listOwnerStatements(t.db, fresh.orgId)).length;
    expect(before).toBe(0);
    await draftDueOwnerStatements(t.db);
    const drafts = await listOwnerStatements(t.db, fresh.orgId);
    expect(drafts).toMatchObject([{ status: 'draft', periodStart: lastMonth, payout: 0 }]);
    const raised = await t.db.select().from(alerts).where(eq(alerts.orgId, fresh.orgId));
    expect(raised).toMatchObject([{ kind: 'owner_statements', severity: 'info', occurrences: 1 }]);
    expect(raised[0]!.title).toMatch(/^Owner statements for \w+ \d{4} are ready to check$/);

    // The next run finds nothing left to do.
    expect(await draftDueOwnerStatements(t.db)).toEqual({ drafted: 0 });
    expect(await t.db.select().from(alerts).where(eq(alerts.orgId, fresh.orgId))).toHaveLength(1);
  });
});

describe('the owner portal', () => {
  it('shows an owner their own units and statements, and nothing else', async () => {
    const overview = await ownerOverview(t.db, ownerActor);
    expect(overview.owner).toEqual({ id: owner.id, name: 'Rohini Desai' });
    expect(overview.contracts).toHaveLength(1);
    expect(overview.contracts[0]).toMatchObject({
      id: contract.id,
      propertyName: villa.property.name,
      ownerNightsUsed: 0,
      thisMonth: { nights: 1, revenue: 2_500_000 },
    });
    // What the office noted about the contract is not sent to the owner's browser.
    await updateContract(t.db, org.admin, contract.id, { notes: 'Wants the fee cut next year' });
    const seen = await ownerOverview(t.db, ownerActor);
    expect(seen.contracts[0]!.notes).toBeNull();
    expect(
      JSON.stringify([
        seen,
        await ownerCalendar(t.db, ownerActor, { from: today, to: addDays(today, 30) }),
      ]),
    ).not.toContain('fee cut');
    // Issued statements only: a draft is the office's working paper.
    expect(overview.statements.map((s) => s.status)).toEqual(['paid']);
    const mine = await ownerStatementsFor(t.db, ownerActor);
    expect(mine).toHaveLength(1);
    expect(await ownerStatementFor(t.db, ownerActor, mine[0]!.id)).toMatchObject({
      payout: 9_433_700,
    });
    const [draft] = await listOwnerStatements(t.db, org.orgId, { status: 'draft' });
    await expect(ownerStatementFor(t.db, ownerActor, draft!.id)).rejects.toMatchObject({
      code: 'not_found',
    });

    const calendar = await ownerCalendar(t.db, ownerActor, { from: lastMonth, to: thisMonth });
    expect(calendar.stays.map((s) => [s.source, s.unitName, s.nights, s.revenue])).toEqual([
      ['BDC', 'Villa', 3, 7_500_000],
      ['phone', 'Bedroom 1', 2, 1_800_000],
      ['ABB', 'Villa', 3, 7_500_000],
    ]);
    expect(JSON.stringify(calendar)).not.toMatch(/Private|Person/);

    // Someone else's sign-in, and a sign-in not linked to any owner, get nothing.
    const stranger = await createTestUser(t.db, org.orgId, { role: 'villa_owner' });
    await expect(ownerOverview(t.db, stranger.actor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      ownerCalendar(t.db, stranger.actor, { from: lastMonth, to: thisMonth }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const neighbour = await createOwner(t.db, org.admin, {
      name: 'Neighbour',
      userId: stranger.id,
    });
    expect(neighbour.userId).toBe(stranger.id);
    expect((await ownerOverview(t.db, stranger.actor)).contracts).toEqual([]);
    await expect(ownerStatementFor(t.db, stranger.actor, mine[0]!.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('lets an owner take free dates for themselves, within the contract', async () => {
    const stay = { contractId: contract.id, from: `${nextYear}-03-10`, to: `${nextYear}-03-14` };
    // Seven days' notice is agreed.
    await expect(
      requestOwnerStay(t.db, ownerActor, {
        contractId: contract.id,
        from: addDays(today, 3),
        to: addDays(today, 5),
      }),
    ).rejects.toThrow(/7 days\u2019 notice/);
    await t.db.delete(outbox);
    const block = await requestOwnerStay(t.db, ownerActor, stay);
    expect(block).toMatchObject({
      kind: 'owner_stay',
      unitId: villa.whole.units[0]!.id,
      startDate: stay.from,
      endDate: stay.to,
      ownerId: owner.id,
    });
    // The villa is closed for those nights, and the booking sites are told.
    const closed = await getAvailability(t.db, {
      propertyId: villa.property.id,
      range: { from: stay.from, to: stay.to },
      roomTypeIds: [villa.whole.roomType.id],
    });
    expect(closed.map((d) => d.available)).toEqual([0, 0, 0, 0]);
    const told = await t.db.select().from(outbox).where(eq(outbox.kind, 'ari.availability'));
    expect(told.length).toBeGreaterThan(0);

    // Ten nights a year are allowed: four are used, so seven more is one too many.
    await expect(
      requestOwnerStay(t.db, ownerActor, {
        contractId: contract.id,
        from: `${nextYear}-04-01`,
        to: `${nextYear}-04-08`,
      }),
    ).rejects.toThrow(new RegExp(`10 nights a year.*6 are left for ${nextYear}`));
    // Dates a guest has are not the owner's to take.
    await createReservation(t.db, org.admin, {
      propertyId: villa.property.id,
      source: 'phone',
      guest: { firstName: 'Paying', lastName: 'Guest' },
      rooms: [
        {
          roomTypeId: villa.whole.roomType.id,
          ratePlanId: villa.whole.ratePlan.id,
          checkIn: `${nextYear}-05-10`,
          checkOut: `${nextYear}-05-12`,
          adults: 2,
        },
      ],
    });
    await expect(
      requestOwnerStay(t.db, ownerActor, {
        contractId: contract.id,
        from: `${nextYear}-05-11`,
        to: `${nextYear}-05-13`,
      }),
    ).rejects.toMatchObject({
      code: 'unit_occupied',
      // When, but never who: no booking code and no guest.
      message: `Those dates are not free: the villa is taken from 10 May ${nextYear} to 12 May ${nextYear}.`,
    });

    // Dates the office enters for the owner count against the same allowance.
    const arranged = await createBlock(t.db, org.admin, {
      propertyId: villa.property.id,
      unitId: villa.whole.units[0]!.id,
      kind: 'owner_stay',
      startDate: `${nextYear}-06-01`,
      endDate: `${nextYear}-06-06`,
      reason: 'Owner visit, arranged by phone',
    });
    await expect(
      requestOwnerStay(t.db, ownerActor, {
        contractId: contract.id,
        from: `${nextYear}-07-01`,
        to: `${nextYear}-07-03`,
      }),
    ).rejects.toThrow(new RegExp(`10 nights a year.*1 is left for ${nextYear}`));
    await releaseBlock(t.db, org.admin, arranged.id);

    const calendar = await ownerCalendar(t.db, ownerActor, {
      from: `${nextYear}-03-01`,
      to: `${nextYear}-06-01`,
    });
    expect(calendar.blocks).toMatchObject([
      { id: block.id, kind: 'owner_stay', own: true, startDate: stay.from, endDate: stay.to },
    ]);
    expect(calendar.stays).toMatchObject([{ source: 'phone', status: 'confirmed', nights: 2 }]);
    expect((await ownerOverview(t.db, ownerActor)).contracts[0]!.ownerNightsUsed).toBe(
      nextYear === Number(today.slice(0, 4)) ? 4 : 0,
    );

    // Only the owner who took the dates can give them back.
    const stranger = await createTestUser(t.db, org.orgId, { role: 'villa_owner' });
    await createOwner(t.db, org.admin, { name: 'Other Owner', userId: stranger.id });
    await expect(cancelOwnerStay(t.db, stranger.actor, block.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await cancelOwnerStay(t.db, ownerActor, block.id);
    const [released] = await t.db
      .select()
      .from(inventoryBlocks)
      .where(and(eq(inventoryBlocks.id, block.id)));
    expect(released!.releasedAt).toBeInstanceOf(Date);
    // With the nights given back, the longer stay fits.
    const longer = await requestOwnerStay(t.db, ownerActor, {
      contractId: contract.id,
      from: `${nextYear}-04-01`,
      to: `${nextYear}-04-08`,
    });
    expect(longer.kind).toBe('owner_stay');
  });

  it('asks which unit when the contract is for a whole property', async () => {
    const hotel = await createTestHotel(t.db, org);
    const user = await createTestUser(t.db, org.orgId, {
      role: 'villa_owner',
      propertyId: hotel.property.id,
    });
    const landlord = await createOwner(t.db, org.admin, { name: 'Whole Hotel', userId: user.id });
    const whole = await createContract(t.db, org.admin, {
      ownerId: landlord.id,
      propertyId: hotel.property.id,
      startsOn: lastMonth,
    });
    const dates = { contractId: whole.id, from: `${nextYear}-03-10`, to: `${nextYear}-03-12` };
    await expect(requestOwnerStay(t.db, user.actor, dates)).rejects.toThrow(/Choose which unit/);
    await expect(
      requestOwnerStay(t.db, user.actor, { ...dates, unitId: villa.whole.units[0]!.id }),
    ).rejects.toThrow(/Choose which unit/);
    const block = await requestOwnerStay(t.db, user.actor, {
      ...dates,
      unitId: hotel.standard.units[0]!.id,
    });
    expect(block.unitId).toBe(hotel.standard.units[0]!.id);
    // Another owner's contract is not theirs to use.
    await expect(
      requestOwnerStay(t.db, user.actor, { ...dates, contractId: contract.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
