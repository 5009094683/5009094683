import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  auditLog,
  conversations,
  guests,
  onlineCheckins,
  pgErrorInfo,
  reservations,
  storedFiles,
} from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { emailNewAlerts } from './alert-emails';
import { raiseAlert } from './alerts';
import { encryptJson } from './crypto';
import { addDays, todayIn } from './dates';
import { updateGuest } from './guests';
import { receiveMessage } from './inbox';
import { MemoryMailer, type Mailer } from './mailer';
import { updateOrganization } from './org';
import { anonymiseGuest, applyRetention, exportGuestData } from './privacy';
import { createReservation } from './reservations';
import { MemoryFileStore, purgeExpiredFiles, storeFile } from './storage';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;
const files = new MemoryFileStore();

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);
const jpeg = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.from('passport')]);

let seq = 0;
/** A guest with one stay. A stay in the past is marked as departed. */
async function guestWithStay(from: number, to: number, on: TestOrg = org, at: TestHotel = hotel) {
  const n = ++seq;
  const reservation = await createReservation(t.db, on.admin, {
    propertyId: at.property.id,
    source: 'phone',
    guest: {
      firstName: 'Kabir',
      lastName: `Sethi${n}`,
      email: `kabir${n}@example.com`,
      phone: `+91 98000 ${String(10000 + n)}`,
    },
    rooms: [
      {
        roomTypeId: at.standard.roomType.id,
        ratePlanId: at.standard.ratePlan.id,
        checkIn: day(from),
        checkOut: day(to),
        adults: 2,
      },
    ],
    specialRequests: 'A cot for the baby, please.',
  });
  if (to <= 0) {
    await t.db.execute(
      `UPDATE reservation_rooms SET status = 'checked_out' WHERE reservation_id = '${reservation.id}';
       UPDATE reservations SET status = 'checked_out' WHERE id = '${reservation.id}'`,
    );
  }
  const guestId = reservation.guestId!;
  await updateGuest(t.db, on.admin, guestId, { idType: 'passport', idNumber: `P${n}000111` });
  // The guest was last touched when they stayed, not today.
  await t.db
    .update(guests)
    .set({
      updatedAt: new Date(Date.now() + to * 86_400_000),
      createdAt: new Date(Date.now() + (from - 5) * 86_400_000),
    })
    .where(eq(guests.id, guestId));
  return { guestId, reservation, name: `Kabir Sethi${n}` };
}

const guestRow = async (id: string) =>
  (await t.db.select().from(guests).where(eq(guests.id, id)))[0]!;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org, { standardRooms: 6 });
});
afterAll(async () => {
  await t.drop();
});

describe('a guest\u2019s own data', () => {
  it('is handed over in full when the guest asks for a copy', async () => {
    const { guestId, reservation, name } = await guestWithStay(-10, -8);
    await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'email',
      externalThreadId: 'thread-export',
      contactName: name,
      contactAddress: 'kabir@example.com',
      body: 'Do you have parking?',
      reservationId: reservation.id,
      guestId,
    });
    await t.db.insert(onlineCheckins).values({
      reservationId: reservation.id,
      status: 'submitted',
      dataEnc: encryptJson({ guests: [{ name, idNumber: 'P1' }] }),
      signatureName: name,
    });
    await storeFile(t.db, files, {
      orgId: org.orgId,
      reservationId: reservation.id,
      guestId,
      kind: 'id_document',
      fileName: 'passport.jpg',
      data: jpeg,
    });

    const data = await exportGuestData(t.db, org.admin, guestId);
    expect(data.profile).toMatchObject({
      firstName: 'Kabir',
      email: expect.stringMatching(/^kabir\d+@example\.com$/),
      idType: 'passport',
      idNumber: expect.stringMatching(/^P\d+000111$/),
    });
    expect(data.stays).toMatchObject([
      {
        code: reservation.code,
        property: hotel.property.name,
        checkIn: day(-10),
        checkOut: day(-8),
        totalAmount: 900_000,
        specialRequests: 'A cot for the baby, please.',
        onlineCheckin: { guests: [{ name, idNumber: 'P1' }] },
      },
    ]);
    expect(data.conversations).toMatchObject([
      { channel: 'email', messages: [{ from: 'guest', text: 'Do you have parking?' }] },
    ]);
    expect(data.documents).toMatchObject([{ fileName: 'passport.jpg' }]);
    // That the copy was made is on record.
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'guest.exported'));
    expect(entry).toMatchObject({ entityId: guestId, actorUserId: org.adminUserId });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(exportGuestData(t.db, rival.admin, guestId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('is erased on request, leaving the stay for the books under "Former guest"', async () => {
    const { guestId, reservation, name } = await guestWithStay(-20, -18);
    await receiveMessage(t.db, {
      orgId: org.orgId,
      channel: 'email',
      externalThreadId: 'thread-erase',
      contactName: name,
      contactAddress: 'kabir@example.com',
      body: 'My passport number is P123.',
      reservationId: reservation.id,
      guestId,
    });
    await t.db.insert(onlineCheckins).values({
      reservationId: reservation.id,
      status: 'submitted',
      dataEnc: encryptJson({ guests: [{ name }] }),
      signatureName: name,
      ip: '203.0.113.9',
    });
    const file = await storeFile(t.db, files, {
      orgId: org.orgId,
      reservationId: reservation.id,
      kind: 'id_document',
      fileName: 'passport.jpg',
      data: jpeg,
    });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(anonymiseGuest(t.db, rival.admin, guestId)).rejects.toMatchObject({
      code: 'not_found',
    });

    await anonymiseGuest(t.db, org.admin, guestId);
    const guest = await guestRow(guestId);
    expect(guest).toMatchObject({
      firstName: 'Former',
      lastName: 'guest',
      email: null,
      phone: null,
      idType: null,
      idNumberEnc: null,
      notes: null,
    });
    expect(guest.anonymizedAt).toBeInstanceOf(Date);
    const [stay] = await t.db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservation.id));
    // The stay itself stays: dates, room and money are the hotel's records.
    expect(stay).toMatchObject({
      guestName: 'Former guest',
      specialRequests: null,
      checkIn: day(-20),
      totalAmount: 900_000,
      status: 'checked_out',
    });
    expect(
      await t.db
        .select()
        .from(conversations)
        .where(eq(conversations.reservationId, reservation.id)),
    ).toEqual([]);
    const [checkin] = await t.db
      .select()
      .from(onlineCheckins)
      .where(eq(onlineCheckins.reservationId, reservation.id));
    expect(checkin).toMatchObject({ dataEnc: null, signatureName: null, ip: null });
    // The document leaves the file store at the next clean-up.
    expect(files.files.size).toBeGreaterThan(0);
    const before = files.files.size;
    await purgeExpiredFiles(t.db, files, new Date(Date.now() + 1000));
    expect(files.files.size).toBe(before - 1);
    const [gone] = await t.db.select().from(storedFiles).where(eq(storedFiles.id, file.id));
    expect(gone!.deletedAt).toBeInstanceOf(Date);
    // Nothing in the audit trail still names them.
    const trail = await t.db.select().from(auditLog);
    expect(JSON.stringify(trail)).not.toContain(name);
    expect(trail.find((e) => e.action === 'guest.anonymised')).toMatchObject({
      entityId: guestId,
      summary: 'Erased the personal details of a guest',
    });

    // Doing it again changes nothing, and nothing is erased while a stay is still to come.
    await anonymiseGuest(t.db, org.admin, guestId);
    const coming = await guestWithStay(5, 7);
    await expect(anonymiseGuest(t.db, org.admin, coming.guestId)).rejects.toThrow(
      /a stay under way or still to come/,
    );
    expect((await guestRow(coming.guestId)).firstName).toBe('Kabir');
  });
});

describe('the audit trail', () => {
  const refusal = async (work: Promise<unknown>): Promise<string | undefined> => {
    try {
      await work;
      return undefined;
    } catch (err) {
      return pgErrorInfo(err)?.message;
    }
  };

  it('lets nothing but the wording of an entry change, and that only when announced', async () => {
    // Without the announcement not even the wording can be touched.
    expect(await refusal(t.db.execute(sql`UPDATE audit_log SET summary = 'rewritten'`))).toBe(
      'audit_log is append-only',
    );
    // With it, who did what and when still cannot.
    for (const change of [
      sql`actor_label = 'someone else'`,
      sql`action = 'nothing.happened'`,
      sql`at = now()`,
      sql`entity_id = 'elsewhere'`,
    ]) {
      expect(
        await refusal(
          t.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('pms.audit_redaction', 'on', true)`);
            await tx.execute(sql`UPDATE audit_log SET ${change}`);
          }),
        ),
      ).toBe('audit_log is append-only');
    }
    expect(await refusal(t.db.execute(sql`DELETE FROM audit_log`))).toBe(
      'audit_log is append-only',
    );
  });
});

describe('how long guest data is kept', () => {
  it('follows each organisation\u2019s own rules, and keeps everything where there are none', async () => {
    const strict = await createTestOrg(t.db, 'Strict Stays');
    const place = await createTestHotel(t.db, strict, { standardRooms: 6 });
    await updateOrganization(t.db, strict.admin, {
      settings: { guestIdRetentionDays: 30, guestProfileRetentionDays: 365 },
    });
    const recent = await guestWithStay(-10, -8, strict, place);
    const lastMonth = await guestWithStay(-42, -40, strict, place);
    const longAgo = await guestWithStay(-402, -400, strict, place);
    // Someone who stayed long ago but is coming back is still a guest.
    const returning = await guestWithStay(-402, -400, strict, place);
    await createReservation(t.db, strict.admin, {
      propertyId: place.property.id,
      source: 'phone',
      guest: { id: returning.guestId },
      rooms: [
        {
          roomTypeId: place.standard.roomType.id,
          ratePlanId: place.standard.ratePlan.id,
          checkIn: day(20),
          checkOut: day(22),
          adults: 2,
        },
      ],
    });
    await t.db.insert(onlineCheckins).values({
      reservationId: lastMonth.reservation.id,
      status: 'verified',
      dataEnc: encryptJson({ guests: [] }),
    });
    const document = await storeFile(t.db, files, {
      orgId: strict.orgId,
      reservationId: lastMonth.reservation.id,
      kind: 'id_document',
      fileName: 'old.jpg',
      data: jpeg,
    });
    // An organisation with no rules of its own, with a guest from long ago.
    const lax = await guestWithStay(-402, -400);

    const run = await applyRetention(t.db);
    // Identity numbers of the two whose stays are more than thirty days past; one of those two
    // is past the year as well and is forgotten altogether.
    expect(run).toEqual({
      idNumbersErased: 2,
      checkinsErased: 1,
      documentsMarked: 1,
      guestsAnonymised: 1,
    });

    // Ten days ago: all kept.
    expect(await guestRow(recent.guestId)).toMatchObject({
      firstName: 'Kabir',
      idType: 'passport',
    });
    expect((await guestRow(recent.guestId)).idNumberEnc).not.toBeNull();
    // Forty days ago: the identity number goes, the profile stays.
    const partly = await guestRow(lastMonth.guestId);
    expect(partly).toMatchObject({ firstName: 'Kabir', idNumberEnc: null, anonymizedAt: null });
    expect(partly.email).toMatch(/^kabir/);
    const [checkin] = await t.db
      .select()
      .from(onlineCheckins)
      .where(eq(onlineCheckins.reservationId, lastMonth.reservation.id));
    expect(checkin!.dataEnc).toBeNull();
    const [marked] = await t.db.select().from(storedFiles).where(eq(storedFiles.id, document.id));
    expect(marked!.deleteAfter).toBeInstanceOf(Date);
    // Four hundred days ago: forgotten altogether.
    expect(await guestRow(longAgo.guestId)).toMatchObject({ firstName: 'Former', email: null });
    // Coming back, or with an organisation that keeps everything: untouched.
    expect((await guestRow(returning.guestId)).idNumberEnc).not.toBeNull();
    expect(await guestRow(lax.guestId)).toMatchObject({ firstName: 'Kabir', anonymizedAt: null });
    expect((await guestRow(lax.guestId)).idNumberEnc).not.toBeNull();

    // Nothing more to do the next day.
    expect(await applyRetention(t.db)).toEqual({
      idNumbersErased: 0,
      checkinsErased: 0,
      documentsMarked: 0,
      guestsAnonymised: 0,
    });
  });
});

describe('alerts by email', () => {
  it('go once to the addresses the organisation named, the urgent ones first', async () => {
    const watched = await createTestOrg(t.db, 'Watched Hotels');
    const place = await createTestHotel(t.db, watched);
    await updateOrganization(t.db, watched.admin, {
      settings: { alertEmails: ['gm@example.com', 'duty@example.com'] },
    });
    const raise = (
      kind: 'sync_failure' | 'overbooking' | 'night_audit',
      severity: 'info' | 'warning' | 'critical',
      title: string,
    ) =>
      raiseAlert(t.db, {
        orgId: watched.orgId,
        propertyId: place.property.id,
        kind,
        severity,
        title,
        body: `Details of: ${title}`,
        dedupeKey: `${kind}:${title}`,
      });
    await raise('sync_failure', 'warning', 'Booking.com has not been updated for 20 minutes');
    await raise('overbooking', 'critical', 'Two bookings for the last Deluxe Room on 12 December');
    await raise('night_audit', 'info', 'Night audit finished');
    // An organisation that named nobody is told nothing, and its alerts wait.
    await raiseAlert(t.db, {
      orgId: org.orgId,
      kind: 'overbooking',
      severity: 'critical',
      title: 'Nobody to tell',
      dedupeKey: 'nobody',
    });

    const mailer = new MemoryMailer();
    const options = { webUrl: 'https://pms.example.com' };
    const silent: Mailer = { configured: false, send: async () => ({ delivered: false }) };
    expect(await emailNewAlerts(t.db, silent, options)).toBe(0);
    const broken: Mailer = {
      configured: true,
      send: async () => {
        throw new Error('mail server down');
      },
    };
    // The mail server is down: nothing is lost, the next run sends it.
    expect(await emailNewAlerts(t.db, broken, options)).toBe(0);
    expect(await emailNewAlerts(t.db, mailer, options)).toBe(2);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toEqual(['gm@example.com', 'duty@example.com']);
    expect(mail.subject).toBe('Urgent: 2 things need attention');
    expect(mail.text.indexOf('URGENT: Two bookings')).toBeLessThan(
      mail.text.indexOf('Warning: Booking.com has not'),
    );
    expect(mail.text).toContain(`Property: ${place.property.name}`);
    expect(mail.text).toContain('https://pms.example.com');
    expect(mail.text).not.toContain('Night audit finished');

    expect(await emailNewAlerts(t.db, mailer, options)).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    const [untold] = await t.db.select().from(alerts).where(eq(alerts.dedupeKey, 'nobody'));
    expect(untold!.notifiedAt).toBeNull();

    // One alert on its own has its title as the subject. An alert from days ago is no longer news.
    await raise('sync_failure', 'warning', 'Airbnb has not been updated for 20 minutes');
    await raise('overbooking', 'critical', 'An old problem');
    await t.db
      .update(alerts)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(alerts.title, 'An old problem'));
    expect(await emailNewAlerts(t.db, mailer, options)).toBe(1);
    expect(mailer.last()!.subject).toBe('Airbnb has not been updated for 20 minutes');
  });
});
