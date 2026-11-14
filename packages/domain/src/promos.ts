import { and, asc, eq, sql } from 'drizzle-orm';
import { promoCodes, properties, type DbOrTx, type PromoKind } from '@pms/db';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { addDays, type DateString } from './dates';
import { conflict, notFound, validationError } from './errors';
import { displayMoney } from './money';
import { isValidCurrency } from './org';
import { transact } from './sqlx';

export type PromoRow = typeof promoCodes.$inferSelect;

export interface PromoInput {
  code: string;
  description?: string | null;
  /** Null or absent: every property. */
  propertyId?: string | null;
  kind: PromoKind;
  /** Basis points off each night for `percent`; minor units off the stay for `amount`. */
  value: number;
  currency?: string | null;
  bookFrom?: Date | null;
  bookTo?: Date | null;
  stayFrom?: DateString | null;
  stayTo?: DateString | null;
  minNights?: number;
  maxUses?: number | null;
  ratePlanIds?: string[] | null;
  active?: boolean;
}

function normalizeCode(code: string): string {
  const value = code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(value)) {
    throw validationError(
      'A promotional code is 2 to 30 letters and digits (dashes and underscores allowed)',
    );
  }
  return value;
}

function validate(v: {
  kind: PromoKind;
  value: number;
  currency: string | null;
  bookFrom: Date | null;
  bookTo: Date | null;
  stayFrom: DateString | null;
  stayTo: DateString | null;
  minNights: number;
  maxUses: number | null;
}): void {
  if (!Number.isInteger(v.value) || v.value <= 0) {
    throw validationError('The discount must be above zero');
  }
  if (v.kind === 'percent' && v.value >= 10_000) {
    throw validationError('A percentage discount must be below 100%');
  }
  if (v.kind === 'amount' && (!v.currency || !isValidCurrency(v.currency))) {
    throw validationError('A fixed discount needs the currency it is in');
  }
  if (v.bookFrom && v.bookTo && v.bookFrom >= v.bookTo) {
    throw validationError('The booking window must end after it starts');
  }
  if (v.stayFrom && v.stayTo && v.stayFrom > v.stayTo) {
    throw validationError('The stay window must end on or after the day it starts');
  }
  if (!Number.isInteger(v.minNights) || v.minNights < 1 || v.minNights > 365) {
    throw validationError('Minimum nights must be between 1 and 365');
  }
  if (v.maxUses !== null && (!Number.isInteger(v.maxUses) || v.maxUses < 1)) {
    throw validationError('The number of uses must be at least 1, or empty for no limit');
  }
}

async function checkProperty(tx: DbOrTx, orgId: string, propertyId: string): Promise<void> {
  const [property] = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.orgId, orgId)));
  if (!property) throw notFound('Property', propertyId);
}

export async function createPromo(db: DbOrTx, actor: Actor, input: PromoInput): Promise<PromoRow> {
  const code = normalizeCode(input.code);
  const values = {
    kind: input.kind,
    value: input.value,
    currency: input.kind === 'amount' ? (input.currency?.toUpperCase() ?? null) : null,
    bookFrom: input.bookFrom ?? null,
    bookTo: input.bookTo ?? null,
    stayFrom: input.stayFrom ?? null,
    stayTo: input.stayTo ?? null,
    minNights: input.minNights ?? 1,
    maxUses: input.maxUses ?? null,
  };
  validate(values);
  return transact(db, async (tx) => {
    if (input.propertyId) await checkProperty(tx, actor.orgId, input.propertyId);
    const [clash] = await tx
      .select({ id: promoCodes.id })
      .from(promoCodes)
      .where(and(eq(promoCodes.orgId, actor.orgId), eq(promoCodes.code, code)));
    if (clash) throw conflict(`The code ${code} already exists`);
    const [row] = await tx
      .insert(promoCodes)
      .values({
        ...values,
        orgId: actor.orgId,
        propertyId: input.propertyId ?? null,
        code,
        description: input.description?.trim() || null,
        ratePlanIds: input.ratePlanIds?.length ? input.ratePlanIds : null,
        active: input.active ?? true,
        createdBy: actor.userId ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'promo.created',
      entityType: 'promo_code',
      entityId: row!.id,
      propertyId: row!.propertyId,
      summary: `Created promotional code ${code}`,
    });
    return row!;
  });
}

export async function updatePromo(
  db: DbOrTx,
  actor: Actor,
  promoId: string,
  patch: Partial<Omit<PromoInput, 'code'>>,
): Promise<PromoRow> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.id, promoId), eq(promoCodes.orgId, actor.orgId)))
      .for('update');
    if (!before) throw notFound('Promotional code', promoId);
    if (patch.propertyId) await checkProperty(tx, actor.orgId, patch.propertyId);
    const kind = patch.kind ?? before.kind;
    const next = {
      kind,
      value: patch.value ?? before.value,
      currency:
        kind === 'amount'
          ? ((patch.currency === undefined ? before.currency : patch.currency)?.toUpperCase() ??
            null)
          : null,
      bookFrom: patch.bookFrom === undefined ? before.bookFrom : patch.bookFrom,
      bookTo: patch.bookTo === undefined ? before.bookTo : patch.bookTo,
      stayFrom: patch.stayFrom === undefined ? before.stayFrom : patch.stayFrom,
      stayTo: patch.stayTo === undefined ? before.stayTo : patch.stayTo,
      minNights: patch.minNights ?? before.minNights,
      maxUses: patch.maxUses === undefined ? before.maxUses : patch.maxUses,
    };
    validate(next);
    const [after] = await tx
      .update(promoCodes)
      .set({
        ...next,
        propertyId: patch.propertyId === undefined ? before.propertyId : patch.propertyId,
        description:
          patch.description === undefined ? before.description : patch.description?.trim() || null,
        ratePlanIds:
          patch.ratePlanIds === undefined
            ? before.ratePlanIds
            : patch.ratePlanIds?.length
              ? patch.ratePlanIds
              : null,
        active: patch.active ?? before.active,
      })
      .where(eq(promoCodes.id, promoId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'promo.updated',
      entityType: 'promo_code',
      entityId: promoId,
      propertyId: after!.propertyId,
      summary: `Changed promotional code ${before.code}`,
      changes: diff(before, after!),
    });
    return after!;
  });
}

export async function listPromos(db: DbOrTx, orgId: string): Promise<PromoRow[]> {
  return db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.orgId, orgId))
    .orderBy(asc(promoCodes.code));
}

export async function findPromo(db: DbOrTx, orgId: string, code: string): Promise<PromoRow | null> {
  const value = code.trim();
  if (!value || value.length > 30) return null;
  const [row] = await db
    .select()
    .from(promoCodes)
    .where(and(eq(promoCodes.orgId, orgId), eq(promoCodes.code, value)));
  return row ?? null;
}

export interface PromoContext {
  propertyId: string;
  ratePlanId: string;
  checkIn: DateString;
  checkOut: DateString;
  nights: number;
  currency: string;
  now?: Date;
}

/** Why a code cannot be used for this stay, in words for the guest; null when it can. */
export function promoProblem(promo: PromoRow | null, context: PromoContext): string | null {
  if (!promo || !promo.active) return 'This code is not valid';
  const now = context.now ?? new Date();
  if (promo.propertyId && promo.propertyId !== context.propertyId) {
    return 'This code is not valid at this property';
  }
  if (promo.bookFrom && now < promo.bookFrom) return 'This code cannot be used yet';
  if (promo.bookTo && now >= promo.bookTo) return 'This code has expired';
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    return 'This code has been used as many times as it allows';
  }
  if (context.nights < promo.minNights) {
    return `This code needs a stay of at least ${promo.minNights} nights`;
  }
  const lastNight = addDays(context.checkOut, -1);
  if (
    (promo.stayFrom && context.checkIn < promo.stayFrom) ||
    (promo.stayTo && lastNight > promo.stayTo)
  ) {
    return 'This code is not valid for these dates';
  }
  if (promo.ratePlanIds && !promo.ratePlanIds.includes(context.ratePlanId)) {
    return 'This code does not apply to this rate';
  }
  if (promo.kind === 'amount' && promo.currency !== context.currency) {
    return 'This code is not valid at this property';
  }
  return null;
}

/**
 * Takes the discount off nightly amounts. A percentage comes off every
 * night; a fixed amount is spread over the nights in proportion, so each
 * night's tax is worked out on what the guest really pays for it.
 */
export function applyPromo(
  promo: Pick<PromoRow, 'kind' | 'value'>,
  nightly: number[],
): { nightly: number[]; discount: number } {
  const total = nightly.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return { nightly: [...nightly], discount: 0 };
  if (promo.kind === 'percent') {
    const reduced = nightly.map((n) => n - Math.round((n * promo.value) / 10_000));
    return { nightly: reduced, discount: total - reduced.reduce((sum, n) => sum + n, 0) };
  }
  const discount = Math.min(promo.value, total);
  let left = discount;
  const reduced = nightly.map((n, i) => {
    const share = i === nightly.length - 1 ? left : Math.floor((discount * n) / total);
    const off = Math.min(share, n);
    left -= off;
    return n - off;
  });
  // Rounding can leave a remainder when the last night is too small to take it: put it on earlier nights.
  for (let i = 0; left > 0 && i < reduced.length; i++) {
    const off = Math.min(left, reduced[i]!);
    reduced[i]! -= off;
    left -= off;
  }
  return { nightly: reduced, discount: discount - left };
}

/** Words for the booking site: "10% off", "₹500 off". */
export function promoLabel(promo: Pick<PromoRow, 'kind' | 'value' | 'currency'>): string {
  if (promo.kind === 'percent') {
    const percent = promo.value / 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}% off`;
  }
  return `${displayMoney(promo.value, promo.currency ?? 'INR')} off`;
}

/**
 * Sets a code's count of uses to the bookings that hold it now: those that
 * are confirmed, took place, or did not show. A hold that was never paid for
 * and a cancelled booking do not count, so cancelling gives the use back. A
 * booking already paid for is honoured even if that takes the count past the
 * limit: the limit is enforced when the price is quoted.
 */
export async function recountPromoUses(tx: DbOrTx, promoId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE promo_codes p SET used_count = (
      SELECT count(*) FROM reservations r
      WHERE r.promo_code_id = p.id AND r.status NOT IN ('tentative', 'cancelled'))
    WHERE p.id = ${promoId}
  `);
}

/** Removes a code that no booking was ever made with. One that was used is kept for the record. */
export async function deletePromo(db: DbOrTx, actor: Actor, promoId: string): Promise<void> {
  await transact(db, async (tx) => {
    const [promo] = await tx
      .select()
      .from(promoCodes)
      .where(and(eq(promoCodes.id, promoId), eq(promoCodes.orgId, actor.orgId)))
      .for('update');
    if (!promo) throw notFound('Promotional code', promoId);
    const { rows } = await tx.execute<{ code: string }>(
      sql`SELECT code FROM reservations WHERE promo_code_id = ${promoId} LIMIT 1`,
    );
    if (rows.length > 0) {
      throw conflict(
        `${promo.code} was used for booking ${rows[0]!.code}, so it is kept for the record. Switch it off instead.`,
      );
    }
    await tx.delete(promoCodes).where(eq(promoCodes.id, promoId));
    await writeAudit(tx, actor, {
      action: 'promo.deleted',
      entityType: 'promo_code',
      entityId: promoId,
      propertyId: promo.propertyId,
      summary: `Removed promotional code ${promo.code}`,
    });
  });
}
