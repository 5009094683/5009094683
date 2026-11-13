import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  guests,
  onlineCheckins,
  organizations,
  type properties,
  reservations,
  storedFiles,
  type DbOrTx,
  type OnlineCheckinStatus,
} from '@pms/db';
import { writeAudit } from './audit';
import { reservationForGuestToken } from './booking-engine';
import type { Actor } from './context';
import { decryptJson, encryptJson, encryptSecret } from './crypto';
import { addDays, diffDays, todayIn, type DateString } from './dates';
import { invalidState, notFound, validationError } from './errors';
import { emit } from './outbox';
import { transact } from './sqlx';
import { deleteStoredFile, readStoredFile, storeFile, type FileStore } from './storage';

type ReservationRow = typeof reservations.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;

/** How many days before arrival a guest can check in online. */
const OPENS_DAYS_BEFORE = 7;
const MAX_DOCUMENTS = 8;

export const ID_TYPES = [
  'passport',
  'aadhaar',
  'driving_licence',
  'voter_id',
  'national_id',
  'other',
] as const;
export type IdType = (typeof ID_TYPES)[number];

export interface CheckinGuest {
  name: string;
  /** Two-letter country code. */
  nationality?: string | null;
  dateOfBirth?: DateString | null;
  idType?: IdType | null;
  idNumber?: string | null;
  idExpiry?: DateString | null;
  address?: string | null;
  /** Asked of visitors from abroad, for the register of foreign guests. */
  visaNumber?: string | null;
  visaExpiry?: DateString | null;
  arrivedInCountryOn?: DateString | null;
  arrivingFrom?: string | null;
  nextDestination?: string | null;
}

export interface CheckinForm {
  arrivalTime?: string | null;
  guests: CheckinGuest[];
  /** The guest's name, typed to accept the house rules. */
  signatureName: string;
  acceptTerms: boolean;
}

interface StoredCheckin {
  guests: CheckinGuest[];
}

export interface CheckinDocument {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: Date;
}

export interface GuestCheckin {
  status: OnlineCheckinStatus | 'not_started';
  /** Whether the form can be filled in or changed now, and if not, why. */
  open: boolean;
  reason: string | null;
  bookingCode: string;
  propertyName: string;
  propertyCountry: string;
  checkIn: DateString;
  checkOut: DateString;
  /** How many people the booking is for. */
  expectedGuests: number;
  arrivalTime: string | null;
  /** What was entered, with identity numbers reduced to their last four characters. */
  guests: (Omit<CheckinGuest, 'idNumber' | 'visaNumber'> & {
    idNumberEnding: string | null;
    visaNumberEnding: string | null;
  })[];
  documents: CheckinDocument[];
  terms: string | null;
  submittedAt: Date | null;
}

const ending = (value: string | null | undefined): string | null =>
  value ? value.slice(-4).padStart(Math.min(value.length, 8), '\u2022') : null;

function whyClosed(reservation: ReservationRow, property: PropertyRow): string | null {
  const today = todayIn(property.timezone);
  if (reservation.status === 'in_house' || reservation.status === 'checked_out') {
    return 'You have already checked in at the property';
  }
  if (reservation.status !== 'confirmed') return 'This booking is not confirmed';
  if (today > reservation.checkIn) return 'The arrival date has passed';
  if (diffDays(today, reservation.checkIn) > OPENS_DAYS_BEFORE) {
    return `Online check-in opens ${OPENS_DAYS_BEFORE} days before arrival`;
  }
  return null;
}

async function documentsOf(db: DbOrTx, reservationId: string): Promise<CheckinDocument[]> {
  return db
    .select({
      id: storedFiles.id,
      fileName: storedFiles.fileName,
      contentType: storedFiles.contentType,
      size: storedFiles.size,
      createdAt: storedFiles.createdAt,
    })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.reservationId, reservationId),
        eq(storedFiles.kind, 'id_document'),
        isNull(storedFiles.deletedAt),
      ),
    )
    .orderBy(asc(storedFiles.createdAt));
}

/** What the guest sees when opening online check-in from their link. */
export async function getGuestCheckin(
  db: DbOrTx,
  token: string,
  now: Date = new Date(),
): Promise<GuestCheckin> {
  const { reservation, property } = await reservationForGuestToken(db, token, now);
  const [row] = await db
    .select()
    .from(onlineCheckins)
    .where(eq(onlineCheckins.reservationId, reservation.id));
  const stored = row?.dataEnc ? decryptJson<StoredCheckin>(row.dataEnc) : { guests: [] };
  const verified = row?.status === 'verified';
  const reason = verified
    ? 'The property has checked your details. Speak to the front desk to change them.'
    : whyClosed(reservation, property);
  return {
    status: row?.status ?? 'not_started',
    open: reason === null,
    reason,
    bookingCode: reservation.code,
    propertyName: property.name,
    propertyCountry: property.country,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    expectedGuests: reservation.adults + reservation.children,
    arrivalTime: row?.arrivalTime ?? reservation.arrivalTime,
    guests: stored.guests.map(({ idNumber, visaNumber, ...rest }) => ({
      ...rest,
      idNumberEnding: ending(idNumber),
      visaNumberEnding: ending(visaNumber),
    })),
    documents: await documentsOf(db, reservation.id),
    terms: property.settings.bookingTerms ?? null,
    submittedAt: row?.submittedAt ?? null,
  };
}

const clean = (value: string | null | undefined, max: number): string | null =>
  value?.trim().slice(0, max) || null;

function normaliseGuest(guest: CheckinGuest, index: number, propertyCountry: string): CheckinGuest {
  const name = guest.name?.trim();
  if (!name) throw validationError(`Guest ${index + 1} needs a name`);
  const nationality = clean(guest.nationality, 2)?.toUpperCase() ?? null;
  if (nationality && !/^[A-Z]{2}$/.test(nationality)) {
    throw validationError('Nationality is a two-letter country code');
  }
  const idType = guest.idType ?? null;
  if (idType && !(ID_TYPES as readonly string[]).includes(idType)) {
    throw validationError('Unknown kind of identity document');
  }
  const idNumber = clean(guest.idNumber, 60);
  if (index === 0 && (!idType || !idNumber)) {
    throw validationError('The first guest must give an identity document');
  }
  if (Boolean(idType) !== Boolean(idNumber)) {
    throw validationError(`Guest ${index + 1}: give both the kind of document and its number`);
  }
  const foreign = nationality !== null && nationality !== propertyCountry.toUpperCase();
  if (foreign && idNumber && idType !== 'passport') {
    throw validationError(`${name} is visiting from abroad and must give a passport`);
  }
  return {
    name: name.slice(0, 160),
    nationality,
    dateOfBirth: guest.dateOfBirth ?? null,
    idType,
    idNumber,
    idExpiry: guest.idExpiry ?? null,
    address: clean(guest.address, 400),
    visaNumber: foreign ? clean(guest.visaNumber, 60) : null,
    visaExpiry: foreign ? (guest.visaExpiry ?? null) : null,
    arrivedInCountryOn: foreign ? (guest.arrivedInCountryOn ?? null) : null,
    arrivingFrom: foreign ? clean(guest.arrivingFrom, 120) : null,
    nextDestination: foreign ? clean(guest.nextDestination, 120) : null,
  };
}

/**
 * Saves the guest's online check-in. Identity details are encrypted before
 * they are stored. Can be submitted again to correct something until the
 * property has checked it.
 */
export async function submitGuestCheckin(
  db: DbOrTx,
  token: string,
  form: CheckinForm,
  client: { ip?: string | null; userAgent?: string | null } = {},
  now: Date = new Date(),
): Promise<GuestCheckin> {
  const { reservation, property } = await reservationForGuestToken(db, token, now);
  if (!form.acceptTerms) throw validationError('Please accept the house rules');
  if (!form.signatureName?.trim()) throw validationError('Please type your name to sign');
  if (form.guests.length === 0) throw validationError('Add at least one guest');
  if (form.guests.length > 30) throw validationError('Too many guests for one booking');

  await transact(db, async (tx) => {
    const [locked] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservation.id))
      .for('update');
    const reason = whyClosed(locked!, property);
    if (reason) throw invalidState(reason);
    const [existing] = await tx
      .select()
      .from(onlineCheckins)
      .where(eq(onlineCheckins.reservationId, reservation.id));
    if (existing?.status === 'verified') {
      throw invalidState('The property has already checked your details');
    }
    // The guest only ever sees the end of a saved number, so a correction cannot send it back.
    // A number left empty keeps the one saved for that guest, as long as the document is the same kind.
    const saved = existing?.dataEnc ? decryptJson<StoredCheckin>(existing.dataEnc).guests : [];
    const cleaned = form.guests.map((guest, i) => {
      const before = saved[i];
      const sameDocument = before && (!guest.idType || guest.idType === before.idType);
      return normaliseGuest(
        {
          ...guest,
          idType: guest.idType ?? (sameDocument ? before.idType : null),
          idNumber: guest.idNumber?.trim() || (sameDocument ? before.idNumber : null),
          visaNumber: guest.visaNumber?.trim() || before?.visaNumber || null,
        },
        i,
        property.country,
      );
    });
    const values = {
      status: 'submitted' as const,
      arrivalTime: clean(form.arrivalTime, 20),
      guestCount: cleaned.length,
      dataEnc: encryptJson({ guests: cleaned } satisfies StoredCheckin),
      signatureName: form.signatureName.trim().slice(0, 160),
      termsAcceptedAt: now,
      submittedAt: now,
      ip: clean(client.ip, 64),
      userAgent: clean(client.userAgent, 300),
    };
    if (existing) {
      await tx.update(onlineCheckins).set(values).where(eq(onlineCheckins.id, existing.id));
    } else {
      await tx.insert(onlineCheckins).values({ reservationId: reservation.id, ...values });
    }
    await tx
      .update(reservations)
      .set({
        onlineCheckinAt: now,
        ...(values.arrivalTime ? { arrivalTime: values.arrivalTime } : {}),
      })
      .where(eq(reservations.id, reservation.id));

    // The booker's profile gains what it lacked; nothing staff entered is overwritten.
    const first = cleaned[0]!;
    const [guest] = locked!.guestId
      ? await tx.select().from(guests).where(eq(guests.id, locked!.guestId))
      : [];
    if (guest) {
      const fill: Partial<typeof guests.$inferInsert> = {};
      if (!guest.nationality && first.nationality) fill.nationality = first.nationality;
      if (!guest.dateOfBirth && first.dateOfBirth) fill.dateOfBirth = first.dateOfBirth;
      if (!guest.idNumberEnc && first.idNumber) {
        fill.idType = first.idType;
        fill.idNumberEnc = encryptSecret(first.idNumber);
        fill.idExpiry = first.idExpiry ?? null;
      }
      if (!guest.addressLine1 && first.address) fill.addressLine1 = first.address.slice(0, 200);
      if (Object.keys(fill).length > 0) {
        await tx.update(guests).set(fill).where(eq(guests.id, guest.id));
      }
    }
    await writeAudit(
      tx,
      { type: 'guest', orgId: locked!.orgId, label: `guest:${locked!.guestName}`, grants: [] },
      {
        action: 'reservation.online_checkin',
        entityType: 'reservation',
        entityId: reservation.id,
        propertyId: reservation.propertyId,
        summary: `${locked!.guestName} checked in online for ${reservation.code} (${cleaned.length} guest${cleaned.length === 1 ? '' : 's'})`,
      },
    );
    await emit(tx, locked!.orgId, [
      {
        kind: 'reservation.updated',
        propertyId: reservation.propertyId,
        payload: { reservationId: reservation.id, code: reservation.code },
      },
    ]);
  });
  return getGuestCheckin(db, token, now);
}

/** Adds a photo or scan of an identity document to the booking. */
export async function addCheckinDocument(
  db: DbOrTx,
  store: FileStore,
  token: string,
  upload: { fileName: string; data: Buffer },
  now: Date = new Date(),
): Promise<CheckinDocument> {
  const { reservation, property } = await reservationForGuestToken(db, token, now);
  const reason = whyClosed(reservation, property);
  if (reason) throw invalidState(reason);
  if ((await documentsOf(db, reservation.id)).length >= MAX_DOCUMENTS) {
    throw validationError(`At most ${MAX_DOCUMENTS} documents can be added to a booking`);
  }
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, reservation.orgId));
  const keepDays = org?.settings.guestIdRetentionDays ?? 0;
  const file = await storeFile(db, store, {
    orgId: reservation.orgId,
    propertyId: reservation.propertyId,
    reservationId: reservation.id,
    guestId: reservation.guestId,
    kind: 'id_document',
    fileName: upload.fileName,
    data: upload.data,
    // Kept as long as the organisation's rule for identity documents says; zero means until removed by hand.
    deleteAfter:
      keepDays > 0 ? new Date(`${addDays(reservation.checkOut, keepDays)}T00:00:00Z`) : null,
  });
  return {
    id: file.id,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
    createdAt: file.createdAt,
  };
}

/** The guest takes back a document they added, before the property has checked the details. */
export async function removeCheckinDocument(
  db: DbOrTx,
  store: FileStore,
  token: string,
  fileId: string,
  now: Date = new Date(),
): Promise<void> {
  const { reservation, property } = await reservationForGuestToken(db, token, now);
  const reason = whyClosed(reservation, property);
  if (reason) throw invalidState(reason);
  const [row] = await db
    .select()
    .from(onlineCheckins)
    .where(eq(onlineCheckins.reservationId, reservation.id));
  if (row?.status === 'verified')
    throw invalidState('The property has already checked your details');
  const documents = await documentsOf(db, reservation.id);
  if (!documents.some((d) => d.id === fileId)) throw notFound('Document', fileId);
  await deleteStoredFile(db, store, fileId);
}

export interface StaffCheckin {
  status: OnlineCheckinStatus | 'not_started';
  arrivalTime: string | null;
  signatureName: string | null;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  /** Identity numbers are included only when `reveal` was asked for and allowed. */
  guests: (Omit<CheckinGuest, 'idNumber' | 'visaNumber'> & {
    idNumber: string | null;
    visaNumber: string | null;
    idNumberEnding: string | null;
  })[];
  documents: CheckinDocument[];
}

async function staffReservation(db: DbOrTx, orgId: string, reservationId: string) {
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)));
  if (!reservation) throw notFound('Reservation', reservationId);
  return reservation;
}

/**
 * What a guest entered online, for the front desk. Identity numbers are
 * masked unless `reveal` is set; revealing them is recorded in the audit log,
 * and the caller must hold the permission to see identity data.
 */
export async function getStaffCheckin(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  options: { reveal?: boolean } = {},
): Promise<StaffCheckin> {
  const reservation = await staffReservation(db, actor.orgId, reservationId);
  const [row] = await db
    .select()
    .from(onlineCheckins)
    .where(eq(onlineCheckins.reservationId, reservationId));
  const stored = row?.dataEnc ? decryptJson<StoredCheckin>(row.dataEnc) : { guests: [] };
  if (options.reveal && stored.guests.length > 0) {
    await writeAudit(db, actor, {
      action: 'guest.id_viewed',
      entityType: 'reservation',
      entityId: reservationId,
      propertyId: reservation.propertyId,
      summary: `Viewed the identity details given at online check-in for ${reservation.code}`,
    });
  }
  return {
    status: row?.status ?? 'not_started',
    arrivalTime: row?.arrivalTime ?? null,
    signatureName: row?.signatureName ?? null,
    submittedAt: row?.submittedAt ?? null,
    verifiedAt: row?.verifiedAt ?? null,
    guests: stored.guests.map(({ idNumber, visaNumber, ...rest }) => ({
      ...rest,
      idNumber: options.reveal ? (idNumber ?? null) : null,
      visaNumber: options.reveal ? (visaNumber ?? null) : null,
      idNumberEnding: ending(idNumber),
    })),
    documents: await documentsOf(db, reservationId),
  };
}

/** The front desk has compared the details with the documents shown on arrival. */
export async function verifyOnlineCheckin(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
): Promise<void> {
  const reservation = await staffReservation(db, actor.orgId, reservationId);
  const updated = await db
    .update(onlineCheckins)
    .set({ status: 'verified', verifiedAt: new Date(), verifiedBy: actor.userId ?? null })
    .where(
      and(eq(onlineCheckins.reservationId, reservationId), eq(onlineCheckins.status, 'submitted')),
    )
    .returning({ id: onlineCheckins.id });
  if (updated.length === 0) {
    throw invalidState('There is no online check-in waiting to be checked for this reservation');
  }
  await writeAudit(db, actor, {
    action: 'reservation.online_checkin_verified',
    entityType: 'reservation',
    entityId: reservationId,
    propertyId: reservation.propertyId,
    summary: `Checked the online check-in details for ${reservation.code}`,
  });
}

/** An identity document, for staff with the permission to see identity data. Every read is audited. */
export async function readCheckinDocument(
  db: DbOrTx,
  store: FileStore,
  actor: Actor,
  reservationId: string,
  fileId: string,
): Promise<{ fileName: string; contentType: string; data: Buffer }> {
  const reservation = await staffReservation(db, actor.orgId, reservationId);
  const documents = await documentsOf(db, reservationId);
  if (!documents.some((d) => d.id === fileId)) throw notFound('Document', fileId);
  const { file, data } = await readStoredFile(db, store, actor.orgId, fileId);
  await writeAudit(db, actor, {
    action: 'guest.id_viewed',
    entityType: 'reservation',
    entityId: reservationId,
    propertyId: reservation.propertyId,
    summary: `Opened an identity document (${file.fileName}) of ${reservation.code}`,
  });
  return { fileName: file.fileName, contentType: file.contentType, data };
}
