import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, properties } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { addDays, todayIn } from './dates';
import { listFolios, postCharge } from './folios';
import { checkIn } from './frontdesk';
import { guestToken } from './guest-links';
import { updateGuest } from './guests';
import { issueCreditNote, issueInvoice } from './invoices';
import { submitGuestCheckin, verifyOnlineCheckin } from './online-checkin';
import { guestRegister, guestRegisterCsv, taxRegister, taxRegisterCsv } from './registers';
import { createReservation } from './reservations';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;

const today = todayIn('Asia/Kolkata');
const day = (offset: number) => addDays(today, offset);

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 6, deluxeRooms: 2 });
  await t.db
    .update(properties)
    .set({
      businessDate: today,
      legalName: 'Sea Breeze Hospitality Pvt Ltd',
      gstin: '30AAACS1234A1Z5',
      stateCode: '30',
      state: 'Goa',
    })
    .where(eq(properties.id, hotel.property.id));
});
afterAll(async () => {
  await t.drop();
});

let seq = 0;
const arrive = async (guest: { firstName: string; lastName?: string }, nights = 2) => {
  const reservation = await createReservation(t.db, org.admin, {
    propertyId: hotel.property.id,
    source: 'direct',
    guest: {
      firstName: guest.firstName,
      lastName: guest.lastName ?? `Guest${++seq}`,
      email: `register${++seq}@example.com`,
    },
    rooms: [
      {
        roomTypeId: hotel.standard.roomType.id,
        ratePlanId: hotel.standard.ratePlan.id,
        checkIn: day(0),
        checkOut: day(nights),
        adults: 2,
      },
    ],
  });
  return reservation;
};

describe('the tax register', () => {
  it('lists what was invoiced by service code and rate, with credit notes taken off', async () => {
    const stay = await arrive({ firstName: 'Anita', lastName: 'Desai' });
    await checkIn(t.db, org.admin, stay.id);
    // A suite night at 18% and a dinner at 5%, billed to a company registered in another state.
    await postCharge(t.db, org.admin, {
      reservationId: stay.id,
      kind: 'room',
      description: 'Suite night',
      unitAmount: 800_000,
    });
    await postCharge(t.db, org.admin, {
      reservationId: stay.id,
      kind: 'food',
      description: 'Dinner',
      unitAmount: 100_000,
    });
    const [folio] = await listFolios(t.db, org.orgId, stay.id);
    const invoice = await issueInvoice(t.db, org.admin, folio!.id, {
      billTo: {
        name: 'Acme Corp',
        gstin: '27AAACA1234A1Z5',
        stateCode: '27',
        state: 'Maharashtra',
      },
    });
    // The dinner is taken off again.
    const credit = await issueCreditNote(t.db, org.admin, invoice.id, {
      reason: 'Dinner was not served',
      lines: [{ index: 1 }],
    });
    // And a walk-in pays for an ordinary room night, at 5%, without a tax number.
    const walkIn = await arrive({ firstName: 'Ravi', lastName: 'Menon' });
    await postCharge(t.db, org.admin, {
      reservationId: walkIn.id,
      kind: 'room',
      description: 'Room night',
      unitAmount: 450_000,
    });
    const [walkInFolio] = await listFolios(t.db, org.orgId, walkIn.id);
    const plain = await issueInvoice(t.db, org.admin, walkInFolio!.id);

    const register = await taxRegister(t.db, org.orgId, {
      propertyIds: [hotel.property.id],
      from: invoice.issuedOn,
      to: addDays(invoice.issuedOn, 1),
    });
    expect(register.currency).toBe('INR');
    expect(register.components).toEqual(['CGST', 'SGST']);
    expect(register.rows.map((r) => [r.number, r.serviceCode, r.rateBp, r.taxable])).toEqual(
      expect.arrayContaining([
        [invoice.number, '996311', 1800, 800_000],
        [invoice.number, '996331', 500, 100_000],
        [credit.number, '996331', 500, -100_000],
        [plain.number, '996311', 500, 450_000],
      ]),
    );
    expect(register.rows).toHaveLength(4);
    const room = register.rows.find((r) => r.number === invoice.number && r.rateBp === 1800)!;
    expect(room).toMatchObject({
      type: 'invoice',
      sellerGstin: '30AAACS1234A1Z5',
      // Accommodation is taxed where the property is, whoever is billed.
      placeOfSupply: '30',
      buyerName: 'Acme Corp',
      buyerGstin: '27AAACA1234A1Z5',
      buyerState: '27',
      taxes: { CGST: 72_000, SGST: 72_000 },
      taxTotal: 144_000,
      total: 944_000,
      reservationCode: stay.code,
    });
    expect(register.rows.find((r) => r.number === credit.number)).toMatchObject({
      type: 'credit_note',
      againstNumber: invoice.number,
      taxes: { CGST: -2_500, SGST: -2_500 },
      total: -105_000,
    });

    // The dinner and its credit cancel out; what is left is the two room nights.
    expect(register.total).toEqual({
      taxable: 1_250_000,
      taxes: { CGST: 83_250, SGST: 83_250 },
      taxTotal: 166_500,
      total: 1_416_500,
      invoices: 2,
      creditNotes: 1,
    });
    expect(register.summary.map((s) => [s.rateBp, s.registered, s.taxable, s.taxTotal])).toEqual([
      [500, true, 0, 0],
      [500, false, 450_000, 22_500],
      [1800, true, 800_000, 144_000],
    ]);

    const { filename, csv } = taxRegisterCsv(register);
    expect(filename).toBe(`tax-register-${invoice.issuedOn}-to-${invoice.issuedOn}.csv`);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Property,Document,Number,Date,Against invoice,Seller GSTIN,Place of supply,Customer,Customer GSTIN,Customer state,Service code (SAC),Tax rate %,Taxable value,CGST,SGST,Tax,Total,Booking',
    );
    expect(lines).toHaveLength(6);
    expect(lines.find((l) => l.includes(credit.number))).toContain(
      `Credit note,${credit.number},${invoice.issuedOn},${invoice.number},`,
    );
    expect(lines.find((l) => l.includes(credit.number))).toContain(
      ',5,-1000.00,-25.00,-25.00,-50.00,-1050.00,',
    );
    expect(lines.at(-1)).toBe('Total,,,,,,,,,,,,12500.00,832.50,832.50,1665.00,14165.00,');
  });

  it('is empty outside the period and for no properties, and refuses a period that is too long', async () => {
    const outside = await taxRegister(t.db, org.orgId, {
      propertyIds: 'all',
      from: day(40),
      to: day(41),
    });
    expect(outside).toMatchObject({ rows: [], currency: null, components: [] });
    expect(outside.total).toMatchObject({ total: 0, invoices: 0 });
    expect(
      (await taxRegister(t.db, org.orgId, { propertyIds: [], from: day(-5), to: day(5) })).rows,
    ).toEqual([]);
    // Another organisation sees nothing of this one.
    const rival = await createTestOrg(t.db, 'Rival');
    expect(
      (await taxRegister(t.db, rival.orgId, { propertyIds: 'all', from: day(-5), to: day(5) }))
        .rows,
    ).toEqual([]);
    await expect(
      taxRegister(t.db, org.orgId, { propertyIds: 'all', from: day(0), to: day(900) }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      taxRegister(t.db, org.orgId, { propertyIds: 'all', from: day(2), to: day(2) }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('the guest register', () => {
  it('lists everyone who arrived with the details on file, and records that it was taken', async () => {
    // A couple from Germany who checked in online, with what the foreigners' register asks for.
    const abroad = await arrive({ firstName: 'Lukas', lastName: 'Becker' });
    await submitGuestCheckin(t.db, guestToken(abroad), {
      arrivalTime: '15:00',
      guests: [
        {
          name: 'Lukas Becker',
          nationality: 'de',
          dateOfBirth: '1988-04-02',
          idType: 'passport',
          idNumber: 'C01X00T47',
          idExpiry: '2031-05-01',
          address: 'Lindenstr. 4, Berlin',
          visaNumber: 'VJ1234567',
          visaExpiry: addDays(today, 60),
          arrivedInCountryOn: addDays(today, -3),
          arrivingFrom: 'Mumbai',
          nextDestination: 'Hampi',
        },
        { name: 'Jana Becker', nationality: 'DE', idType: 'passport', idNumber: 'C02Y11U58' },
      ],
      signatureName: 'Lukas Becker',
      acceptTerms: true,
    });
    await verifyOnlineCheckin(t.db, org.admin, abroad.id);
    await checkIn(t.db, org.admin, abroad.id);

    // A guest from India whose identity card was noted on their profile at the desk.
    const local = await arrive({ firstName: 'Meera', lastName: 'Pillai' });
    await updateGuest(t.db, org.admin, local.guestId!, {
      nationality: 'IN',
      idType: 'aadhaar',
      idNumber: '4991 1866 5246',
      addressLine1: '12 MG Road',
      city: 'Kochi',
      state: 'Kerala',
    });
    await checkIn(t.db, org.admin, local.id);

    // Someone who checked in with nothing on file, and someone who has not arrived at all.
    const bare = await arrive({ firstName: 'Tom', lastName: 'Unknown' });
    await checkIn(t.db, org.admin, bare.id);
    const expected = await arrive({ firstName: 'Not', lastName: 'Arrived' });

    const register = await guestRegister(t.db, org.admin, {
      propertyId: hotel.property.id,
      from: day(0),
      to: day(1),
    });
    const names = register.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['Lukas Becker', 'Jana Becker', 'Meera Pillai', 'Tom Unknown']),
    );
    expect(names).not.toContain('Not Arrived');
    expect(register.rows.some((r) => r.reservationCode === expected.code)).toBe(false);

    expect(register.rows.find((r) => r.name === 'Lukas Becker')).toMatchObject({
      reservationCode: abroad.code,
      arrival: day(0),
      departure: day(2),
      nationality: 'DE',
      foreign: true,
      dateOfBirth: '1988-04-02',
      idType: 'passport',
      idNumber: 'C01X00T47',
      visaNumber: 'VJ1234567',
      arrivingFrom: 'Mumbai',
      nextDestination: 'Hampi',
      verified: true,
    });
    expect(register.rows.find((r) => r.name === 'Lukas Becker')!.arrivedAt).toBeInstanceOf(Date);
    expect(register.rows.find((r) => r.name === 'Lukas Becker')!.rooms).toMatch(/^STD-\d+$/);
    expect(register.rows.find((r) => r.name === 'Meera Pillai')).toMatchObject({
      nationality: 'IN',
      foreign: false,
      idType: 'aadhaar',
      idNumber: '4991 1866 5246',
      address: '12 MG Road, Kochi, Kerala',
      verified: false,
    });
    expect(register.rows.find((r) => r.name === 'Tom Unknown')).toMatchObject({
      idNumber: null,
      nationality: null,
      foreign: false,
    });
    // Stays with nothing to show the authorities are counted, so someone can chase them.
    expect(register.withoutDetails).toBeGreaterThanOrEqual(1);

    const foreignOnly = await guestRegister(t.db, org.admin, {
      propertyId: hotel.property.id,
      from: day(0),
      to: day(1),
      foreignOnly: true,
    });
    expect(foreignOnly.rows.map((r) => r.name).sort()).toEqual(['Jana Becker', 'Lukas Becker']);

    const { filename, csv } = guestRegisterCsv(foreignOnly);
    expect(filename).toBe(`guest-register-${day(0)}-to-${day(0)}.csv`);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Guest,Nationality,From abroad,Date of birth,Address');
    expect(lines.find((l) => l.includes('Lukas Becker'))).toContain(
      'Lukas Becker,DE,Yes,1988-04-02,"Lindenstr. 4, Berlin",Passport,C01X00T47,2031-05-01,VJ1234567,',
    );

    // Identity numbers left the system in the clear: both exports are on record.
    const taken = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'guest_register.exported'),
          eq(auditLog.entityId, hotel.property.id),
        ),
      );
    expect(taken).toHaveLength(2);
    expect(taken.map((a) => a.summary).join(' ')).toContain('register of foreign guests');
    expect(JSON.stringify(taken)).not.toContain('C01X00T47');
  });

  it('is about one property of the organisation, for a year at most', async () => {
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      guestRegister(t.db, rival.admin, { propertyId: hotel.property.id, from: day(0), to: day(1) }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      guestRegister(t.db, org.admin, { propertyId: hotel.property.id, from: day(0), to: day(400) }),
    ).rejects.toMatchObject({ code: 'validation' });
    const quiet = await guestRegister(t.db, org.admin, {
      propertyId: hotel.property.id,
      from: day(100),
      to: day(101),
    });
    expect(quiet).toMatchObject({ rows: [], withoutDetails: 0 });
  });
});
