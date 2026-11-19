import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  folioLines,
  folios,
  invoices,
  properties,
  reservations,
  type BillTo,
  type DbOrTx,
  type InvoiceLine,
  type InvoiceParty,
  type InvoiceTotals,
  type InvoiceType,
  type Transaction,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import type { DateString } from './dates';
import { conflict, invalidState, notFound, validationError } from './errors';
import { businessDateOf, CHARGE_KINDS } from './folios';
import { emit } from './outbox';
import { transact } from './sqlx';

export type InvoiceRow = typeof invoices.$inferSelect;
type PropertyRow = typeof properties.$inferSelect;

/**
 * The financial year a date falls in, as invoices number by it. India's runs
 * from April to March and is written "26-27"; elsewhere the calendar year.
 */
export function fiscalYearOf(date: DateString, country: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (country.toUpperCase() !== 'IN') return String(year);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

/**
 * The printed number: prefix, year, running number, e.g. `SBC/26-27/00042`,
 * and `SBC/26-27/C0007` for a credit note. Kept to 16 characters, the most a
 * GST invoice number may have.
 */
export function invoiceNumber(
  property: Pick<PropertyRow, 'code' | 'settings'>,
  type: InvoiceType,
  fiscalYear: string,
  sequence: number,
): string {
  const prefix = (property.settings.invoicePrefix ?? property.code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  const running = String(sequence).padStart(type === 'credit_note' ? 4 : 5, '0');
  const number = `${prefix}/${fiscalYear}/${type === 'credit_note' ? 'C' : ''}${running}`;
  // A number that outgrows its padding still has to fit: shorten the prefix, never the number.
  return number.length <= 16 ? number : number.slice(number.length - 16).replace(/^\//, '');
}

/** Takes the next number of a series. The row lock means two invoices never get the same one, and none is skipped. */
async function nextSequence(
  tx: Transaction,
  propertyId: string,
  type: InvoiceType,
  fiscalYear: string,
): Promise<number> {
  const { rows } = await tx.execute<{ last_number: number }>(sql`
    INSERT INTO invoice_sequences (property_id, type, fiscal_year, last_number)
    VALUES (${propertyId}, ${type}, ${fiscalYear}, 1)
    ON CONFLICT (property_id, type, fiscal_year)
      DO UPDATE SET last_number = invoice_sequences.last_number + 1
    RETURNING last_number
  `);
  return rows[0]!.last_number;
}

function sellerOf(property: PropertyRow): InvoiceParty {
  return {
    name: property.legalName ?? property.name,
    address:
      [property.addressLine1, property.addressLine2, property.city, property.postalCode]
        .filter(Boolean)
        .join(', ') || null,
    gstin: property.gstin,
    state: property.state,
    stateCode: property.stateCode,
    country: property.country,
    email: property.email,
    phone: property.phone,
  };
}

function buyerOf(billTo: BillTo): InvoiceParty {
  return {
    name: billTo.name,
    address:
      [billTo.addressLine1, billTo.city, billTo.postalCode].filter(Boolean).join(', ') || null,
    gstin: billTo.gstin ?? null,
    state: billTo.state ?? null,
    stateCode: billTo.stateCode ?? null,
    country: billTo.country ?? null,
    email: billTo.email ?? null,
  };
}

export function totalsOfInvoice(lines: InvoiceLine[]): InvoiceTotals {
  const taxes: Record<string, number> = {};
  let taxable = 0;
  let taxTotal = 0;
  for (const line of lines) {
    taxable += line.amount;
    taxTotal += line.taxAmount;
    for (const tax of line.taxes) taxes[tax.code] = (taxes[tax.code] ?? 0) + tax.amount;
  }
  return { taxable, taxes, taxTotal, total: taxable + taxTotal };
}

export interface IssueInvoiceInput {
  /** Charges to put on the invoice. Default: every charge on the folio not yet invoiced. */
  lineIds?: string[];
  /** Overrides who the invoice is made out to (for example, to add a company's GSTIN at check-out). */
  billTo?: BillTo;
}

/**
 * Issues a tax invoice for charges on a folio. Each charge can be invoiced
 * once; an invoice, once issued, is never altered.
 */
export async function issueInvoice(
  db: DbOrTx,
  actor: Actor,
  folioId: string,
  input: IssueInvoiceInput = {},
): Promise<InvoiceRow> {
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ folio: folios, property: properties })
      .from(folios)
      .innerJoin(properties, eq(properties.id, folios.propertyId))
      .where(and(eq(folios.id, folioId), eq(properties.orgId, actor.orgId)))
      .for('update', { of: folios });
    if (!row) throw notFound('Folio', folioId);
    const { folio, property } = row;
    const candidates = await tx
      .select()
      .from(folioLines)
      .where(
        and(
          eq(folioLines.folioId, folioId),
          isNull(folioLines.voidedAt),
          isNull(folioLines.invoiceId),
          inArray(folioLines.kind, [...CHARGE_KINDS]),
        ),
      )
      .orderBy(asc(folioLines.businessDate), asc(folioLines.seq));
    const chosen = input.lineIds
      ? candidates.filter((l) => input.lineIds!.includes(l.id))
      : candidates;
    if (input.lineIds && chosen.length !== input.lineIds.length) {
      throw validationError(
        'Some of those charges are voided, already invoiced, or not on this folio',
      );
    }
    if (chosen.length === 0) throw invalidState('There is nothing on this folio left to invoice');

    const billTo = input.billTo ?? folio.billTo;
    if (!billTo.name?.trim())
      throw validationError('The invoice needs the name of who it is made out to');
    if (billTo.gstin && !/^[0-9A-Z]{15}$/.test(billTo.gstin.toUpperCase())) {
      throw validationError('A GSTIN is 15 letters and digits');
    }
    const lines: InvoiceLine[] = chosen.map((l) => ({
      date: l.businessDate,
      description: l.description,
      serviceCode: l.serviceCode,
      quantity: l.quantity,
      amount: l.amount,
      taxes: l.taxes,
      taxAmount: l.taxAmount,
    }));
    const totals = totalsOfInvoice(lines);
    if (totals.total < 0) throw invalidState('An invoice cannot be for a negative amount');

    const issuedOn = businessDateOf(property);
    const fiscalYear = fiscalYearOf(issuedOn, property.country);
    const sequence = await nextSequence(tx, property.id, 'invoice', fiscalYear);
    const [reservation] = folio.reservationId
      ? await tx.select().from(reservations).where(eq(reservations.id, folio.reservationId))
      : [];
    const [invoice] = await tx
      .insert(invoices)
      .values({
        propertyId: property.id,
        folioId,
        type: 'invoice',
        number: invoiceNumber(property, 'invoice', fiscalYear, sequence),
        fiscalYear,
        sequence,
        issuedOn,
        currency: folio.currency,
        seller: sellerOf(property),
        buyer: buyerOf({ ...billTo, gstin: billTo.gstin?.toUpperCase() ?? null }),
        lines,
        totals,
        reference: reservation
          ? {
              reservation: reservation.code,
              guest: reservation.guestName,
              arrival: reservation.checkIn,
              departure: reservation.checkOut,
              channelReference: reservation.channelReservationCode,
            }
          : {},
        createdBy: actor.userId ?? null,
      })
      .returning();
    await tx
      .update(folioLines)
      .set({ invoiceId: invoice!.id })
      .where(
        inArray(
          folioLines.id,
          chosen.map((l) => l.id),
        ),
      );
    await writeAudit(tx, actor, {
      action: 'invoice.issued',
      entityType: 'invoice',
      entityId: invoice!.id,
      propertyId: property.id,
      summary: `Issued invoice ${invoice!.number} to ${billTo.name}`,
      changes: { total: totals.total, lines: lines.length },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: property.id,
        payload: { folioId, reservationId: folio.reservationId },
      },
    ]);
    return invoice!;
  });
}

export interface CreditNoteInput {
  reason: string;
  /**
   * Which lines of the invoice to credit, by their position on it, and how
   * much of each before tax. Default: the whole invoice.
   */
  lines?: { index: number; amount?: number }[];
}

/**
 * Issues a credit note against an invoice: the only way to correct one. The
 * credited amount, with its tax, is taken off the folio. Credit notes
 * against one invoice can never add up to more than the invoice.
 */
export async function issueCreditNote(
  db: DbOrTx,
  actor: Actor,
  invoiceId: string,
  input: CreditNoteInput,
): Promise<InvoiceRow> {
  if (!input.reason.trim()) throw validationError('A credit note needs a reason');
  return transact(db, async (tx) => {
    const [row] = await tx
      .select({ invoice: invoices, property: properties })
      .from(invoices)
      .innerJoin(properties, eq(properties.id, invoices.propertyId))
      .where(and(eq(invoices.id, invoiceId), eq(properties.orgId, actor.orgId)))
      .for('update', { of: invoices });
    if (!row) throw notFound('Invoice', invoiceId);
    const { invoice, property } = row;
    if (invoice.type !== 'invoice')
      throw invalidState('A credit note can only be issued against an invoice');

    const earlier = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.relatedInvoiceId, invoiceId), eq(invoices.type, 'credit_note')));
    const creditedSoFar = earlier.reduce((sum, c) => sum - c.totals.taxable, 0);

    const wanted: { index: number; amount?: number }[] =
      input.lines ?? invoice.lines.map((_, index) => ({ index }));
    const lines: InvoiceLine[] = wanted.map(({ index, amount }) => {
      const original = invoice.lines[index];
      if (!original) throw validationError(`The invoice has no line ${index + 1}`);
      const credit = amount ?? original.amount;
      if (!Number.isInteger(credit) || credit <= 0 || credit > Math.abs(original.amount)) {
        throw validationError(
          `The credit for "${original.description}" must be above zero and no more than the amount invoiced`,
        );
      }
      // Tax is credited in the same proportion, component by component.
      const taxes = original.taxes.map((t) => ({
        code: t.code,
        rateBp: t.rateBp,
        amount: -Math.round((t.amount * credit) / original.amount),
      }));
      return {
        date: original.date,
        description: original.description,
        serviceCode: original.serviceCode,
        quantity: original.quantity,
        amount: -credit,
        taxes,
        taxAmount: taxes.reduce((sum, t) => sum + t.amount, 0),
      };
    });
    const totals = totalsOfInvoice(lines);
    if (creditedSoFar - totals.taxable > invoice.totals.taxable) {
      throw conflict('Credit notes against this invoice would add up to more than the invoice');
    }

    const issuedOn = businessDateOf(property);
    const fiscalYear = fiscalYearOf(issuedOn, property.country);
    const sequence = await nextSequence(tx, property.id, 'credit_note', fiscalYear);
    const [credit] = await tx
      .insert(invoices)
      .values({
        propertyId: property.id,
        folioId: invoice.folioId,
        type: 'credit_note',
        number: invoiceNumber(property, 'credit_note', fiscalYear, sequence),
        fiscalYear,
        sequence,
        issuedOn,
        relatedInvoiceId: invoice.id,
        reason: input.reason.trim().slice(0, 500),
        currency: invoice.currency,
        seller: invoice.seller,
        buyer: invoice.buyer,
        lines,
        totals,
        reference: { ...invoice.reference, invoice: invoice.number },
        createdBy: actor.userId ?? null,
      })
      .returning();
    // The folio is reduced by what was credited. These entries belong to the credit note.
    await tx.insert(folioLines).values(
      lines.map((l) => ({
        folioId: invoice.folioId,
        propertyId: property.id,
        businessDate: issuedOn,
        kind: 'discount' as const,
        description: `Credit note ${credit!.number}: ${l.description}`.slice(0, 300),
        quantity: 1,
        amount: l.amount,
        taxAmount: l.taxAmount,
        taxes: l.taxes,
        serviceCode: l.serviceCode,
        invoiceId: credit!.id,
        source: 'credit_note',
        postedBy: actor.userId ?? null,
        postedByLabel: actor.label,
      })),
    );
    const [folio] = await tx.select().from(folios).where(eq(folios.id, invoice.folioId));
    if (folio?.status === 'closed') {
      // The credit leaves the folio in the guest's favour: it is open again until that is settled.
      await tx
        .update(folios)
        .set({ status: 'open', closedAt: null })
        .where(eq(folios.id, folio.id));
    }
    await writeAudit(tx, actor, {
      action: 'invoice.credit_note_issued',
      entityType: 'invoice',
      entityId: credit!.id,
      propertyId: property.id,
      summary: `Issued credit note ${credit!.number} against invoice ${invoice.number}: ${input.reason.trim()}`,
      changes: { total: totals.total },
    });
    await emit(tx, actor.orgId, [
      {
        kind: 'folio.updated',
        propertyId: property.id,
        payload: { folioId: invoice.folioId, reservationId: folio?.reservationId ?? null },
      },
    ]);
    return credit!;
  });
}

export async function getInvoice(
  db: DbOrTx,
  orgId: string,
  invoiceId: string,
): Promise<InvoiceRow> {
  const [row] = await db
    .select({ invoice: invoices })
    .from(invoices)
    .innerJoin(properties, eq(properties.id, invoices.propertyId))
    .where(and(eq(invoices.id, invoiceId), eq(properties.orgId, orgId)));
  if (!row) throw notFound('Invoice', invoiceId);
  return row.invoice;
}

export interface InvoiceFilter {
  propertyIds: string[] | 'all';
  folioId?: string;
  from?: DateString;
  to?: DateString;
  type?: InvoiceType;
  limit?: number;
}

export async function listInvoices(
  db: DbOrTx,
  orgId: string,
  filter: InvoiceFilter,
): Promise<InvoiceRow[]> {
  if (filter.propertyIds !== 'all' && filter.propertyIds.length === 0) return [];
  const rows = await db
    .select({ invoice: invoices })
    .from(invoices)
    .innerJoin(properties, eq(properties.id, invoices.propertyId))
    .where(
      and(
        eq(properties.orgId, orgId),
        filter.propertyIds === 'all' ? undefined : inArray(invoices.propertyId, filter.propertyIds),
        filter.folioId ? eq(invoices.folioId, filter.folioId) : undefined,
        filter.from ? gte(invoices.issuedOn, filter.from) : undefined,
        filter.to ? lte(invoices.issuedOn, filter.to) : undefined,
        filter.type ? eq(invoices.type, filter.type) : undefined,
      ),
    )
    .orderBy(desc(invoices.issuedOn), desc(invoices.createdAt))
    .limit(Math.min(filter.limit ?? 100, 1000));
  return rows.map((r) => r.invoice);
}
