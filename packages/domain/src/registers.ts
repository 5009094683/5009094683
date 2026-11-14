import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  guests,
  invoices,
  onlineCheckins,
  properties,
  reservationRooms,
  reservations,
  units,
  type DbOrTx,
  type InvoiceType,
} from '@pms/db';
import { writeAudit } from './audit';
import type { Actor } from './context';
import { decryptJson, decryptSecret } from './crypto';
import { toCsv, type CsvCell } from './csv';
import { addDays, assertRange, diffDays, type DateString } from './dates';
import { notFound, validationError } from './errors';
import { fullName } from './guests';
import { minorToDecimal } from './money';
import type { CheckinGuest } from './online-checkin';

/**
 * The two lists the authorities ask a property for: what was invoiced, with
 * its tax, and who stayed. Both are files to hand over or to load into the
 * accountant's or the portal's own tools; nothing is filed from here.
 */

const MAX_TAX_REGISTER_DAYS = 800;
const MAX_GUEST_REGISTER_DAYS = 366;

// ---------------------------------------------------------------------------
// Tax register

export interface TaxRegisterRow {
  propertyId: string;
  propertyName: string;
  type: InvoiceType;
  number: string;
  issuedOn: DateString;
  /** For a credit note: the number of the invoice it corrects. */
  againstNumber: string | null;
  sellerGstin: string | null;
  /** Where the service is taxed: the state the property is in. */
  placeOfSupply: string | null;
  buyerName: string;
  buyerGstin: string | null;
  buyerState: string | null;
  /** The service code (SAC) of the lines in this row. */
  serviceCode: string | null;
  /** All tax components together, in basis points. */
  rateBp: number;
  /** Before tax. Negative on a credit note. */
  taxable: number;
  /** Tax by component (CGST, SGST, IGST, ...). */
  taxes: Record<string, number>;
  taxTotal: number;
  total: number;
  reservationCode: string | null;
}

export interface TaxRegisterTotals {
  taxable: number;
  taxes: Record<string, number>;
  taxTotal: number;
  total: number;
}

export interface TaxRegister {
  from: DateString;
  /** Exclusive. */
  to: DateString;
  currency: string | null;
  /** The tax components that occur, in the order of the columns. */
  components: string[];
  /** One row per document, service code and rate: the grain a tax return is filed at. */
  rows: TaxRegisterRow[];
  /** By rate, sales to registered businesses apart from the rest. */
  summary: (TaxRegisterTotals & { rateBp: number; registered: boolean })[];
  total: TaxRegisterTotals & { invoices: number; creditNotes: number };
}

const COMPONENT_ORDER = ['CGST', 'SGST', 'UTGST', 'IGST', 'CESS'];

function addTaxes(into: Record<string, number>, from: Record<string, number>): void {
  for (const [code, amount] of Object.entries(from)) into[code] = (into[code] ?? 0) + amount;
}

/**
 * Every invoice and credit note issued in a period, split by service code and
 * tax rate. Credit notes carry negative amounts, so the totals are what the
 * period nets to.
 */
export async function taxRegister(
  db: DbOrTx,
  orgId: string,
  input: { propertyIds: 'all' | string[]; from: string; to: string },
): Promise<TaxRegister> {
  const { from, to } = assertRange(input.from, input.to, 'period');
  if (diffDays(from, to) > MAX_TAX_REGISTER_DAYS) {
    throw validationError(`The tax register covers at most ${MAX_TAX_REGISTER_DAYS} days`);
  }
  const empty: TaxRegister = {
    from,
    to,
    currency: null,
    components: [],
    rows: [],
    summary: [],
    total: { taxable: 0, taxes: {}, taxTotal: 0, total: 0, invoices: 0, creditNotes: 0 },
  };
  if (input.propertyIds !== 'all' && input.propertyIds.length === 0) return empty;
  const documents = await db
    .select({ invoice: invoices, propertyName: properties.name })
    .from(invoices)
    .innerJoin(properties, eq(properties.id, invoices.propertyId))
    .where(
      and(
        eq(properties.orgId, orgId),
        input.propertyIds === 'all' ? undefined : inArray(invoices.propertyId, input.propertyIds),
        gte(invoices.issuedOn, from),
        lt(invoices.issuedOn, to),
      ),
    )
    .orderBy(asc(properties.name), asc(invoices.issuedOn), asc(invoices.number));
  if (documents.length === 0) return empty;

  const currencies = [...new Set(documents.map((d) => d.invoice.currency))];
  if (currencies.length > 1) {
    throw validationError(
      `These properties invoice in different currencies (${currencies.join(', ')}). Choose properties that share one.`,
    );
  }
  const related = documents.flatMap((d) =>
    d.invoice.relatedInvoiceId ? [d.invoice.relatedInvoiceId] : [],
  );
  const originals = new Map(
    related.length > 0
      ? (
          await db
            .select({ id: invoices.id, number: invoices.number })
            .from(invoices)
            .where(inArray(invoices.id, related))
        ).map((i) => [i.id, i.number])
      : [],
  );

  const rows: TaxRegisterRow[] = [];
  const summary = new Map<string, TaxRegister['summary'][number]>();
  const total = { ...empty.total, taxes: {} as Record<string, number> };
  const seen = new Set<string>();
  for (const { invoice, propertyName } of documents) {
    if (invoice.type === 'credit_note') total.creditNotes++;
    else total.invoices++;
    const groups = new Map<string, TaxRegisterRow>();
    for (const line of invoice.lines) {
      const rateBp = line.taxes.reduce((sum, t) => sum + t.rateBp, 0);
      const key = `${line.serviceCode ?? ''}|${rateBp}`;
      let row = groups.get(key);
      if (!row) {
        row = {
          propertyId: invoice.propertyId,
          propertyName,
          type: invoice.type,
          number: invoice.number,
          issuedOn: invoice.issuedOn,
          againstNumber: invoice.relatedInvoiceId
            ? (originals.get(invoice.relatedInvoiceId) ?? null)
            : null,
          sellerGstin: invoice.seller.gstin,
          placeOfSupply: invoice.seller.stateCode ?? invoice.seller.state,
          buyerName: invoice.buyer.name,
          buyerGstin: invoice.buyer.gstin,
          buyerState: invoice.buyer.stateCode ?? invoice.buyer.state,
          serviceCode: line.serviceCode,
          rateBp,
          taxable: 0,
          taxes: {},
          taxTotal: 0,
          total: 0,
          reservationCode: invoice.reference.reservation ?? null,
        };
        groups.set(key, row);
      }
      row.taxable += line.amount;
      row.taxTotal += line.taxAmount;
      row.total += line.amount + line.taxAmount;
      for (const tax of line.taxes) {
        row.taxes[tax.code] = (row.taxes[tax.code] ?? 0) + tax.amount;
        seen.add(tax.code);
      }
    }
    for (const row of groups.values()) {
      rows.push(row);
      const registered = Boolean(row.buyerGstin);
      const key = `${row.rateBp}|${registered}`;
      const bucket = summary.get(key) ?? {
        rateBp: row.rateBp,
        registered,
        taxable: 0,
        taxes: {},
        taxTotal: 0,
        total: 0,
      };
      for (const target of [bucket, total]) {
        target.taxable += row.taxable;
        target.taxTotal += row.taxTotal;
        target.total += row.total;
        addTaxes(target.taxes, row.taxes);
      }
      summary.set(key, bucket);
    }
  }
  const position = (code: string): number => {
    const index = COMPONENT_ORDER.indexOf(code.toUpperCase());
    return index === -1 ? COMPONENT_ORDER.length : index;
  };
  return {
    from,
    to,
    currency: currencies[0]!,
    components: [...seen].sort((a, b) => position(a) - position(b) || a.localeCompare(b)),
    rows,
    summary: [...summary.values()].sort(
      (a, b) => a.rateBp - b.rateBp || Number(b.registered) - Number(a.registered),
    ),
    total,
  };
}

const DOCUMENT_NAMES: Record<InvoiceType, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
};

export function taxRegisterCsv(register: TaxRegister): { filename: string; csv: string } {
  const currency = register.currency ?? 'INR';
  const money = (amount: number): string => minorToDecimal(amount, currency);
  const header: CsvCell[] = [
    'Property',
    'Document',
    'Number',
    'Date',
    'Against invoice',
    'Seller GSTIN',
    'Place of supply',
    'Customer',
    'Customer GSTIN',
    'Customer state',
    'Service code (SAC)',
    'Tax rate %',
    'Taxable value',
    ...register.components,
    'Tax',
    'Total',
    'Booking',
  ];
  const rows: CsvCell[][] = register.rows.map((r) => [
    r.propertyName,
    DOCUMENT_NAMES[r.type],
    r.number,
    r.issuedOn,
    r.againstNumber,
    r.sellerGstin,
    r.placeOfSupply,
    r.buyerName,
    r.buyerGstin,
    r.buyerState,
    r.serviceCode,
    r.rateBp / 100,
    money(r.taxable),
    ...register.components.map((code) => money(r.taxes[code] ?? 0)),
    money(r.taxTotal),
    money(r.total),
    r.reservationCode,
  ]);
  const t = register.total;
  rows.push([
    'Total',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    money(t.taxable),
    ...register.components.map((code) => money(t.taxes[code] ?? 0)),
    money(t.taxTotal),
    money(t.total),
    null,
  ]);
  return {
    filename: `tax-register-${register.from}-to-${addDays(register.to, -1)}.csv`,
    csv: toCsv([header, ...rows]),
  };
}

// ---------------------------------------------------------------------------
// Guest register

export interface GuestRegisterRow {
  reservationCode: string;
  /** The rooms of the booking that were occupied. */
  rooms: string;
  arrival: DateString;
  departure: DateString;
  /** When the first room was checked in. */
  arrivedAt: Date | null;
  name: string;
  /** Two-letter country code. */
  nationality: string | null;
  /** From another country than the property's: the guests the foreigners' register is about. */
  foreign: boolean;
  dateOfBirth: DateString | null;
  address: string | null;
  idType: string | null;
  idNumber: string | null;
  idExpiry: DateString | null;
  visaNumber: string | null;
  visaExpiry: DateString | null;
  arrivedInCountryOn: DateString | null;
  arrivingFrom: string | null;
  nextDestination: string | null;
  /** The front desk compared these details with the documents shown. */
  verified: boolean;
}

export interface GuestRegister {
  propertyId: string;
  propertyName: string;
  from: DateString;
  /** Exclusive. */
  to: DateString;
  rows: GuestRegisterRow[];
  /** Stays in the period for which nothing beyond the booker's name is on file. */
  withoutDetails: number;
}

/**
 * Everyone who arrived at a property in a period, with the identity and
 * travel details on file: what a property hands to the police or enters in
 * the foreigners' registration portal. It holds identity numbers in the
 * clear, so taking it is recorded.
 */
export async function guestRegister(
  db: DbOrTx,
  actor: Actor,
  input: { propertyId: string; from: string; to: string; foreignOnly?: boolean },
): Promise<GuestRegister> {
  const { from, to } = assertRange(input.from, input.to, 'period');
  if (diffDays(from, to) > MAX_GUEST_REGISTER_DAYS) {
    throw validationError(`The guest register covers at most ${MAX_GUEST_REGISTER_DAYS} days`);
  }
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.orgId, actor.orgId)));
  if (!property) throw notFound('Property', input.propertyId);
  const home = (property.country ?? 'IN').toUpperCase();

  const stays = await db
    .select({
      reservation: reservations,
      guest: guests,
      checkin: onlineCheckins,
      rooms: sql<string>`string_agg(coalesce(${units.name}, 'Room not recorded'), ', ' ORDER BY ${reservationRooms.position})`,
      arrival: sql<DateString>`min(${reservationRooms.checkIn})::text`,
      departure: sql<DateString>`max(${reservationRooms.checkOut})::text`,
      arrivedAt: sql<Date | null>`min(${reservationRooms.checkedInAt})`.mapWith((value) =>
        value ? new Date(String(value)) : null,
      ),
    })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
    .leftJoin(units, eq(units.id, reservationRooms.unitId))
    .leftJoin(guests, eq(guests.id, reservations.guestId))
    .leftJoin(onlineCheckins, eq(onlineCheckins.reservationId, reservations.id))
    .where(
      and(
        eq(reservationRooms.propertyId, property.id),
        // Only guests who came: a booking that is still to arrive, was cancelled or did not show is not a stay.
        inArray(reservationRooms.status, ['in_house', 'checked_out']),
        gte(reservationRooms.checkIn, from),
        lt(reservationRooms.checkIn, to),
      ),
    )
    .groupBy(reservations.id, guests.id, onlineCheckins.id)
    .orderBy(sql`min(${reservationRooms.checkIn})`, asc(reservations.code));

  const rows: GuestRegisterRow[] = [];
  let withoutDetails = 0;
  for (const stay of stays) {
    const shared = {
      reservationCode: stay.reservation.code,
      rooms: stay.rooms,
      arrival: stay.arrival,
      departure: stay.departure,
      arrivedAt: stay.arrivedAt,
    };
    const party: CheckinGuest[] = stay.checkin?.dataEnc
      ? decryptJson<{ guests: CheckinGuest[] }>(stay.checkin.dataEnc).guests
      : [];
    if (party.length > 0) {
      for (const person of party) {
        const nationality = person.nationality?.toUpperCase() ?? null;
        rows.push({
          ...shared,
          name: person.name,
          nationality,
          foreign: nationality !== null && nationality !== home,
          dateOfBirth: person.dateOfBirth ?? null,
          address: person.address ?? null,
          idType: person.idType ?? null,
          idNumber: person.idNumber ?? null,
          idExpiry: person.idExpiry ?? null,
          visaNumber: person.visaNumber ?? null,
          visaExpiry: person.visaExpiry ?? null,
          arrivedInCountryOn: person.arrivedInCountryOn ?? null,
          arrivingFrom: person.arrivingFrom ?? null,
          nextDestination: person.nextDestination ?? null,
          verified: stay.checkin?.status === 'verified',
        });
      }
      continue;
    }
    // Nothing was entered at online check-in: the booker's profile is all there is.
    const guest = stay.guest && !stay.guest.anonymizedAt ? stay.guest : null;
    const nationality = guest?.nationality?.toUpperCase() ?? null;
    const idNumber = guest?.idNumberEnc ? decryptSecret(guest.idNumberEnc) : null;
    if (!idNumber) withoutDetails++;
    rows.push({
      ...shared,
      name: guest ? fullName(guest) : stay.reservation.guestName,
      nationality,
      foreign: nationality !== null && nationality !== home,
      dateOfBirth: guest?.dateOfBirth ?? null,
      address:
        [guest?.addressLine1, guest?.city, guest?.state, guest?.postalCode, guest?.country]
          .filter(Boolean)
          .join(', ') || null,
      idType: guest?.idType ?? null,
      idNumber,
      idExpiry: guest?.idExpiry ?? null,
      visaNumber: null,
      visaExpiry: null,
      arrivedInCountryOn: null,
      arrivingFrom: null,
      nextDestination: null,
      verified: false,
    });
  }
  const listed = input.foreignOnly ? rows.filter((r) => r.foreign) : rows;
  await writeAudit(db, actor, {
    action: 'guest_register.exported',
    entityType: 'property',
    entityId: property.id,
    propertyId: property.id,
    summary: `Took the ${input.foreignOnly ? 'register of foreign guests' : 'guest register'} of ${property.name} for ${from} to ${addDays(to, -1)} (${listed.length} ${listed.length === 1 ? 'guest' : 'guests'})`,
  });
  return {
    propertyId: property.id,
    propertyName: property.name,
    from,
    to,
    rows: listed,
    withoutDetails,
  };
}

const ID_NAMES: Record<string, string> = {
  passport: 'Passport',
  aadhaar: 'Aadhaar',
  driving_licence: 'Driving licence',
  voter_id: 'Voter ID',
  national_id: 'National identity card',
  other: 'Other',
};

export function guestRegisterCsv(register: GuestRegister): { filename: string; csv: string } {
  const header: CsvCell[] = [
    'Booking',
    'Rooms',
    'Arrival',
    'Departure',
    'Checked in at',
    'Guest',
    'Nationality',
    'From abroad',
    'Date of birth',
    'Address',
    'Identity document',
    'Document number',
    'Document valid until',
    'Visa number',
    'Visa valid until',
    'Arrived in the country on',
    'Arriving from',
    'Going on to',
    'Checked against documents',
  ];
  const rows: CsvCell[][] = register.rows.map((r) => [
    r.reservationCode,
    r.rooms,
    r.arrival,
    r.departure,
    r.arrivedAt ? r.arrivedAt.toISOString() : null,
    r.name,
    r.nationality,
    r.foreign ? 'Yes' : 'No',
    r.dateOfBirth,
    r.address,
    r.idType ? (ID_NAMES[r.idType] ?? r.idType) : null,
    r.idNumber,
    r.idExpiry,
    r.visaNumber,
    r.visaExpiry,
    r.arrivedInCountryOn,
    r.arrivingFrom,
    r.nextDestination,
    r.verified ? 'Yes' : 'No',
  ]);
  return {
    filename: `guest-register-${register.from}-to-${addDays(register.to, -1)}.csv`,
    csv: toCsv([header, ...rows]),
  };
}
