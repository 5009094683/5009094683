import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  companies,
  folioLines,
  folios,
  guests,
  payments,
  properties,
  reservations,
  type BillTo,
  type DbOrTx,
  type FolioLineKind,
  type PaymentMethod,
  type TaxCategory,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { todayIn, type DateString } from './dates';
import { conflict, invalidState, notFound, validationError } from './errors';
import { displayMoney, formatMoney } from './money';
import { emit } from './outbox';
import { transact, uuidArray } from './sqlx';
import { computeTax, taxRuleFor } from './taxes';

export type FolioRow = typeof folios.$inferSelect;
export type FolioLineRow = typeof folioLines.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;

/** Kinds that are charges: they carry tax and go on invoices. */
export const CHARGE_KINDS = ['room', 'food', 'service', 'extra', 'fee', 'discount'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

const isCharge = (kind: FolioLineKind): kind is ChargeKind =>
  (CHARGE_KINDS as readonly string[]).includes(kind);

/** The hotel day in progress at a property: set by the night audit, today until the first one. */
export function businessDateOf(
  property: Pick<PropertyRow, 'businessDate' | 'timezone'>,
  now: Date = new Date(),
): DateString {
  return property.businessDate ?? todayIn(property.timezone, now);
}

export interface FolioTotals {
  /** Charges before tax, discounts taken off. */
  charges: number;
  taxes: number;
  /** Money received, less refunds. */
  payments: number;
  /** Moved to or from other folios. */
  transfers: number;
  /** What is still owed. Negative when the guest is in credit. */
  balance: number;
}

export function totalsOf(
  lines: Pick<FolioLineRow, 'kind' | 'amount' | 'taxAmount' | 'voidedAt'>[],
): FolioTotals {
  const totals: FolioTotals = { charges: 0, taxes: 0, payments: 0, transfers: 0, balance: 0 };
  for (const line of lines) {
    if (line.voidedAt) continue;
    if (isCharge(line.kind)) {
      totals.charges += line.amount;
      totals.taxes += line.taxAmount;
    } else if (line.kind === 'transfer') {
      totals.transfers += line.amount;
    } else {
      // Payments are stored negative and refunds positive; shown here as money in.
      totals.payments -= line.amount;
    }
    totals.balance += line.amount + line.taxAmount;
  }
  return totals;
}

export interface FolioLineView extends FolioLineRow {
  /**
   * For a payment or a refund: how the money moved, and for a payment how
   * much of it has not been refunded yet. Null for charges.
   */
  payment: { method: PaymentMethod; refundable: number } | null;
}

export interface FolioView extends Omit<FolioRow, 'routes'> {
  routes: FolioLineKind[];
  lines: FolioLineView[];
  totals: FolioTotals;
  reservationCode: string | null;
  guestName: string | null;
}

async function folioForUpdate(tx: Transaction, orgId: string, folioId: string): Promise<FolioRow> {
  const [row] = await tx
    .select({ folio: folios })
    .from(folios)
    .innerJoin(properties, eq(properties.id, folios.propertyId))
    .where(and(eq(folios.id, folioId), eq(properties.orgId, orgId)))
    .for('update', { of: folios });
  if (!row) throw notFound('Folio', folioId);
  return row.folio;
}

export async function getFolio(db: DbOrTx, orgId: string, folioId: string): Promise<FolioView> {
  const [row] = await db
    .select({ folio: folios, code: reservations.code, guestName: reservations.guestName })
    .from(folios)
    .innerJoin(properties, eq(properties.id, folios.propertyId))
    .leftJoin(reservations, eq(reservations.id, folios.reservationId))
    .where(and(eq(folios.id, folioId), eq(properties.orgId, orgId)));
  if (!row) throw notFound('Folio', folioId);
  const lines = await db
    .select()
    .from(folioLines)
    .where(eq(folioLines.folioId, folioId))
    .orderBy(asc(folioLines.businessDate), asc(folioLines.seq));
  const paymentIds = [...new Set(lines.flatMap((l) => (l.paymentId ? [l.paymentId] : [])))];
  const { rows: money } = paymentIds.length
    ? await db.execute<{ id: string; method: PaymentMethod; amount: string; refunded: string }>(
        sql`
          SELECT p.id, p.method, p.amount::text,
            coalesce((SELECT sum(r.amount) FROM payments r
                      WHERE r.refund_of_payment_id = p.id AND r.status = 'captured'), 0)::text AS refunded
          FROM payments p WHERE p.id = ANY(${uuidArray(paymentIds)})
        `,
      )
    : { rows: [] };
  const byPayment = new Map(money.map((m) => [m.id, m]));
  return {
    ...row.folio,
    lines: lines.map((line) => {
      const paid = line.paymentId ? byPayment.get(line.paymentId) : undefined;
      return {
        ...line,
        payment: paid
          ? {
              method: paid.method,
              // Refunds are stored as negative payments against the one they return.
              refundable: Math.max(0, Number(paid.amount) + Number(paid.refunded)),
            }
          : null,
      };
    }),
    totals: totalsOf(lines),
    reservationCode: row.code,
    guestName: row.guestName,
  };
}

/** A reservation's folios, oldest first, each with its lines and totals. */
export async function listFolios(
  db: DbOrTx,
  orgId: string,
  reservationId: string,
): Promise<FolioView[]> {
  const rows = await db
    .select({ id: folios.id })
    .from(folios)
    .innerJoin(properties, eq(properties.id, folios.propertyId))
    .where(and(eq(folios.reservationId, reservationId), eq(properties.orgId, orgId)))
    .orderBy(asc(folios.createdAt), asc(folios.id));
  const out: FolioView[] = [];
  for (const { id } of rows) out.push(await getFolio(db, orgId, id));
  return out;
}

/** What a reservation owes across all its folios. */
export async function reservationBalance(db: DbOrTx, reservationId: string): Promise<number> {
  const { rows } = await db.execute<{ balance: string | null }>(sql`
    SELECT sum(l.amount + l.tax_amount)::text AS balance
    FROM folio_lines l JOIN folios f ON f.id = l.folio_id
    WHERE f.reservation_id = ${reservationId} AND l.voided_at IS NULL
  `);
  return Number(rows[0]?.balance ?? 0);
}

async function billToOfGuest(tx: DbOrTx, reservation: ReservationRow): Promise<BillTo> {
  const [guest] = reservation.guestId
    ? await tx.select().from(guests).where(eq(guests.id, reservation.guestId))
    : [];
  return {
    name: reservation.guestName,
    addressLine1: guest?.addressLine1 ?? null,
    city: guest?.city ?? null,
    state: guest?.state ?? null,
    postalCode: guest?.postalCode ?? null,
    country: guest?.country ?? null,
    gstin: guest?.gstin ?? null,
    email: guest?.email ?? null,
  };
}

/**
 * The folio a reservation's charges go to by default, created the first time
 * it is needed. Safe to call from several requests at once: they wait for the
 * reservation and find the folio the first one made.
 */
export async function ensureGuestFolio(tx: Transaction, reservationId: string): Promise<FolioRow> {
  const [reservation] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .for('update');
  if (!reservation) throw notFound('Reservation', reservationId);
  const [existing] = await tx
    .select()
    .from(folios)
    .where(and(eq(folios.reservationId, reservationId), eq(folios.kind, 'guest')))
    .orderBy(asc(folios.createdAt), asc(folios.id))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(folios)
    .values({
      propertyId: reservation.propertyId,
      reservationId,
      kind: 'guest',
      label: 'Guest folio',
      currency: reservation.currency,
      billTo: await billToOfGuest(tx, reservation),
    })
    .returning();
  return created!;
}

/** The folio a charge of this kind belongs on: one that asked for the kind, else the guest folio. */
async function folioForCharge(
  tx: Transaction,
  reservationId: string,
  kind: FolioLineKind,
): Promise<FolioRow> {
  const guestFolio = await ensureGuestFolio(tx, reservationId);
  const open = await tx
    .select()
    .from(folios)
    .where(and(eq(folios.reservationId, reservationId), eq(folios.status, 'open')))
    .orderBy(asc(folios.createdAt));
  return (
    open.find((f) => f.routes.includes(kind)) ??
    (guestFolio.status === 'open' ? guestFolio : (open[0] ?? guestFolio))
  );
}

export interface NewFolioInput {
  label: string;
  /** Bill a company: its details go on the invoice. */
  companyId?: string | null;
  billTo?: BillTo;
  /** Kinds of charge that should be posted to this folio from now on (e.g. room charges to the company). */
  routes?: FolioLineKind[];
}

/** Adds a folio to a reservation, for splitting the bill. */
export async function createFolio(
  db: DbOrTx,
  actor: Actor,
  reservationId: string,
  input: NewFolioInput,
): Promise<FolioRow> {
  if (!input.label.trim()) throw validationError('A folio needs a name');
  return transact(db, async (tx) => {
    const [reservation] = await tx
      .select()
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, actor.orgId)))
      .for('update');
    if (!reservation) throw notFound('Reservation', reservationId);
    await ensureGuestFolio(tx, reservationId);
    let billTo = input.billTo;
    if (input.companyId) {
      const [company] = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.id, input.companyId), eq(companies.orgId, actor.orgId)));
      if (!company) throw notFound('Company', input.companyId);
      billTo ??= billToOfCompany(company);
    }
    billTo ??= await billToOfGuest(tx, reservation);
    const routes = input.routes ?? [];
    if (routes.length > 0) {
      // A kind of charge goes to one folio; taking it over here removes it elsewhere.
      const others = await tx.select().from(folios).where(eq(folios.reservationId, reservationId));
      for (const other of others) {
        const kept = other.routes.filter((k) => !routes.includes(k));
        if (kept.length !== other.routes.length) {
          await tx.update(folios).set({ routes: kept }).where(eq(folios.id, other.id));
        }
      }
    }
    const [created] = await tx
      .insert(folios)
      .values({
        propertyId: reservation.propertyId,
        reservationId,
        companyId: input.companyId ?? null,
        kind: 'guest',
        label: input.label.trim(),
        currency: reservation.currency,
        billTo,
        routes,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.created',
      entityType: 'folio',
      entityId: created!.id,
      propertyId: reservation.propertyId,
      summary: `Added folio "${created!.label}" to reservation ${reservation.code}`,
    });
    await emit(tx, actor.orgId, [
      { kind: 'folio.updated', propertyId: reservation.propertyId, payload: { reservationId } },
    ]);
    return created!;
  });
}

export function billToOfCompany(company: typeof companies.$inferSelect): BillTo {
  return {
    name: company.legalName ?? company.name,
    addressLine1: company.addressLine1,
    city: company.city,
    state: company.state,
    stateCode: company.stateCode,
    postalCode: company.postalCode,
    country: company.country,
    gstin: company.gstin,
    email: company.email,
  };
}

export interface ChargeInput {
  /** Post to this folio, or give `reservationId` to let the routing choose. */
  folioId?: string;
  reservationId?: string;
  kind: ChargeKind;
  description: string;
  /** Price of one, before tax, in minor units. Positive, also for a discount (it is taken off). */
  unitAmount: number;
  quantity?: number;
  /** Defaults to the property's current hotel day. */
  businessDate?: DateString;
  reservationRoomId?: string | null;
  /** For a discount: the kind of charge it reduces, which decides the tax taken off with it. Default: room. */
  discountOn?: Exclude<ChargeKind, 'discount'>;
  source?: string;
}

/**
 * Posts a charge (or a discount) with its tax. The tax is fixed at posting:
 * a later change of rate does not alter what a guest was already charged.
 */
export async function postCharge(
  db: DbOrTx,
  actor: Actor,
  input: ChargeInput,
): Promise<FolioLineRow> {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw validationError('The quantity must be a whole number from 1 to 1000');
  }
  if (!Number.isInteger(input.unitAmount) || input.unitAmount < 0) {
    throw validationError('The amount must be a non-negative whole amount in minor units');
  }
  if (!input.description.trim()) throw validationError('A charge needs a description');
  if (!input.folioId && !input.reservationId) {
    throw validationError('Say which folio or reservation the charge is for');
  }
  return transact(db, async (tx) => {
    const folio = input.folioId
      ? await folioForUpdate(tx, actor.orgId, input.folioId)
      : await folioForCharge(
          tx,
          await requireReservation(tx, actor.orgId, input.reservationId!),
          input.kind,
        );
    if (folio.status !== 'open')
      throw invalidState('This folio is closed. Reopen it to add charges.');
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, folio.propertyId));
    const sign = input.kind === 'discount' ? -1 : 1;
    const category: TaxCategory =
      input.kind === 'discount' ? (input.discountOn ?? 'room') : input.kind;
    const rule = await taxRuleFor(tx, folio.propertyId, category);
    const tax = computeTax(rule, sign * input.unitAmount, quantity);
    const [line] = await tx
      .insert(folioLines)
      .values({
        folioId: folio.id,
        propertyId: folio.propertyId,
        businessDate: input.businessDate ?? businessDateOf(property!),
        kind: input.kind,
        description: input.description.trim().slice(0, 300),
        quantity,
        amount: sign * input.unitAmount * quantity,
        taxAmount: tax.taxAmount,
        taxes: tax.taxes,
        serviceCode: rule?.serviceCode ?? null,
        reservationRoomId: input.reservationRoomId ?? null,
        source: input.source ?? 'manual',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.charge_posted',
      entityType: 'folio',
      entityId: folio.id,
      propertyId: folio.propertyId,
      summary: `Posted ${input.kind === 'discount' ? 'a discount' : 'a charge'}: ${line!.description}, ${formatMoney(line!.amount + line!.taxAmount, folio.currency)}`,
      changes: { lineId: line!.id, amount: line!.amount, tax: line!.taxAmount },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId: folio.id, reservationId: folio.reservationId },
      },
    ]);
    return line!;
  });
}

async function requireReservation(
  tx: Transaction,
  orgId: string,
  reservationId: string,
): Promise<string> {
  const [row] = await tx
    .select({ id: reservations.id })
    .from(reservations)
    .where(and(eq(reservations.id, reservationId), eq(reservations.orgId, orgId)));
  if (!row) throw notFound('Reservation', reservationId);
  return row.id;
}

/**
 * Takes an entry off a folio. It stays on record, marked void with the
 * reason. An entry that is on an invoice cannot be voided (issue a credit
 * note), and a payment is returned with a refund, not by voiding.
 */
export async function voidLine(
  db: DbOrTx,
  actor: Actor,
  lineId: string,
  reason: string,
): Promise<FolioLineRow> {
  if (!reason.trim()) throw validationError('Say why the entry is being voided');
  return transact(db, async (tx) => {
    const [line] = await tx.select().from(folioLines).where(eq(folioLines.id, lineId));
    if (!line) throw notFound('Folio entry', lineId);
    const folio = await folioForUpdate(tx, actor.orgId, line.folioId);
    if (line.voidedAt) return line;
    if (!isCharge(line.kind)) {
      throw invalidState(
        line.kind === 'transfer'
          ? 'A transfer cannot be voided. Transfer the amount back instead.'
          : 'A payment cannot be voided. Refund it instead.',
      );
    }
    if (line.invoiceId) {
      throw invalidState('This entry is on an invoice. Issue a credit note to correct it.');
    }
    if (folio.status !== 'open') throw invalidState('This folio is closed');
    const [voided] = await tx
      .update(folioLines)
      .set({
        voidedAt: new Date(),
        voidedBy: actor.userId ?? null,
        voidReason: reason.trim().slice(0, 300),
      })
      .where(eq(folioLines.id, lineId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.line_voided',
      entityType: 'folio',
      entityId: folio.id,
      propertyId: folio.propertyId,
      summary: `Voided "${line.description}" (${formatMoney(line.amount + line.taxAmount, folio.currency)}): ${reason.trim()}`,
      changes: { lineId },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId: folio.id, reservationId: folio.reservationId },
      },
    ]);
    return voided!;
  });
}

export interface PaymentInput {
  folioId: string;
  method: PaymentMethod;
  /** Money received, in minor units. */
  amount: number;
  reference?: string | null;
  note?: string | null;
  businessDate?: DateString;
  /** For online payments: which gateway, and its own id for the payment. */
  provider?: string | null;
  providerPaymentId?: string | null;
  providerOrderId?: string | null;
}

/** A reference staff typed must never be a card number: only its last four digits may be kept. */
function safeReference(reference: string | null | undefined): string | null {
  const value = reference?.trim();
  if (!value) return null;
  if (/\b(?:\d[ -]?){13,19}\b/.test(value)) {
    throw validationError(
      'That looks like a card number. Card numbers are never stored here: enter the receipt number or the last four digits.',
    );
  }
  return value.slice(0, 120);
}

/**
 * Records money received. An online payment reported twice by the gateway
 * (same provider and payment id) is recorded once.
 */
export async function recordPayment(
  db: DbOrTx,
  actor: Actor,
  input: PaymentInput,
): Promise<{ payment: PaymentRow; line: FolioLineRow; duplicate: boolean }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw validationError('The amount received must be a whole amount above zero');
  }
  const reference = safeReference(input.reference);
  return transact(db, async (tx) => {
    const folio = await folioForUpdate(tx, actor.orgId, input.folioId);
    if (input.provider && input.providerPaymentId) {
      const [seen] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.provider, input.provider),
            eq(payments.providerPaymentId, input.providerPaymentId),
          ),
        );
      if (seen) {
        const [line] = await tx.select().from(folioLines).where(eq(folioLines.paymentId, seen.id));
        return { payment: seen, line: line!, duplicate: true };
      }
    }
    if (folio.status !== 'open')
      throw invalidState('This folio is closed. Reopen it to take a payment.');
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, folio.propertyId));
    const [payment] = await tx
      .insert(payments)
      .values({
        propertyId: folio.propertyId,
        folioId: folio.id,
        method: input.method,
        status: 'captured',
        amount: input.amount,
        currency: folio.currency,
        reference,
        provider: input.provider ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        providerOrderId: input.providerOrderId ?? null,
        note: input.note?.trim().slice(0, 500) || null,
        receivedBy: actor.userId ?? null,
      })
      .returning();
    const [line] = await tx
      .insert(folioLines)
      .values({
        folioId: folio.id,
        propertyId: folio.propertyId,
        businessDate: input.businessDate ?? businessDateOf(property!),
        kind: 'payment',
        description: `Payment (${METHOD_LABELS[input.method]})${reference ? ` ${reference}` : ''}`,
        amount: -input.amount,
        paymentId: payment!.id,
        source: input.provider ? 'gateway' : 'manual',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.payment_recorded',
      entityType: 'folio',
      entityId: folio.id,
      propertyId: folio.propertyId,
      summary: `Recorded a payment of ${formatMoney(input.amount, folio.currency)} by ${METHOD_LABELS[input.method].toLowerCase()}`,
      changes: { paymentId: payment!.id, method: input.method, amount: input.amount },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId: folio.id, reservationId: folio.reservationId },
      },
    ]);
    return { payment: payment!, line: line!, duplicate: false };
  });
}

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  online: 'Online',
  channel: 'Collected by the channel',
  other: 'Other',
};

/** How much of a payment has not been refunded yet. */
async function refundable(tx: DbOrTx, payment: PaymentRow): Promise<number> {
  const { rows } = await tx.execute<{ refunded: string | null }>(sql`
    SELECT sum(amount)::text AS refunded FROM payments
    WHERE refund_of_payment_id = ${payment.id} AND status = 'captured'
  `);
  return payment.amount + Number(rows[0]?.refunded ?? 0);
}

export interface RefundInput {
  /** Defaults to everything not yet refunded. */
  amount?: number;
  reason: string;
  /** How the money goes back. Defaults to how it came. */
  method?: PaymentMethod;
  reference?: string | null;
}

/**
 * Returns money for a payment, in whole or in part. The total refunded can
 * never exceed what was paid. For an online payment this records the refund;
 * sending it through the gateway is the caller's job, done first.
 */
export async function refundPayment(
  db: DbOrTx,
  actor: Actor,
  paymentId: string,
  input: RefundInput,
): Promise<{ payment: PaymentRow; line: FolioLineRow }> {
  if (!input.reason.trim()) throw validationError('Say why the money is being refunded');
  const reference = safeReference(input.reference);
  return transact(db, async (tx) => {
    const [original] = await tx.select().from(payments).where(eq(payments.id, paymentId));
    if (!original) throw notFound('Payment', paymentId);
    const folio = await folioForUpdate(tx, actor.orgId, original.folioId);
    if (original.amount <= 0 || original.status !== 'captured') {
      throw invalidState('Only a payment that was received can be refunded');
    }
    const left = await refundable(tx, original);
    if (left <= 0) throw conflict('This payment has already been refunded in full');
    const amount = input.amount ?? left;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw validationError('The refund must be a whole amount above zero');
    }
    if (amount > left) {
      throw conflict(
        `Only ${displayMoney(left, folio.currency)} of this payment is left to refund`,
      );
    }
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, folio.propertyId));
    if (folio.status === 'closed') {
      // Money going back means the account is live again until someone closes it.
      await tx
        .update(folios)
        .set({ status: 'open', closedAt: null })
        .where(eq(folios.id, folio.id));
    }
    const method = input.method ?? original.method;
    const [refund] = await tx
      .insert(payments)
      .values({
        propertyId: folio.propertyId,
        folioId: folio.id,
        method,
        status: 'captured',
        amount: -amount,
        currency: folio.currency,
        reference,
        provider: original.provider,
        refundOfPaymentId: original.id,
        note: input.reason.trim().slice(0, 500),
        receivedBy: actor.userId ?? null,
      })
      .returning();
    const [line] = await tx
      .insert(folioLines)
      .values({
        folioId: folio.id,
        propertyId: folio.propertyId,
        businessDate: businessDateOf(property!),
        kind: 'refund',
        description: `Refund (${METHOD_LABELS[method]}): ${input.reason.trim().slice(0, 200)}`,
        amount,
        paymentId: refund!.id,
        source: 'manual',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.payment_refunded',
      entityType: 'folio',
      entityId: folio.id,
      propertyId: folio.propertyId,
      summary: `Refunded ${formatMoney(amount, folio.currency)}: ${input.reason.trim()}`,
      changes: { paymentId: original.id, refundId: refund!.id, amount },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId: folio.id, reservationId: folio.reservationId },
      },
    ]);
    return { payment: refund!, line: line! };
  });
}

/**
 * Moves charges to another folio of the same reservation, for splitting a
 * bill after the fact. Charges already on an invoice stay where they are.
 */
export async function moveLines(
  db: DbOrTx,
  actor: Actor,
  lineIds: string[],
  toFolioId: string,
): Promise<number> {
  if (lineIds.length === 0) return 0;
  return transact(db, async (tx) => {
    const target = await folioForUpdate(tx, actor.orgId, toFolioId);
    if (target.status !== 'open') throw invalidState('The folio to move to is closed');
    const lines = await tx.select().from(folioLines).where(inArray(folioLines.id, lineIds));
    if (lines.length !== lineIds.length) throw notFound('Folio entry');
    const sources = await tx
      .select()
      .from(folios)
      .where(
        inArray(
          folios.id,
          lines.map((l) => l.folioId),
        ),
      );
    for (const line of lines) {
      const source = sources.find((f) => f.id === line.folioId)!;
      if (
        source.propertyId !== target.propertyId ||
        source.reservationId !== target.reservationId
      ) {
        throw validationError('Charges can only be moved between folios of the same reservation');
      }
      if (!isCharge(line.kind))
        throw invalidState('Only charges can be moved; payments stay on their folio');
      if (line.voidedAt) throw invalidState('A voided entry cannot be moved');
      if (line.invoiceId) throw invalidState('A charge that is on an invoice cannot be moved');
      if (source.status !== 'open')
        throw invalidState('A charge on a closed folio cannot be moved');
    }
    await tx.update(folioLines).set({ folioId: toFolioId }).where(inArray(folioLines.id, lineIds));
    await writeAudit(tx, actor, {
      action: 'folio.lines_moved',
      entityType: 'folio',
      entityId: toFolioId,
      propertyId: target.propertyId,
      summary: `Moved ${lines.length} charge(s) to folio "${target.label}"`,
      changes: { lineIds, from: [...new Set(lines.map((l) => l.folioId))] },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: target.propertyId,
        payload: { folioId: toFolioId, reservationId: target.reservationId },
      },
    ]);
    return lines.length;
  });
}

/** A company's running account at a property (its city ledger), created when first needed. */
export async function ensureCompanyAccount(
  tx: Transaction,
  propertyId: string,
  companyId: string,
): Promise<FolioRow> {
  const [existing] = await tx
    .select()
    .from(folios)
    .where(
      and(
        eq(folios.propertyId, propertyId),
        eq(folios.companyId, companyId),
        eq(folios.kind, 'company'),
        isNull(folios.reservationId),
      ),
    );
  if (existing) return existing;
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound('Company', companyId);
  const [property] = await tx.select().from(properties).where(eq(properties.id, propertyId));
  const [created] = await tx
    .insert(folios)
    .values({
      propertyId,
      companyId,
      kind: 'company',
      label: `${company.name} account`,
      currency: property!.currency,
      billTo: billToOfCompany(company),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await tx
    .select()
    .from(folios)
    .where(
      and(
        eq(folios.propertyId, propertyId),
        eq(folios.companyId, companyId),
        eq(folios.kind, 'company'),
        isNull(folios.reservationId),
      ),
    );
  return raced!;
}

/**
 * Moves what is owed on a folio to a company's account, to be paid later
 * ("bill to company"). The folio is left at zero; the company's account
 * carries the amount until it is settled. The company's credit limit, if it
 * has one, is enforced.
 */
export async function transferToCompany(
  db: DbOrTx,
  actor: Actor,
  folioId: string,
  companyId: string,
): Promise<{ amount: number; accountFolioId: string }> {
  return transact(db, async (tx) => {
    const folio = await folioForUpdate(tx, actor.orgId, folioId);
    if (folio.kind === 'company' && folio.reservationId === null) {
      throw validationError('This is already a company account');
    }
    const [company] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.orgId, actor.orgId)))
      .for('update');
    if (!company) throw notFound('Company', companyId);
    if (!company.active) throw invalidState(`${company.name} is no longer active`);
    const lines = await tx.select().from(folioLines).where(eq(folioLines.folioId, folioId));
    const amount = totalsOf(lines).balance;
    if (amount <= 0) throw invalidState('Nothing is owed on this folio');
    const account = await ensureCompanyAccount(tx, folio.propertyId, companyId);
    if (company.creditLimit !== null) {
      const { rows } = await tx.execute<{ owed: string | null }>(sql`
        SELECT sum(l.amount + l.tax_amount)::text AS owed
        FROM folio_lines l JOIN folios f ON f.id = l.folio_id
        WHERE f.company_id = ${companyId} AND f.kind = 'company' AND f.reservation_id IS NULL
          AND l.voided_at IS NULL
      `);
      const owed = Number(rows[0]?.owed ?? 0);
      if (owed + amount > company.creditLimit) {
        throw conflict(
          `${company.name} would exceed its credit limit of ${displayMoney(company.creditLimit, folio.currency)} (already owes ${displayMoney(owed, folio.currency)})`,
        );
      }
    }
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, folio.propertyId));
    const [reservation] = folio.reservationId
      ? await tx.select().from(reservations).where(eq(reservations.id, folio.reservationId))
      : [];
    const date = businessDateOf(property!);
    const what = reservation
      ? `reservation ${reservation.code}, ${reservation.guestName}`
      : folio.label;
    const [out] = await tx
      .insert(folioLines)
      .values({
        folioId: folio.id,
        propertyId: folio.propertyId,
        businessDate: date,
        kind: 'transfer',
        description: `Billed to ${company.name}`,
        amount: -amount,
        source: 'transfer',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })
      .returning();
    const [into] = await tx
      .insert(folioLines)
      .values({
        folioId: account.id,
        propertyId: folio.propertyId,
        businessDate: date,
        kind: 'transfer',
        description: `From ${what}`,
        amount,
        counterpartLineId: out!.id,
        source: 'transfer',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })
      .returning();
    await tx
      .update(folioLines)
      .set({ counterpartLineId: into!.id })
      .where(eq(folioLines.id, out!.id));
    await writeAudit(tx, actor, {
      action: 'folio.billed_to_company',
      entityType: 'folio',
      entityId: folio.id,
      propertyId: folio.propertyId,
      summary: `Billed ${formatMoney(amount, folio.currency)} from ${what} to ${company.name}`,
      changes: { companyId, accountFolioId: account.id, amount },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId: folio.id, reservationId: folio.reservationId },
      },
    ]);
    return { amount, accountFolioId: account.id };
  });
}

/** Closes a folio that owes nothing and is owed nothing. */
export async function closeFolio(db: DbOrTx, actor: Actor, folioId: string): Promise<FolioRow> {
  return transact(db, async (tx) => {
    const folio = await folioForUpdate(tx, actor.orgId, folioId);
    if (folio.status === 'closed') return folio;
    const lines = await tx.select().from(folioLines).where(eq(folioLines.folioId, folioId));
    const { balance } = totalsOf(lines);
    if (balance !== 0) {
      throw invalidState(
        `This folio cannot be closed while ${displayMoney(Math.abs(balance), folio.currency)} is ${balance > 0 ? 'owed' : 'in credit'}`,
      );
    }
    const [closed] = await tx
      .update(folios)
      .set({ status: 'closed', closedAt: new Date() })
      .where(eq(folios.id, folioId))
      .returning();
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: folio.propertyId,
        payload: { folioId, reservationId: folio.reservationId },
      },
    ]);
    return closed!;
  });
}

export async function reopenFolio(db: DbOrTx, actor: Actor, folioId: string): Promise<FolioRow> {
  return transact(db, async (tx) => {
    const folio = await folioForUpdate(tx, actor.orgId, folioId);
    if (folio.status === 'open') return folio;
    const [opened] = await tx
      .update(folios)
      .set({ status: 'open', closedAt: null })
      .where(eq(folios.id, folioId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'folio.reopened',
      entityType: 'folio',
      entityId: folioId,
      propertyId: folio.propertyId,
      summary: `Reopened folio "${folio.label}"`,
    });
    return opened!;
  });
}
