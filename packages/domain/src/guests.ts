import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { guests, type DbOrTx } from '@pms/db';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { decryptSecret, encryptSecret } from './crypto';
import { notFound, validationError } from './errors';

export type GuestRow = typeof guests.$inferSelect;

export interface GuestInput {
  /** Use an existing profile. The other fields then only fill in what the profile lacks. */
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  language?: string | null;
  nationality?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  company?: string | null;
  gstin?: string | null;
}

export function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}

export function fullName(guest: { firstName: string; lastName: string }): string {
  return `${guest.firstName} ${guest.lastName}`.trim();
}

/** Digits only, keeping a leading plus, so the same number written differently still matches. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function normalizeEmail(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

/**
 * Finds the guest profile for a booker, or creates one. Matches on email,
 * then on phone, so returning guests accumulate one history. An existing
 * profile is only completed, never overwritten, by booking data.
 */
export async function findOrCreateGuest(
  tx: DbOrTx,
  orgId: string,
  input: GuestInput,
): Promise<GuestRow> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);

  let existing: GuestRow | undefined;
  if (input.id) {
    [existing] = await tx
      .select()
      .from(guests)
      .where(and(eq(guests.id, input.id), eq(guests.orgId, orgId)));
    if (!existing) throw notFound('Guest', input.id);
  } else if (email) {
    [existing] = await tx
      .select()
      .from(guests)
      .where(and(eq(guests.orgId, orgId), eq(guests.email, email), isNull(guests.anonymizedAt)))
      .orderBy(desc(guests.updatedAt))
      .limit(1);
  }
  if (!existing && !input.id && phone) {
    [existing] = await tx
      .select()
      .from(guests)
      .where(and(eq(guests.orgId, orgId), eq(guests.phone, phone), isNull(guests.anonymizedAt)))
      .orderBy(desc(guests.updatedAt))
      .limit(1);
  }

  if (existing) {
    const fill: Partial<typeof guests.$inferInsert> = {};
    if (!existing.email && email) fill.email = email;
    if (!existing.phone && phone) fill.phone = phone;
    if (!existing.lastName && input.lastName) fill.lastName = input.lastName.trim();
    for (const field of [
      'language',
      'nationality',
      'addressLine1',
      'city',
      'state',
      'postalCode',
      'country',
      'company',
      'gstin',
    ] as const) {
      const value = input[field];
      if (!existing[field] && value) fill[field] = value;
    }
    if (Object.keys(fill).length === 0) return existing;
    const [updated] = await tx
      .update(guests)
      .set(fill)
      .where(eq(guests.id, existing.id))
      .returning();
    return updated!;
  }

  const firstName = input.firstName?.trim();
  if (!firstName) throw validationError('Guest name is required');
  const [created] = await tx
    .insert(guests)
    .values({
      orgId,
      firstName,
      lastName: input.lastName?.trim() ?? '',
      email,
      phone,
      language: input.language ?? null,
      nationality: input.nationality ?? null,
      addressLine1: input.addressLine1 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      company: input.company ?? null,
      gstin: input.gstin ?? null,
    })
    .returning();
  return created!;
}

export interface GuestUpdate extends Omit<GuestInput, 'id'> {
  dateOfBirth?: string | null;
  idType?: string | null;
  /** Plain identity document number; stored encrypted. Null erases it. */
  idNumber?: string | null;
  idExpiry?: string | null;
  notes?: string | null;
  tags?: string[];
  vip?: boolean;
  blacklisted?: boolean;
  marketingConsent?: boolean;
  preferences?: Record<string, unknown>;
}

export async function updateGuest(
  db: DbOrTx,
  actor: Actor,
  guestId: string,
  patch: GuestUpdate,
): Promise<GuestRow> {
  const [before] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.orgId, actor.orgId)));
  if (!before) throw notFound('Guest', guestId);
  const { idNumber, ...rest } = patch;
  const next: Partial<typeof guests.$inferInsert> = { ...rest };
  if (patch.email !== undefined) next.email = normalizeEmail(patch.email);
  if (patch.phone !== undefined) next.phone = normalizePhone(patch.phone);
  if (patch.firstName !== undefined) {
    next.firstName = patch.firstName.trim();
    if (!next.firstName) throw validationError('Guest name is required');
  }
  if (idNumber !== undefined) next.idNumberEnc = idNumber ? encryptSecret(idNumber) : null;
  const changes = diff(
    before as unknown as Record<string, unknown>,
    next as Record<string, unknown>,
  );
  if (Object.keys(changes).length === 0) return before;
  const [after] = await db.update(guests).set(next).where(eq(guests.id, guestId)).returning();
  await writeAudit(db, actor, {
    action: 'guest.updated',
    entityType: 'guest',
    entityId: guestId,
    summary: `Updated guest ${fullName(after!)}`,
    changes,
  });
  return after!;
}

/** Decrypts the identity document number. Callers must hold the `guests.pii` permission; the read is audited. */
export async function revealGuestIdNumber(
  db: DbOrTx,
  actor: Actor,
  guestId: string,
): Promise<string | null> {
  const [guest] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.orgId, actor.orgId)));
  if (!guest) throw notFound('Guest', guestId);
  await writeAudit(db, actor, {
    action: 'guest.id_viewed',
    entityType: 'guest',
    entityId: guestId,
    summary: `Viewed identity document of ${fullName(guest)}`,
  });
  return guest.idNumberEnc ? decryptSecret(guest.idNumberEnc) : null;
}

/** Public view of a guest: never includes the encrypted identity number. */
export function guestView(guest: GuestRow) {
  const { idNumberEnc, ...rest } = guest;
  return { ...rest, name: fullName(guest), hasIdNumber: idNumberEnc !== null };
}

export async function searchGuests(
  db: DbOrTx,
  orgId: string,
  params: { query?: string; limit?: number; offset?: number },
): Promise<GuestRow[]> {
  const conditions: SQL[] = [eq(guests.orgId, orgId), isNull(guests.anonymizedAt)];
  const q = params.query?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const phone = normalizePhone(q);
    conditions.push(
      or(
        ilike(sql`${guests.firstName} || ' ' || ${guests.lastName}`, like),
        ilike(sql`${guests.email}::text`, like),
        phone ? ilike(guests.phone, `%${phone.replace(/^\+/, '')}%`) : undefined,
      )!,
    );
  }
  return db
    .select()
    .from(guests)
    .where(and(...conditions))
    .orderBy(desc(guests.updatedAt))
    .limit(Math.min(params.limit ?? 25, 100))
    .offset(params.offset ?? 0);
}
