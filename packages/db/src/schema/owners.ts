import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, id, money, timestamptz, updatedAt } from './_shared';
import {
  OWNER_CONTRACT_MODELS,
  OWNER_EXPENSE_CATEGORIES,
  OWNER_FEE_BASES,
  OWNER_STATEMENT_STATUSES,
  REPORT_FREQUENCIES,
  REPORT_KINDS,
  REPORT_PERIODS,
  sqlList,
  type OwnerContractModel,
  type OwnerExpenseCategory,
  type OwnerFeeBasis,
  type OwnerStatementStatus,
  type ReportFrequency,
  type ReportKind,
  type ReportPeriod,
} from './enums';
import { organizations, users } from './identity';
import { properties, units } from './inventory';
import { maintenanceIssues } from './operations';

/** Someone whose villa or rooms the chain manages and sells on their behalf. */
export const owners = pgTable(
  'owners',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Name as it must appear on statements, when different. */
    legalName: text('legal_name'),
    email: citext('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('IN'),
    gstin: text('gstin'),
    /** The sign-in this owner uses for the owner portal, if they have one. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('owners_org_name_idx').on(t.orgId, t.name),
    uniqueIndex('owners_user_key')
      .on(t.userId)
      .where(sql`user_id IS NOT NULL`),
  ],
);

/** The terms on which a property, or one unit of it, is managed for its owner. */
export const ownerContracts = pgTable(
  'owner_contracts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    /** One unit (with the units inside it, for a villa sold by the room). Null: the whole property. */
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** The last day the contract covers. Null: until further notice. */
    endsOn: date('ends_on', { mode: 'string' }),
    model: text('model').$type<OwnerContractModel>().notNull().default('revenue_share'),
    /** What management keeps, in basis points of the fee basis. */
    managementFeeBp: integer('management_fee_bp').notNull().default(2000),
    feeBasis: text('fee_basis').$type<OwnerFeeBasis>().notNull().default('net'),
    /** Tax charged to the owner on the management fee, in basis points (GST on the service). */
    feeTaxBp: integer('fee_tax_bp').notNull().default(1800),
    /** Whether booking sites' and travel agents' commission is taken off the owner's share. */
    commissionOnOwner: boolean('commission_on_owner').notNull().default(true),
    /** For `fixed_rent`: the amount a month. */
    fixedRent: money('fixed_rent'),
    /** Nights a year the owner may stay. Null: no limit. */
    ownerNightsPerYear: integer('owner_nights_per_year'),
    /** How many days ahead the owner must ask for dates. */
    ownerStayNoticeDays: integer('owner_stay_notice_days').notNull().default(0),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('owner_contracts_owner_idx').on(t.ownerId),
    index('owner_contracts_property_idx').on(t.propertyId, t.unitId),
    check('owner_contracts_model_check', sql.raw(`model IN (${sqlList(OWNER_CONTRACT_MODELS)})`)),
    check('owner_contracts_basis_check', sql.raw(`fee_basis IN (${sqlList(OWNER_FEE_BASES)})`)),
    check('owner_contracts_dates_check', sql`ends_on IS NULL OR ends_on >= starts_on`),
    check(
      'owner_contracts_rates_check',
      sql`management_fee_bp BETWEEN 0 AND 10000 AND fee_tax_bp BETWEEN 0 AND 10000`,
    ),
    check(
      'owner_contracts_rent_check',
      sql`(model = 'fixed_rent') = (fixed_rent IS NOT NULL) AND (fixed_rent IS NULL OR fixed_rent >= 0)`,
    ),
    check(
      'owner_contracts_stay_check',
      sql`(owner_nights_per_year IS NULL OR owner_nights_per_year >= 0) AND owner_stay_notice_days >= 0`,
    ),
  ],
);

export interface StatementStay {
  reservationCode: string;
  /** Booking site code, or how the booking came. */
  source: string;
  unitName: string | null;
  checkIn: string;
  checkOut: string;
  /** Nights of the stay that fall in the statement's period. */
  nights: number;
  revenue: number;
  commission: number;
}

export interface StatementExpense {
  id: string;
  date: string;
  category: OwnerExpenseCategory;
  description: string;
  amount: number;
}

export interface StatementAdjustment {
  description: string;
  /** Positive: added to what the owner receives. Negative: taken off. */
  amount: number;
}

export interface StatementLines {
  stays: StatementStay[];
  expenses: StatementExpense[];
  adjustments: StatementAdjustment[];
}

/** What an owner is due for a month, with the stays and costs it was worked out from. */
export const ownerStatements = pgTable(
  'owner_statements',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owners.id, { onDelete: 'restrict' }),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => ownerContracts.id, { onDelete: 'restrict' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    /** Exclusive. */
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    /** Given when the statement is issued. */
    number: text('number'),
    status: text('status').$type<OwnerStatementStatus>().notNull().default('draft'),
    currency: text('currency').notNull(),
    roomNights: integer('room_nights').notNull().default(0),
    /** Room revenue before tax for the nights guests stayed. */
    grossRevenue: money('gross_revenue').notNull().default(0),
    channelCommission: money('channel_commission').notNull().default(0),
    managementFee: money('management_fee').notNull().default(0),
    feeTax: money('fee_tax').notNull().default(0),
    expenses: money('expenses').notNull().default(0),
    adjustments: money('adjustments').notNull().default(0),
    /** What the owner receives. Negative when costs exceeded earnings. */
    payout: money('payout').notNull().default(0),
    lines: jsonb('lines').$type<StatementLines>().notNull(),
    notes: text('notes'),
    issuedAt: timestamptz('issued_at'),
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestamptz('paid_at'),
    /** The bank's reference for the transfer. */
    paymentReference: text('payment_reference'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('owner_statements_period_key').on(t.contractId, t.periodStart),
    uniqueIndex('owner_statements_number_key')
      .on(t.orgId, t.number)
      .where(sql`number IS NOT NULL`),
    index('owner_statements_owner_idx').on(t.ownerId, t.periodStart),
    check(
      'owner_statements_status_check',
      sql.raw(`status IN (${sqlList(OWNER_STATEMENT_STATUSES)})`),
    ),
    check('owner_statements_period_check', sql`period_end > period_start`),
  ],
);

/** A cost the owner bears: a repair, a utility bill, supplies. Taken off the statement of its month. */
export const ownerExpenses = pgTable(
  'owner_expenses',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => ownerContracts.id, { onDelete: 'restrict' }),
    date: date('date', { mode: 'string' }).notNull(),
    category: text('category').$type<OwnerExpenseCategory>().notNull().default('other'),
    description: text('description').notNull(),
    amount: money('amount').notNull(),
    maintenanceIssueId: uuid('maintenance_issue_id').references(() => maintenanceIssues.id, {
      onDelete: 'set null',
    }),
    /** The issued statement that charged it. An expense on an issued statement can no longer change. */
    statementId: uuid('statement_id').references(() => ownerStatements.id, {
      onDelete: 'set null',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('owner_expenses_contract_idx').on(t.contractId, t.date),
    check(
      'owner_expenses_category_check',
      sql.raw(`category IN (${sqlList(OWNER_EXPENSE_CATEGORIES)})`),
    ),
    check('owner_expenses_amount_check', sql`amount > 0`),
  ],
);

/** A report sent by email on a schedule. */
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    report: text('report').$type<ReportKind>().notNull(),
    /** For reports that can be grouped: by day, month, property and so on. */
    groupBy: text('group_by'),
    /** The properties covered. Null: every property of the organisation. */
    propertyIds: jsonb('property_ids').$type<string[]>(),
    period: text('period').$type<ReportPeriod>().notNull(),
    frequency: text('frequency').$type<ReportFrequency>().notNull(),
    /** For weekly: 0 is Sunday. */
    weekday: integer('weekday'),
    /** For monthly: 1 to 28. */
    dayOfMonth: integer('day_of_month'),
    /** Hour of the day, by the organisation's clock. */
    hour: integer('hour').notNull().default(7),
    recipients: jsonb('recipients').$type<string[]>().notNull(),
    active: boolean('active').notNull().default(true),
    nextRunAt: timestamptz('next_run_at').notNull(),
    lastRunAt: timestamptz('last_run_at'),
    lastStatus: text('last_status').$type<'sent' | 'failed' | 'not_configured'>(),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('report_schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`active`),
    index('report_schedules_org_idx').on(t.orgId),
    check('report_schedules_report_check', sql.raw(`report IN (${sqlList(REPORT_KINDS)})`)),
    check('report_schedules_period_check', sql.raw(`period IN (${sqlList(REPORT_PERIODS)})`)),
    check(
      'report_schedules_frequency_check',
      sql.raw(`frequency IN (${sqlList(REPORT_FREQUENCIES)})`),
    ),
    check(
      'report_schedules_when_check',
      sql`hour BETWEEN 0 AND 23 AND (weekday IS NULL OR weekday BETWEEN 0 AND 6) AND (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28)`,
    ),
  ],
);
