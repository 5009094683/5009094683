import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, emptyJson, id, money, timestamptz, updatedAt } from './_shared';
import {
  COMPANY_KINDS,
  FOLIO_KINDS,
  FOLIO_LINE_KINDS,
  FOLIO_STATUSES,
  HOUSEKEEPING_TASK_KINDS,
  INVOICE_TYPES,
  MAINTENANCE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PRIORITIES,
  TASK_STATUSES,
  TAX_CATEGORIES,
  sqlList,
  type CompanyKind,
  type FolioKind,
  type FolioLineKind,
  type FolioStatus,
  type HousekeepingTaskKind,
  type InvoiceType,
  type MaintenanceStatus,
  type PaymentMethod,
  type PaymentStatus,
  type Priority,
  type TaskStatus,
  type TaxCategory,
} from './enums';
import { organizations, users } from './identity';
import { properties, units } from './inventory';
import { inventoryBlocks, reservationRooms, reservations } from './reservations';

/** A company or travel agent that books on account and is billed afterwards. */
export const companies = pgTable(
  'companies',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<CompanyKind>().notNull().default('corporate'),
    name: text('name').notNull(),
    /** Name as it must appear on tax invoices, when different. */
    legalName: text('legal_name'),
    gstin: text('gstin'),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    stateCode: text('state_code'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('IN'),
    email: citext('email'),
    phone: text('phone'),
    contactName: text('contact_name'),
    /** The most that may be outstanding on account. Null: no limit. */
    creditLimit: money('credit_limit'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    /** Commission kept by a travel agent, in basis points of room revenue. */
    commissionBp: integer('commission_bp').notNull().default(0),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('companies_org_name_idx').on(t.orgId, t.name),
    check('companies_kind_check', sql.raw(`kind IN (${sqlList(COMPANY_KINDS)})`)),
  ],
);

export interface TaxSlab {
  /** The rule applies up to and including this amount per unit per night (minor units). Null: no upper limit. */
  upTo: number | null;
  /** Rate in basis points: 500 is 5%. */
  rateBp: number;
}

export interface TaxComponent {
  /** Shown on invoices, e.g. CGST, SGST, VAT. */
  code: string;
  /** Share of the rate, in basis points of the whole: two components of 5000 split it in half. */
  shareBp: number;
}

/**
 * How one category of charge is taxed at a property. The rate can depend on
 * the price (India's accommodation slabs), and can be split into components
 * that invoices must show separately (CGST and SGST).
 */
export const taxRules = pgTable(
  'tax_rules',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    category: text('category').$type<TaxCategory>().notNull(),
    name: text('name').notNull(),
    /** Service accounting code printed on invoices (SAC in India). */
    serviceCode: text('service_code'),
    slabs: jsonb('slabs').$type<TaxSlab[]>().notNull(),
    components: jsonb('components').$type<TaxComponent[]>().notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tax_rules_property_category_key')
      .on(t.propertyId, t.category)
      .where(sql`active`),
    check('tax_rules_category_check', sql.raw(`category IN (${sqlList(TAX_CATEGORIES)})`)),
  ],
);

export interface BillTo {
  name: string;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
  gstin?: string | null;
  email?: string | null;
}

/**
 * An account of what a stay (or a company) owes and has paid. A reservation
 * has one guest folio from the start and may have more, for split billing.
 */
export const folios = pgTable(
  'folios',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'restrict',
    }),
    /** Set on a company's account (city ledger), and on a stay folio billed to a company. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<FolioKind>().notNull().default('guest'),
    /** "Room charges", "Extras", "Acme Corp account". */
    label: text('label').notNull(),
    status: text('status').$type<FolioStatus>().notNull().default('open'),
    currency: text('currency').notNull(),
    billTo: jsonb('bill_to').$type<BillTo>().notNull(),
    /** Charge kinds that are posted here rather than to the reservation's first folio. */
    routes: jsonb('routes')
      .$type<FolioLineKind[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: timestamptz('closed_at'),
  },
  (t) => [
    index('folios_reservation_idx').on(t.reservationId),
    index('folios_company_idx').on(t.companyId),
    // One running account per company per property.
    uniqueIndex('folios_company_account_key')
      .on(t.propertyId, t.companyId)
      .where(sql`kind = 'company' AND reservation_id IS NULL`),
    check('folios_kind_check', sql.raw(`kind IN (${sqlList(FOLIO_KINDS)})`)),
    check('folios_status_check', sql.raw(`status IN (${sqlList(FOLIO_STATUSES)})`)),
  ],
);

export interface LineTax {
  code: string;
  rateBp: number;
  amount: number;
}

/**
 * One entry on a folio. Nothing is ever edited or deleted: a wrong entry is
 * voided, which keeps it visible with who voided it and why.
 *
 * `amount` is before tax and signed: a charge is positive; a payment, a
 * discount and a transfer out are negative. `taxAmount` carries the same sign.
 */
export const folioLines = pgTable(
  'folio_lines',
  {
    id: id(),
    folioId: uuid('folio_id')
      .notNull()
      .references(() => folios.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    /** The hotel day the entry belongs to. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<FolioLineKind>().notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(1),
    amount: money('amount').notNull(),
    taxAmount: money('tax_amount').notNull().default(0),
    taxes: jsonb('taxes')
      .$type<LineTax[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    serviceCode: text('service_code'),
    /** For room charges: the room and night charged. */
    reservationRoomId: uuid('reservation_room_id').references(() => reservationRooms.id, {
      onDelete: 'restrict',
    }),
    paymentId: uuid('payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'restrict',
    }),
    /** Set once the line has been put on an invoice; it can then only be corrected by a credit note. */
    invoiceId: uuid('invoice_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    /** For a transfer: the matching entry on the other folio. */
    counterpartLineId: uuid('counterpart_line_id'),
    source: text('source').notNull().default('manual'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedByLabel: text('posted_by_label'),
    voidedAt: timestamptz('voided_at'),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),
    createdAt: createdAt(),
    /** Order of entry. Entries made in one transaction share a timestamp; this tells them apart. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('folio_lines_folio_idx').on(t.folioId, t.businessDate),
    index('folio_lines_property_date_idx').on(t.propertyId, t.businessDate),
    // A room is charged for a night once, however often the night audit is run.
    uniqueIndex('folio_lines_room_night_key')
      .on(t.reservationRoomId, t.businessDate)
      .where(sql`kind = 'room' AND voided_at IS NULL`),
    check('folio_lines_kind_check', sql.raw(`kind IN (${sqlList(FOLIO_LINE_KINDS)})`)),
    check('folio_lines_quantity_check', sql`quantity >= 1`),
  ],
);

/** Money received or returned. Each has a matching folio line; this row holds how it was paid. */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    folioId: uuid('folio_id')
      .notNull()
      .references(() => folios.id, { onDelete: 'restrict' }),
    method: text('method').$type<PaymentMethod>().notNull(),
    status: text('status').$type<PaymentStatus>().notNull().default('captured'),
    /** Positive for money received, negative for a refund. */
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    /** Receipt number, UPI reference, last four digits: whatever identifies it to staff. Never a card number. */
    reference: text('reference'),
    /** For online payments: the gateway and its identifiers. */
    provider: text('provider'),
    providerPaymentId: text('provider_payment_id'),
    providerOrderId: text('provider_order_id'),
    /** For a refund: the payment being returned. */
    refundOfPaymentId: uuid('refund_of_payment_id').references((): AnyPgColumn => payments.id, {
      onDelete: 'restrict',
    }),
    note: text('note'),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_folio_idx').on(t.folioId),
    uniqueIndex('payments_provider_key')
      .on(t.provider, t.providerPaymentId)
      .where(sql`provider_payment_id IS NOT NULL`),
    check('payments_method_check', sql.raw(`method IN (${sqlList(PAYMENT_METHODS)})`)),
    check('payments_status_check', sql.raw(`status IN (${sqlList(PAYMENT_STATUSES)})`)),
    check('payments_amount_check', sql`amount <> 0`),
  ],
);

export interface InvoiceParty {
  name: string;
  address: string | null;
  gstin: string | null;
  state: string | null;
  stateCode: string | null;
  country: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface InvoiceLine {
  date: string;
  description: string;
  serviceCode: string | null;
  quantity: number;
  /** Before tax. */
  amount: number;
  taxes: LineTax[];
  taxAmount: number;
}

export interface InvoiceTotals {
  /** Sum of line amounts before tax. */
  taxable: number;
  /** Tax by component code. */
  taxes: Record<string, number>;
  taxTotal: number;
  total: number;
}

/**
 * A tax invoice or credit note. Once issued it is never changed: it holds a
 * copy of everything printed on it, so later edits to a guest, a company or
 * a property cannot alter what was issued. A mistake is corrected with a
 * credit note that refers to it.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    folioId: uuid('folio_id')
      .notNull()
      .references(() => folios.id, { onDelete: 'restrict' }),
    type: text('type').$type<InvoiceType>().notNull(),
    /** Consecutive within the property, the series and the financial year, with no gaps. */
    number: text('number').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    sequence: integer('sequence').notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    /** For a credit note: the invoice it corrects. */
    relatedInvoiceId: uuid('related_invoice_id').references((): AnyPgColumn => invoices.id, {
      onDelete: 'restrict',
    }),
    reason: text('reason'),
    currency: text('currency').notNull(),
    seller: jsonb('seller').$type<InvoiceParty>().notNull(),
    buyer: jsonb('buyer').$type<InvoiceParty>().notNull(),
    lines: jsonb('lines').$type<InvoiceLine[]>().notNull(),
    totals: jsonb('totals').$type<InvoiceTotals>().notNull(),
    /** Reservation code, stay dates, guest: printed for reference. */
    reference: jsonb('reference')
      .$type<Record<string, string | null>>()
      .notNull()
      .default(emptyJson),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invoices_property_number_key').on(t.propertyId, t.number),
    uniqueIndex('invoices_sequence_key').on(t.propertyId, t.type, t.fiscalYear, t.sequence),
    index('invoices_folio_idx').on(t.folioId),
    index('invoices_property_date_idx').on(t.propertyId, t.issuedOn),
    check('invoices_type_check', sql.raw(`type IN (${sqlList(INVOICE_TYPES)})`)),
  ],
);

/** The last number used in each invoice series. Locked while a number is taken, so numbers never repeat or skip. */
export const invoiceSequences = pgTable(
  'invoice_sequences',
  {
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    type: text('type').$type<InvoiceType>().notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.type, t.fiscalYear] })],
);

export interface NightAuditSummary {
  roomChargesPosted: number;
  roomRevenue: number;
  noShows: string[];
  /** Guests due to arrive who had not, and were left as they are. */
  pendingArrivals: string[];
  /** Guests due to leave who are still checked in. */
  overdueDepartures: string[];
  stayovers: number;
  housekeepingTasks: number;
  warnings: string[];
}

/** One closing of a hotel day. */
export const nightAudits = pgTable(
  'night_audits',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    /** The day that was closed. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: text('status').$type<'completed' | 'failed'>().notNull(),
    summary: jsonb('summary').$type<NightAuditSummary>().notNull(),
    error: text('error'),
    runBy: uuid('run_by').references(() => users.id, { onDelete: 'set null' }),
    runByLabel: text('run_by_label').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    completedAt: timestamptz('completed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('night_audits_day_key')
      .on(t.propertyId, t.businessDate)
      .where(sql`status = 'completed'`),
    index('night_audits_property_idx').on(t.propertyId, t.businessDate.desc()),
  ],
);

/**
 * What each closed day looked like, kept so reports stay fast and stay the
 * same however reservations are edited afterwards.
 */
export const dailyStats = pgTable(
  'daily_stats',
  {
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    /** Rooms that exist, less those out of order. */
    availableRooms: integer('available_rooms').notNull(),
    soldRooms: integer('sold_rooms').notNull(),
    outOfOrder: integer('out_of_order').notNull().default(0),
    arrivals: integer('arrivals').notNull().default(0),
    departures: integer('departures').notNull().default(0),
    noShows: integer('no_shows').notNull().default(0),
    cancellations: integer('cancellations').notNull().default(0),
    /** Before tax. */
    roomRevenue: money('room_revenue').notNull().default(0),
    otherRevenue: money('other_revenue').notNull().default(0),
    taxAmount: money('tax_amount').notNull().default(0),
    paymentsReceived: money('payments_received').notNull().default(0),
    /** Rooms sold and room revenue by channel code ("DIRECT" for none). */
    byChannel: jsonb('by_channel')
      .$type<Record<string, { rooms: number; revenue: number }>>()
      .notNull()
      .default(emptyJson),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.date] })],
);

export const housekeepingTasks = pgTable(
  'housekeeping_tasks',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'cascade' }),
    /** The day the work is for. */
    date: date('date', { mode: 'string' }).notNull(),
    kind: text('kind').$type<HousekeepingTaskKind>().notNull(),
    status: text('status').$type<TaskStatus>().notNull().default('pending'),
    priority: text('priority').$type<Priority>().notNull().default('normal'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One task of a kind per unit per day: generating the day's list twice adds nothing.
    uniqueIndex('housekeeping_tasks_unit_day_key').on(t.unitId, t.date, t.kind),
    index('housekeeping_tasks_property_day_idx').on(t.propertyId, t.date),
    check(
      'housekeeping_tasks_kind_check',
      sql.raw(`kind IN (${sqlList(HOUSEKEEPING_TASK_KINDS)})`),
    ),
    check('housekeeping_tasks_status_check', sql.raw(`status IN (${sqlList(TASK_STATUSES)})`)),
    check('housekeeping_tasks_priority_check', sql.raw(`priority IN (${sqlList(PRIORITIES)})`)),
  ],
);

export const maintenanceIssues = pgTable(
  'maintenance_issues',
  {
    id: id(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    /** Null for something that is not in a room: the lift, the pool pump. */
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    priority: text('priority').$type<Priority>().notNull().default('normal'),
    status: text('status').$type<MaintenanceStatus>().notNull().default('open'),
    /** The date block that keeps the unit off sale while this is being fixed. */
    blockId: uuid('block_id').references(() => inventoryBlocks.id, { onDelete: 'set null' }),
    reportedBy: uuid('reported_by').references(() => users.id, { onDelete: 'set null' }),
    reportedByLabel: text('reported_by_label'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
    resolvedAt: timestamptz('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('maintenance_issues_property_idx').on(t.propertyId, t.status),
    index('maintenance_issues_unit_idx').on(t.unitId),
    check(
      'maintenance_issues_status_check',
      sql.raw(`status IN (${sqlList(MAINTENANCE_STATUSES)})`),
    ),
    check('maintenance_issues_priority_check', sql.raw(`priority IN (${sqlList(PRIORITIES)})`)),
  ],
);
