import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  inventoryBlocks,
  pgErrorInfo,
  ownerContracts,
  ownerExpenses,
  ownerStatements,
  owners,
  properties,
  roleAssignments,
  units,
  users,
  type DbOrTx,
  type OwnerContractModel,
  type OwnerExpenseCategory,
  type OwnerFeeBasis,
  type StatementAdjustment,
  type StatementExpense,
  type StatementLines,
  type StatementStay,
  type StatementTerms,
  type Transaction,
} from '@pms/db';
import { raiseAlert } from './alerts';
import { diff, writeAudit } from './audit';
import { createBlock, releaseBlock, type BlockRow } from './blocks';
import { systemActor, type Actor } from './context';
import { toCsv, type CsvCell } from './csv';
import {
  addDays,
  assertDate,
  diffDays,
  maxDate,
  minDate,
  monthOf,
  monthRange,
  todayIn,
  type DateString,
} from './dates';
import { DomainError, invalidState, isDomainError, notFound, validationError } from './errors';
import { minorToDecimal } from './money';
import { requireProperty, type PropertyRow } from './properties';
import { sourceName } from './source-labels';
import { transact, uuidArray } from './sqlx';

export type OwnerRow = typeof owners.$inferSelect;
export type OwnerContractRow = typeof ownerContracts.$inferSelect;
export type OwnerExpenseRow = typeof ownerExpenses.$inferSelect;
export type OwnerStatementRow = typeof ownerStatements.$inferSelect;

// ---------------------------------------------------------------------------
// Owners

export interface OwnerInput {
  name: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string;
  gstin?: string | null;
  notes?: string | null;
  active?: boolean;
  /** The sign-in the owner uses for the owner portal. It must already hold the villa owner role. */
  userId?: string | null;
}

async function cleanOwner(
  tx: DbOrTx,
  orgId: string,
  input: Partial<OwnerInput>,
): Promise<Partial<typeof owners.$inferInsert>> {
  const out: Partial<typeof owners.$inferInsert> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw validationError('An owner needs a name');
    out.name = input.name.trim().slice(0, 200);
  }
  if (input.email !== undefined) {
    const email = input.email?.trim().toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw validationError('Enter a valid email address');
    }
    out.email = email;
  }
  if (input.gstin !== undefined) {
    const gstin = input.gstin?.trim().toUpperCase() || null;
    if (gstin && !/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)) {
      throw validationError('A GSTIN is 15 characters, starting with the two-digit state code');
    }
    out.gstin = gstin;
  }
  for (const field of [
    'legalName',
    'phone',
    'addressLine1',
    'city',
    'state',
    'postalCode',
    'notes',
  ] as const) {
    if (input[field] !== undefined) out[field] = input[field]?.trim() || null;
  }
  if (input.country !== undefined) out.country = input.country.trim().toUpperCase() || 'IN';
  if (input.active !== undefined) out.active = input.active;
  if (input.userId !== undefined) {
    if (input.userId) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.orgId, orgId)));
      if (!user) throw notFound('User', input.userId);
      const grants = await tx
        .select({ role: roleAssignments.role })
        .from(roleAssignments)
        .where(eq(roleAssignments.userId, input.userId));
      if (!grants.some((g) => g.role === 'villa_owner')) {
        throw validationError(
          'That person does not have the villa owner role yet. Give it to them under Settings, Users, then choose them here.',
        );
      }
    }
    out.userId = input.userId;
  }
  return out;
}

function ownerConflict(err: unknown): never {
  if (pgErrorInfo(err)?.constraint === 'owners_user_key') {
    throw new DomainError('conflict', 'That sign-in already belongs to another owner');
  }
  throw err;
}

export async function createOwner(db: DbOrTx, actor: Actor, input: OwnerInput): Promise<OwnerRow> {
  return transact(db, async (tx) => {
    const values = await cleanOwner(tx, actor.orgId, input);
    const [row] = await tx
      .insert(owners)
      .values({ ...values, orgId: actor.orgId, name: values.name! })
      .returning()
      .catch(ownerConflict);
    await writeAudit(tx, actor, {
      action: 'owner.created',
      entityType: 'owner',
      entityId: row!.id,
      summary: `Added owner ${row!.name}`,
    });
    return row!;
  });
}

export async function requireOwner(db: DbOrTx, orgId: string, ownerId: string): Promise<OwnerRow> {
  const [owner] = await db
    .select()
    .from(owners)
    .where(and(eq(owners.id, ownerId), eq(owners.orgId, orgId)));
  if (!owner) throw notFound('Owner', ownerId);
  return owner;
}

export async function updateOwner(
  db: DbOrTx,
  actor: Actor,
  ownerId: string,
  patch: Partial<OwnerInput>,
): Promise<OwnerRow> {
  return transact(db, async (tx) => {
    const before = await requireOwner(tx, actor.orgId, ownerId);
    const values = await cleanOwner(tx, actor.orgId, patch);
    if (Object.keys(values).length === 0) return before;
    const [row] = await tx
      .update(owners)
      .set(values)
      .where(eq(owners.id, ownerId))
      .returning()
      .catch(ownerConflict);
    await writeAudit(tx, actor, {
      action: 'owner.updated',
      entityType: 'owner',
      entityId: ownerId,
      summary: `Changed owner ${row!.name}`,
      changes: diff(before, values),
    });
    return row!;
  });
}

export interface ContractView extends OwnerContractRow {
  propertyName: string;
  propertyCode: string;
  currency: string;
  /** Null when the contract covers the whole property. */
  unitName: string | null;
}

export interface OwnerView extends OwnerRow {
  contracts: ContractView[];
  /** The portal sign-in, when there is one. */
  user: { id: string; email: string; name: string; status: string } | null;
}

async function contractViews(
  db: DbOrTx,
  orgId: string,
  where: ReturnType<typeof and>,
): Promise<ContractView[]> {
  const rows = await db
    .select({
      contract: ownerContracts,
      propertyName: properties.name,
      propertyCode: properties.code,
      currency: properties.currency,
      unitName: units.name,
    })
    .from(ownerContracts)
    .innerJoin(properties, eq(properties.id, ownerContracts.propertyId))
    .leftJoin(units, eq(units.id, ownerContracts.unitId))
    .where(and(eq(ownerContracts.orgId, orgId), where))
    .orderBy(asc(properties.name), asc(ownerContracts.startsOn));
  return rows.map((r) => ({
    ...r.contract,
    propertyName: r.propertyName,
    propertyCode: r.propertyCode,
    currency: r.currency,
    unitName: r.unitName,
  }));
}

export async function listOwners(db: DbOrTx, orgId: string): Promise<OwnerView[]> {
  const rows = await db
    .select({ owner: owners, user: users })
    .from(owners)
    .leftJoin(users, eq(users.id, owners.userId))
    .where(eq(owners.orgId, orgId))
    .orderBy(asc(owners.name));
  const contracts = await contractViews(db, orgId, undefined);
  return rows.map(({ owner, user }) => ({
    ...owner,
    contracts: contracts.filter((c) => c.ownerId === owner.id),
    user: user ? { id: user.id, email: user.email, name: user.name, status: user.status } : null,
  }));
}

export async function getOwner(db: DbOrTx, orgId: string, ownerId: string): Promise<OwnerView> {
  const owner = (await listOwners(db, orgId)).find((o) => o.id === ownerId);
  if (!owner) throw notFound('Owner', ownerId);
  return owner;
}

// ---------------------------------------------------------------------------
// Contracts

export interface ContractInput {
  ownerId: string;
  propertyId: string;
  unitId?: string | null;
  startsOn: DateString;
  endsOn?: DateString | null;
  model?: OwnerContractModel;
  managementFeeBp?: number;
  feeBasis?: OwnerFeeBasis;
  feeTaxBp?: number;
  commissionOnOwner?: boolean;
  /** For `fixed_rent`: the amount a month, in minor units. */
  fixedRent?: number | null;
  ownerNightsPerYear?: number | null;
  ownerStayNoticeDays?: number;
  notes?: string | null;
}

function checkTerms(c: {
  startsOn: string;
  endsOn: string | null;
  model: OwnerContractModel;
  managementFeeBp: number;
  feeTaxBp: number;
  fixedRent: number | null;
  ownerNightsPerYear: number | null;
  ownerStayNoticeDays: number;
}): void {
  assertDate(c.startsOn);
  if (c.endsOn) {
    assertDate(c.endsOn);
    if (c.endsOn < c.startsOn) throw validationError('A contract cannot end before it starts');
  }
  const bp = (value: number, what: string): void => {
    if (!Number.isInteger(value) || value < 0 || value > 10_000) {
      throw validationError(`${what} must be between 0% and 100%`);
    }
  };
  bp(c.managementFeeBp, 'The management fee');
  bp(c.feeTaxBp, 'The tax on the management fee');
  if (c.model === 'fixed_rent') {
    if (c.fixedRent === null || !Number.isInteger(c.fixedRent) || c.fixedRent < 0) {
      throw validationError('A fixed-rent contract needs the rent for a month');
    }
  } else if (c.fixedRent !== null) {
    throw validationError('Only a fixed-rent contract has a monthly rent');
  }
  if (
    c.ownerNightsPerYear !== null &&
    (!Number.isInteger(c.ownerNightsPerYear) ||
      c.ownerNightsPerYear < 0 ||
      c.ownerNightsPerYear > 366)
  ) {
    throw validationError('Owner nights a year must be between 0 and 366');
  }
  if (
    !Number.isInteger(c.ownerStayNoticeDays) ||
    c.ownerStayNoticeDays < 0 ||
    c.ownerStayNoticeDays > 365
  ) {
    throw validationError('Notice for an owner stay must be between 0 and 365 days');
  }
}

/** A unit together with the units inside it (the bedrooms of a villa sold by the room). */
async function unitTree(db: DbOrTx, unitId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM units WHERE id = ${unitId}
      UNION ALL
      SELECT u.id FROM units u JOIN tree t ON u.parent_unit_id = t.id
    )
    SELECT id FROM tree
  `);
  return rows.map((r) => r.id);
}

/** The units a contract covers, or null for the whole property. */
async function unitsOf(db: DbOrTx, contract: Pick<OwnerContractRow, 'unitId'>) {
  return contract.unitId ? unitTree(db, contract.unitId) : null;
}

/**
 * Refuses a contract whose dates and units collide with another: the whole
 * property against any unit of it, a villa against one of its bedrooms, or
 * the same unit twice. Called with the property row locked.
 */
async function assertNoOverlap(
  tx: Transaction,
  candidate: {
    id?: string;
    propertyId: string;
    unitId: string | null;
    startsOn: string;
    endsOn: string | null;
  },
): Promise<void> {
  const others = await tx
    .select()
    .from(ownerContracts)
    .where(eq(ownerContracts.propertyId, candidate.propertyId));
  const mine = candidate.unitId ? await unitTree(tx, candidate.unitId) : null;
  for (const other of others) {
    if (other.id === candidate.id) continue;
    const apart =
      (candidate.endsOn !== null && candidate.endsOn < other.startsOn) ||
      (other.endsOn !== null && other.endsOn < candidate.startsOn);
    if (apart) continue;
    const theirs = other.unitId ? await unitTree(tx, other.unitId) : null;
    const shared =
      mine === null ||
      theirs === null ||
      mine.includes(other.unitId!) ||
      theirs.includes(candidate.unitId!);
    if (shared) {
      throw new DomainError(
        'conflict',
        `Another contract already covers ${theirs === null || mine === null ? 'this property' : 'this unit'} from ${other.startsOn}${other.endsOn ? ` to ${other.endsOn}` : ''}. End that one first, or choose other dates.`,
      );
    }
  }
}

export async function createContract(
  db: DbOrTx,
  actor: Actor,
  input: ContractInput,
): Promise<OwnerContractRow> {
  const terms = {
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? null,
    model: input.model ?? 'revenue_share',
    managementFeeBp: input.managementFeeBp ?? 2000,
    feeBasis: input.feeBasis ?? 'net',
    feeTaxBp: input.feeTaxBp ?? 1800,
    commissionOnOwner: input.commissionOnOwner ?? true,
    fixedRent: input.fixedRent ?? null,
    ownerNightsPerYear: input.ownerNightsPerYear ?? null,
    ownerStayNoticeDays: input.ownerStayNoticeDays ?? 0,
  };
  checkTerms(terms);
  return transact(db, async (tx) => {
    const owner = await requireOwner(tx, actor.orgId, input.ownerId);
    const [property] = await tx
      .select()
      .from(properties)
      .where(and(eq(properties.id, input.propertyId), eq(properties.orgId, actor.orgId)))
      .for('update');
    if (!property) throw notFound('Property', input.propertyId);
    if (input.unitId) {
      const [unit] = await tx
        .select({ id: units.id })
        .from(units)
        .where(and(eq(units.id, input.unitId), eq(units.propertyId, property.id)));
      if (!unit) throw notFound('Unit', input.unitId);
    }
    await assertNoOverlap(tx, {
      propertyId: property.id,
      unitId: input.unitId ?? null,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
    });
    const [row] = await tx
      .insert(ownerContracts)
      .values({
        ...terms,
        orgId: actor.orgId,
        ownerId: owner.id,
        propertyId: property.id,
        unitId: input.unitId ?? null,
        notes: input.notes?.trim() || null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_contract.created',
      entityType: 'owner_contract',
      entityId: row!.id,
      propertyId: property.id,
      summary: `Added a contract with ${owner.name} for ${property.name}`,
      changes: { ...terms },
    });
    return row!;
  });
}

export type ContractPatch = Partial<Omit<ContractInput, 'ownerId' | 'propertyId' | 'unitId'>>;

/** Changes a contract's terms. Statements already issued keep the terms they were issued on. */
export async function updateContract(
  db: DbOrTx,
  actor: Actor,
  contractId: string,
  patch: ContractPatch,
): Promise<OwnerContractRow> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(ownerContracts)
      .where(and(eq(ownerContracts.id, contractId), eq(ownerContracts.orgId, actor.orgId)));
    if (!before) throw notFound('Contract', contractId);
    await tx.select().from(properties).where(eq(properties.id, before.propertyId)).for('update');
    const model = patch.model ?? before.model;
    const next = {
      startsOn: patch.startsOn ?? before.startsOn,
      endsOn: patch.endsOn === undefined ? before.endsOn : patch.endsOn,
      model,
      managementFeeBp: patch.managementFeeBp ?? before.managementFeeBp,
      feeBasis: patch.feeBasis ?? before.feeBasis,
      feeTaxBp: patch.feeTaxBp ?? before.feeTaxBp,
      commissionOnOwner: patch.commissionOnOwner ?? before.commissionOnOwner,
      fixedRent:
        patch.fixedRent === undefined
          ? model === 'fixed_rent'
            ? before.fixedRent
            : null
          : patch.fixedRent,
      ownerNightsPerYear:
        patch.ownerNightsPerYear === undefined
          ? before.ownerNightsPerYear
          : patch.ownerNightsPerYear,
      ownerStayNoticeDays: patch.ownerStayNoticeDays ?? before.ownerStayNoticeDays,
      notes: patch.notes === undefined ? before.notes : patch.notes?.trim() || null,
    };
    checkTerms(next);
    // A month already accounted for stays inside the contract.
    const [latest] = await tx
      .select({ periodStart: ownerStatements.periodStart, periodEnd: ownerStatements.periodEnd })
      .from(ownerStatements)
      .where(
        and(
          eq(ownerStatements.contractId, contractId),
          inArray(ownerStatements.status, ['issued', 'paid']),
        ),
      )
      .orderBy(desc(ownerStatements.periodStart))
      .limit(1);
    if (latest && next.endsOn !== null && next.endsOn < latest.periodStart) {
      throw invalidState(
        `A statement has been issued for the month from ${latest.periodStart}. The contract cannot end before it.`,
      );
    }
    await assertNoOverlap(tx, {
      id: contractId,
      propertyId: before.propertyId,
      unitId: before.unitId,
      startsOn: next.startsOn,
      endsOn: next.endsOn,
    });
    const [row] = await tx
      .update(ownerContracts)
      .set(next)
      .where(eq(ownerContracts.id, contractId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_contract.updated',
      entityType: 'owner_contract',
      entityId: contractId,
      propertyId: before.propertyId,
      summary: 'Changed an owner contract',
      changes: diff(before, next),
    });
    return row!;
  });
}

export async function getContract(
  db: DbOrTx,
  orgId: string,
  contractId: string,
): Promise<ContractView> {
  const [contract] = await contractViews(db, orgId, eq(ownerContracts.id, contractId));
  if (!contract) throw notFound('Contract', contractId);
  return contract;
}

// ---------------------------------------------------------------------------
// Costs the owner bears

export interface ExpenseInput {
  contractId: string;
  date: DateString;
  category?: OwnerExpenseCategory;
  description: string;
  /** Minor units. */
  amount: number;
  maintenanceIssueId?: string | null;
}

/** `27 December 2026`: a date as an owner reads it. */
const longDate = (date: DateString): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const monthName = (start: DateString): string =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${start}T00:00:00Z`),
  );

async function issuedStatementFor(
  tx: DbOrTx,
  contractId: string,
  date: DateString,
): Promise<OwnerStatementRow | undefined> {
  const [statement] = await tx
    .select()
    .from(ownerStatements)
    .where(
      and(
        eq(ownerStatements.contractId, contractId),
        eq(ownerStatements.periodStart, monthOf(date).start),
        inArray(ownerStatements.status, ['issued', 'paid']),
      ),
    );
  return statement;
}

export async function addOwnerExpense(
  db: DbOrTx,
  actor: Actor,
  input: ExpenseInput,
): Promise<OwnerExpenseRow> {
  assertDate(input.date);
  if (!input.description.trim()) throw validationError('Say what the cost was for');
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw validationError('The amount must be a whole amount above zero, in minor units');
  }
  return transact(db, async (tx) => {
    const contract = await getContract(tx, actor.orgId, input.contractId);
    if (input.date < contract.startsOn || (contract.endsOn && input.date > contract.endsOn)) {
      throw validationError('The date is outside the contract');
    }
    if (await issuedStatementFor(tx, contract.id, input.date)) {
      throw invalidState(
        `The statement for ${monthName(monthOf(input.date).start)} has already been issued. Date the cost in a later month so it goes on the next statement.`,
      );
    }
    const [row] = await tx
      .insert(ownerExpenses)
      .values({
        orgId: actor.orgId,
        contractId: contract.id,
        date: input.date,
        category: input.category ?? 'other',
        description: input.description.trim().slice(0, 300),
        amount: input.amount,
        maintenanceIssueId: input.maintenanceIssueId ?? null,
        createdBy: actor.userId ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_expense.added',
      entityType: 'owner_contract',
      entityId: contract.id,
      propertyId: contract.propertyId,
      summary: `Added a cost for the owner: ${row!.description}`,
      changes: { amount: row!.amount, date: row!.date, category: row!.category },
    });
    return row!;
  });
}

export async function removeOwnerExpense(
  db: DbOrTx,
  actor: Actor,
  expenseId: string,
): Promise<void> {
  await transact(db, async (tx) => {
    const [expense] = await tx
      .select()
      .from(ownerExpenses)
      .where(and(eq(ownerExpenses.id, expenseId), eq(ownerExpenses.orgId, actor.orgId)))
      .for('update');
    if (!expense) throw notFound('Expense', expenseId);
    if (expense.statementId) {
      throw invalidState('This cost is on a statement that has been issued');
    }
    await tx.delete(ownerExpenses).where(eq(ownerExpenses.id, expenseId));
    const contract = await getContract(tx, actor.orgId, expense.contractId);
    await writeAudit(tx, actor, {
      action: 'owner_expense.removed',
      entityType: 'owner_contract',
      entityId: expense.contractId,
      propertyId: contract.propertyId,
      summary: `Removed a cost for the owner: ${expense.description}`,
      changes: { amount: expense.amount, date: expense.date },
    });
  });
}

export async function listOwnerExpenses(
  db: DbOrTx,
  orgId: string,
  filter: { contractId: string; from?: DateString; to?: DateString },
): Promise<OwnerExpenseRow[]> {
  return db
    .select()
    .from(ownerExpenses)
    .where(
      and(
        eq(ownerExpenses.orgId, orgId),
        eq(ownerExpenses.contractId, filter.contractId),
        filter.from ? sql`${ownerExpenses.date} >= ${filter.from}::date` : undefined,
        filter.to ? sql`${ownerExpenses.date} < ${filter.to}::date` : undefined,
      ),
    )
    .orderBy(desc(ownerExpenses.date), desc(ownerExpenses.createdAt))
    .limit(1000);
}

// ---------------------------------------------------------------------------
// Statements

interface Figures {
  roomNights: number;
  grossRevenue: number;
  channelCommission: number;
  managementFee: number;
  feeTax: number;
  expenses: number;
  adjustments: number;
  payout: number;
  lines: StatementLines;
  terms: StatementTerms;
}

/**
 * Works out what a month earned for the owner. Only nights guests actually
 * stayed count: a booking still to come, a cancellation or a no-show earns
 * nothing here.
 */
async function figuresFor(
  tx: DbOrTx,
  contract: OwnerContractRow,
  period: { start: DateString; end: DateString },
  adjustments: StatementAdjustment[],
  statementId: string | null,
): Promise<Figures> {
  const from = maxDate(period.start, contract.startsOn);
  const to = contract.endsOn ? minDate(period.end, addDays(contract.endsOn, 1)) : period.end;
  if (to <= from) throw validationError('The contract does not cover that month');
  const unitIds = await unitsOf(tx, contract);
  const { rows } = await tx.execute<{
    code: string;
    source: string;
    unit_name: string | null;
    check_in: string;
    check_out: string;
    nights: number;
    revenue: string;
    commission: string;
  }>(sql`
    SELECT r.code, coalesce(r.channel_code, r.source) AS source, u.name AS unit_name,
      rr.check_in::text, rr.check_out::text, count(*)::int AS nights, sum(n.amount)::text AS revenue,
      (CASE
        WHEN r.commission_amount > 0 AND r.total_amount > 0
          THEN least(r.commission_amount, round(r.commission_amount::numeric * sum(n.amount) / r.total_amount))
        WHEN c.kind = 'travel_agent' THEN round(sum(n.amount)::numeric * c.commission_bp / 10000)
        ELSE 0 END)::text AS commission
    FROM reservation_nights n
    JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
    JOIN reservations r ON r.id = rr.reservation_id
    JOIN properties p ON p.id = rr.property_id
    LEFT JOIN units u ON u.id = rr.unit_id
    LEFT JOIN companies c ON c.id = r.company_id
    WHERE rr.property_id = ${contract.propertyId} AND n.date >= ${from}::date AND n.date < ${to}::date
      AND rr.status IN ('in_house', 'checked_out')
      -- A guest in house has stayed the nights behind them, not the ones still to come.
      AND n.date < coalesce(p.business_date, (now() AT TIME ZONE p.timezone)::date)
      AND ${unitIds === null ? sql`true` : sql`rr.unit_id = ANY(${uuidArray(unitIds)})`}
    GROUP BY r.id, rr.id, u.name, c.kind, c.commission_bp
    ORDER BY rr.check_in, r.code
  `);
  const stays: StatementStay[] = rows.map((r) => ({
    reservationCode: r.code,
    source: r.source,
    unitName: r.unit_name,
    checkIn: r.check_in,
    checkOut: r.check_out,
    nights: r.nights,
    revenue: Number(r.revenue),
    commission: Number(r.commission),
  }));
  const costs = await tx
    .select()
    .from(ownerExpenses)
    .where(
      and(
        eq(ownerExpenses.contractId, contract.id),
        sql`${ownerExpenses.date} >= ${period.start}::date AND ${ownerExpenses.date} < ${period.end}::date`,
        statementId
          ? sql`(${ownerExpenses.statementId} IS NULL OR ${ownerExpenses.statementId} = ${statementId})`
          : isNull(ownerExpenses.statementId),
      ),
    )
    .orderBy(asc(ownerExpenses.date), asc(ownerExpenses.createdAt));
  const expenses: StatementExpense[] = costs.map((e) => ({
    id: e.id,
    date: e.date,
    category: e.category,
    description: e.description,
    amount: e.amount,
  }));

  const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);
  const grossRevenue = sum(stays.map((s) => s.revenue));
  const commissionPaid = sum(stays.map((s) => s.commission));
  const expensesTotal = sum(expenses.map((e) => e.amount));
  const adjustmentsTotal = sum(adjustments.map((a) => a.amount));
  let channelCommission = 0;
  let managementFee = 0;
  let feeTax = 0;
  let earned: number;
  if (contract.model === 'fixed_rent') {
    // The rent for the part of the month the contract covers.
    earned = Math.round(
      (contract.fixedRent! * diffDays(from, to)) / diffDays(period.start, period.end),
    );
  } else {
    channelCommission = contract.commissionOnOwner ? commissionPaid : 0;
    const basis = contract.feeBasis === 'gross' ? grossRevenue : grossRevenue - commissionPaid;
    managementFee = Math.round((basis * contract.managementFeeBp) / 10_000);
    feeTax = Math.round((managementFee * contract.feeTaxBp) / 10_000);
    earned = grossRevenue - channelCommission - managementFee - feeTax;
  }
  return {
    roomNights: sum(stays.map((s) => s.nights)),
    grossRevenue,
    channelCommission,
    managementFee,
    feeTax,
    expenses: expensesTotal,
    adjustments: adjustmentsTotal,
    payout: earned - expensesTotal + adjustmentsTotal,
    lines: { stays, expenses, adjustments },
    terms: {
      model: contract.model,
      managementFeeBp: contract.managementFeeBp,
      feeTaxBp: contract.feeTaxBp,
      feeBasis: contract.feeBasis,
      fixedRent: contract.fixedRent,
      commissionOnOwner: contract.commissionOnOwner,
    },
  };
}

function cleanAdjustments(list: StatementAdjustment[]): StatementAdjustment[] {
  if (list.length > 50) throw validationError('A statement takes at most 50 adjustments');
  return list.map((a) => {
    const description = a.description.trim().slice(0, 200);
    if (!description) throw validationError('Say what each adjustment is for');
    if (!Number.isInteger(a.amount) || a.amount === 0) {
      throw validationError('An adjustment is a whole amount, not zero, in minor units');
    }
    return { description, amount: a.amount };
  });
}

export interface StatementView extends Omit<OwnerStatementRow, 'terms'>, StatementTerms {
  ownerName: string;
  propertyName: string;
  unitName: string | null;
}

async function statementViews(
  db: DbOrTx,
  orgId: string,
  where: ReturnType<typeof and>,
  limit = 500,
): Promise<StatementView[]> {
  const rows = await db
    .select({
      statement: ownerStatements,
      ownerName: owners.name,
      propertyName: properties.name,
      unitName: units.name,
      contract: ownerContracts,
    })
    .from(ownerStatements)
    .innerJoin(owners, eq(owners.id, ownerStatements.ownerId))
    .innerJoin(ownerContracts, eq(ownerContracts.id, ownerStatements.contractId))
    .innerJoin(properties, eq(properties.id, ownerStatements.propertyId))
    .leftJoin(units, eq(units.id, ownerContracts.unitId))
    .where(and(eq(ownerStatements.orgId, orgId), where))
    .orderBy(desc(ownerStatements.periodStart), asc(properties.name))
    .limit(limit);
  return rows.map(({ statement: { terms, ...statement }, contract, ...rest }) => ({
    ...statement,
    ...rest,
    // The terms it was worked out on; for a statement older than that record, today's.
    model: terms?.model ?? contract.model,
    managementFeeBp: terms?.managementFeeBp ?? contract.managementFeeBp,
    feeTaxBp: terms?.feeTaxBp ?? contract.feeTaxBp,
    feeBasis: terms?.feeBasis ?? contract.feeBasis,
    fixedRent: terms ? terms.fixedRent : contract.fixedRent,
    commissionOnOwner: terms?.commissionOnOwner ?? contract.commissionOnOwner,
  }));
}

export async function getOwnerStatement(
  db: DbOrTx,
  orgId: string,
  statementId: string,
): Promise<StatementView> {
  const [statement] = await statementViews(db, orgId, eq(ownerStatements.id, statementId), 1);
  if (!statement) throw notFound('Statement', statementId);
  return statement;
}

export async function listOwnerStatements(
  db: DbOrTx,
  orgId: string,
  filter: {
    ownerId?: string;
    contractId?: string;
    propertyId?: string;
    /** `YYYY-MM`. */
    month?: string;
    status?: OwnerStatementRow['status'];
  } = {},
): Promise<StatementView[]> {
  return statementViews(
    db,
    orgId,
    and(
      filter.ownerId ? eq(ownerStatements.ownerId, filter.ownerId) : undefined,
      filter.contractId ? eq(ownerStatements.contractId, filter.contractId) : undefined,
      filter.propertyId ? eq(ownerStatements.propertyId, filter.propertyId) : undefined,
      filter.month ? eq(ownerStatements.periodStart, `${filter.month}-01`) : undefined,
      filter.status ? eq(ownerStatements.status, filter.status) : undefined,
    ),
  );
}

async function lockContract(
  tx: Transaction,
  orgId: string,
  contractId: string,
): Promise<{ contract: OwnerContractRow; property: PropertyRow }> {
  const [contract] = await tx
    .select()
    .from(ownerContracts)
    .where(and(eq(ownerContracts.id, contractId), eq(ownerContracts.orgId, orgId)))
    .for('update');
  if (!contract) throw notFound('Contract', contractId);
  return { contract, property: await requireProperty(tx, orgId, contract.propertyId) };
}

/**
 * Works out the statement for a month as a draft, or works it out again if a
 * draft exists. Adjustments and notes on the draft are kept. A statement that
 * has been issued is left as it is.
 */
export async function draftOwnerStatement(
  db: DbOrTx,
  actor: Actor,
  contractId: string,
  month: string,
): Promise<OwnerStatementRow> {
  const period = monthRange(month);
  return transact(db, async (tx) => {
    const { contract, property } = await lockContract(tx, actor.orgId, contractId);
    const [existing] = await tx
      .select()
      .from(ownerStatements)
      .where(
        and(
          eq(ownerStatements.contractId, contractId),
          eq(ownerStatements.periodStart, period.start),
        ),
      )
      .for('update');
    if (existing && existing.status !== 'draft') {
      throw invalidState(
        `The statement for ${monthName(period.start)} has been issued and can no longer be changed. Put a correction on the next statement as an adjustment.`,
      );
    }
    const figures = await figuresFor(
      tx,
      contract,
      period,
      existing?.lines.adjustments ?? [],
      existing?.id ?? null,
    );
    if (existing) {
      const [row] = await tx
        .update(ownerStatements)
        .set(figures)
        .where(eq(ownerStatements.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(ownerStatements)
      .values({
        ...figures,
        orgId: actor.orgId,
        ownerId: contract.ownerId,
        contractId,
        propertyId: contract.propertyId,
        periodStart: period.start,
        periodEnd: period.end,
        currency: property.currency,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_statement.drafted',
      entityType: 'owner_statement',
      entityId: row!.id,
      propertyId: contract.propertyId,
      summary: `Prepared the owner statement for ${monthName(period.start)}`,
    });
    return row!;
  });
}

async function draftForUpdate(
  tx: Transaction,
  orgId: string,
  statementId: string,
): Promise<OwnerStatementRow> {
  const [statement] = await tx
    .select()
    .from(ownerStatements)
    .where(and(eq(ownerStatements.id, statementId), eq(ownerStatements.orgId, orgId)))
    .for('update');
  if (!statement) throw notFound('Statement', statementId);
  if (statement.status !== 'draft') {
    throw invalidState('This statement has been issued and can no longer be changed');
  }
  return statement;
}

/** Sets the adjustments and the note on a draft, and works its figures out again. */
export async function updateOwnerStatement(
  db: DbOrTx,
  actor: Actor,
  statementId: string,
  patch: { adjustments?: StatementAdjustment[]; notes?: string | null },
): Promise<OwnerStatementRow> {
  return transact(db, async (tx) => {
    const statement = await draftForUpdate(tx, actor.orgId, statementId);
    const { contract } = await lockContract(tx, actor.orgId, statement.contractId);
    const adjustments =
      patch.adjustments === undefined
        ? statement.lines.adjustments
        : cleanAdjustments(patch.adjustments);
    const figures = await figuresFor(
      tx,
      contract,
      { start: statement.periodStart, end: statement.periodEnd },
      adjustments,
      statement.id,
    );
    const [row] = await tx
      .update(ownerStatements)
      .set({
        ...figures,
        notes: patch.notes === undefined ? statement.notes : patch.notes?.trim() || null,
      })
      .where(eq(ownerStatements.id, statementId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_statement.updated',
      entityType: 'owner_statement',
      entityId: statementId,
      propertyId: statement.propertyId,
      summary: `Changed the draft owner statement for ${monthName(statement.periodStart)}`,
      changes: { adjustments },
    });
    return row!;
  });
}

export async function deleteOwnerStatement(
  db: DbOrTx,
  actor: Actor,
  statementId: string,
): Promise<void> {
  await transact(db, async (tx) => {
    const statement = await draftForUpdate(tx, actor.orgId, statementId);
    await tx.delete(ownerStatements).where(eq(ownerStatements.id, statementId));
    await writeAudit(tx, actor, {
      action: 'owner_statement.deleted',
      entityType: 'owner_statement',
      entityId: statementId,
      propertyId: statement.propertyId,
      summary: `Discarded the draft owner statement for ${monthName(statement.periodStart)}`,
    });
  });
}

/**
 * Issues a draft: the figures are worked out one last time, the statement
 * gets its number, and from then on neither it nor the costs on it change.
 */
export async function issueOwnerStatement(
  db: DbOrTx,
  actor: Actor,
  statementId: string,
  now: Date = new Date(),
): Promise<OwnerStatementRow> {
  return transact(db, async (tx) => {
    const statement = await draftForUpdate(tx, actor.orgId, statementId);
    const { contract, property } = await lockContract(tx, actor.orgId, statement.contractId);
    if (todayIn(property.timezone, now) < statement.periodEnd) {
      throw invalidState(
        `${monthName(statement.periodStart)} is not over yet. A statement is issued once its month has ended.`,
      );
    }
    const figures = await figuresFor(
      tx,
      contract,
      { start: statement.periodStart, end: statement.periodEnd },
      statement.lines.adjustments,
      statement.id,
    );
    // Numbered per property and month; the lock on the contract's property keeps two issues apart.
    await tx.select().from(properties).where(eq(properties.id, property.id)).for('update');
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ownerStatements)
      .where(
        and(
          eq(ownerStatements.propertyId, property.id),
          eq(ownerStatements.periodStart, statement.periodStart),
          sql`${ownerStatements.number} IS NOT NULL`,
        ),
      );
    const number = `${property.code}/OS/${statement.periodStart.slice(0, 7)}/${String(count + 1).padStart(2, '0')}`;
    const [row] = await tx
      .update(ownerStatements)
      .set({
        ...figures,
        status: 'issued',
        number,
        issuedAt: now,
        issuedBy: actor.userId ?? null,
      })
      .where(eq(ownerStatements.id, statementId))
      .returning();
    if (figures.lines.expenses.length > 0) {
      await tx
        .update(ownerExpenses)
        .set({ statementId })
        .where(
          inArray(
            ownerExpenses.id,
            figures.lines.expenses.map((e) => e.id),
          ),
        );
    }
    await writeAudit(tx, actor, {
      action: 'owner_statement.issued',
      entityType: 'owner_statement',
      entityId: statementId,
      propertyId: property.id,
      summary: `Issued owner statement ${number} for ${monthName(statement.periodStart)}`,
      changes: { payout: figures.payout, grossRevenue: figures.grossRevenue },
    });
    return row!;
  });
}

/** Records that the owner has been paid what an issued statement says. */
export async function markOwnerStatementPaid(
  db: DbOrTx,
  actor: Actor,
  statementId: string,
  input: { reference?: string | null; paidAt?: Date } = {},
): Promise<OwnerStatementRow> {
  return transact(db, async (tx) => {
    const [statement] = await tx
      .select()
      .from(ownerStatements)
      .where(and(eq(ownerStatements.id, statementId), eq(ownerStatements.orgId, actor.orgId)))
      .for('update');
    if (!statement) throw notFound('Statement', statementId);
    if (statement.status === 'draft') {
      throw invalidState('Issue the statement before recording its payment');
    }
    if (statement.status === 'paid') return statement;
    const [row] = await tx
      .update(ownerStatements)
      .set({
        status: 'paid',
        paidAt: input.paidAt ?? new Date(),
        paymentReference: input.reference?.trim().slice(0, 120) || null,
      })
      .where(eq(ownerStatements.id, statementId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'owner_statement.paid',
      entityType: 'owner_statement',
      entityId: statementId,
      propertyId: statement.propertyId,
      summary: `Recorded the payment of owner statement ${statement.number}`,
    });
    return row!;
  });
}

/**
 * Prepares last month's statements for every contract that does not have one
 * yet, and tells the accounts team once they are ready to check. Run daily
 * by the worker; it does nothing until a month has ended.
 */
export async function draftDueOwnerStatements(
  db: DbOrTx,
  now: Date = new Date(),
): Promise<{ drafted: number }> {
  const { rows } = await db.execute<{
    id: string;
    org_id: string;
    month: string;
  }>(sql`
    SELECT c.id, c.org_id, to_char(m.start, 'YYYY-MM') AS month
    FROM owner_contracts c
    JOIN properties p ON p.id = c.property_id
    CROSS JOIN LATERAL (
      SELECT (date_trunc('month', (${now.toISOString()}::timestamptz AT TIME ZONE p.timezone)) - interval '1 month')::date AS start
    ) m
    WHERE c.starts_on < (m.start + interval '1 month')::date
      AND (c.ends_on IS NULL OR c.ends_on >= m.start)
      AND NOT EXISTS (
        SELECT 1 FROM owner_statements s WHERE s.contract_id = c.id AND s.period_start = m.start
      )
    ORDER BY c.org_id
    LIMIT 500
  `);
  const ready = new Map<string, { month: string; count: number }>();
  for (const row of rows) {
    await draftOwnerStatement(db, systemActor(row.org_id, 'owner-statements'), row.id, row.month);
    const entry = ready.get(row.org_id) ?? { month: row.month, count: 0 };
    entry.count++;
    ready.set(row.org_id, entry);
  }
  for (const [orgId, { month, count }] of ready) {
    const name = monthName(`${month}-01`);
    await raiseAlert(db, {
      orgId,
      kind: 'owner_statements',
      severity: 'info',
      title: `Owner statements for ${name} are ready to check`,
      body: `${count} statement${count === 1 ? ' has' : 's have'} been prepared as ${count === 1 ? 'a draft' : 'drafts'}. Check each one, add any costs or adjustments, then issue it so the owner can see it.`,
      dedupeKey: `owner_statements:${orgId}:${month}`,
      metadata: { month, count },
    });
  }
  return { drafted: rows.length };
}

/** A statement as a spreadsheet: the stays, the costs, then the sums. */
export function ownerStatementCsv(statement: StatementView): string {
  const money = (amount: number): string => minorToDecimal(amount, statement.currency);
  const rows: CsvCell[][] = [
    ['Owner statement', statement.number ?? 'Draft'],
    ['Owner', statement.ownerName],
    [
      'Property',
      statement.unitName
        ? `${statement.propertyName}, ${statement.unitName}`
        : statement.propertyName,
    ],
    ['Period', `${statement.periodStart} to ${addDays(statement.periodEnd, -1)}`],
    ['Currency', statement.currency],
    [],
    ['Booking', 'Source', 'Unit', 'Arrival', 'Departure', 'Nights', 'Room revenue', 'Commission'],
    ...statement.lines.stays.map((s) => [
      s.reservationCode,
      sourceName(s.source),
      s.unitName,
      s.checkIn,
      s.checkOut,
      s.nights,
      money(s.revenue),
      money(s.commission),
    ]),
    [],
    ['Costs', 'Date', 'Category', 'Amount'],
    ...statement.lines.expenses.map((e) => [e.description, e.date, e.category, money(e.amount)]),
    [],
    ['Adjustments', 'Amount'],
    ...statement.lines.adjustments.map((a) => [a.description, money(a.amount)]),
    [],
    ['Room nights', statement.roomNights],
    ['Room revenue', money(statement.grossRevenue)],
    ['Commission', money(-statement.channelCommission)],
    ['Management fee', money(-statement.managementFee)],
    ['Tax on management fee', money(-statement.feeTax)],
    ['Costs', money(-statement.expenses)],
    ['Adjustments', money(statement.adjustments)],
    ['Payable to owner', money(statement.payout)],
  ];
  return toCsv(rows);
}

// ---------------------------------------------------------------------------
// The owner portal: what an owner sees and may do, about their own units only

/** The owner record behind a sign-in. Everything in the portal starts here. */
export async function ownerForUser(db: DbOrTx, actor: Actor): Promise<OwnerRow> {
  if (!actor.userId) throw new DomainError('forbidden', 'The owner portal is for signed-in owners');
  const [owner] = await db
    .select()
    .from(owners)
    .where(
      and(eq(owners.orgId, actor.orgId), eq(owners.userId, actor.userId), eq(owners.active, true)),
    );
  if (!owner) {
    throw new DomainError(
      'forbidden',
      'This sign-in is not linked to an owner yet. Ask the property\u2019s office to link it.',
    );
  }
  return owner;
}

async function ownContract(db: DbOrTx, owner: OwnerRow, contractId: string): Promise<ContractView> {
  const [contract] = await contractViews(
    db,
    owner.orgId,
    and(eq(ownerContracts.id, contractId), eq(ownerContracts.ownerId, owner.id)),
  );
  if (!contract) throw notFound('Contract', contractId);
  return contract;
}

export interface OwnerStay {
  contractId: string;
  unitId: string | null;
  unitName: string | null;
  checkIn: DateString;
  checkOut: DateString;
  nights: number;
  /** Booking site code, or how the booking came. Guests are not named to owners. */
  source: string;
  status: 'confirmed' | 'in_house' | 'checked_out';
  /** Room revenue before tax. */
  revenue: number;
}

export interface OwnerBlock {
  id: string;
  contractId: string;
  unitId: string | null;
  unitName: string | null;
  startDate: DateString;
  endDate: DateString;
  /** `owner_stay` for the owner's own use; anything else is shown as not available. */
  kind: 'owner_stay' | 'unavailable';
  /** True when this owner asked for it, and so may cancel it. */
  own: boolean;
}

export interface OwnerCalendar {
  from: DateString;
  to: DateString;
  contracts: ContractView[];
  stays: OwnerStay[];
  blocks: OwnerBlock[];
}

/** A contract as its owner may see it: the office's own notes about it stay in the office. */
const forOwnerEyes = (contract: ContractView): ContractView => ({ ...contract, notes: null });

/** Guest stays and closed dates on the owner's units between two dates. */
export async function ownerCalendar(
  db: DbOrTx,
  actor: Actor,
  range: { from: DateString; to: DateString },
): Promise<OwnerCalendar> {
  assertDate(range.from);
  assertDate(range.to);
  if (range.to <= range.from) throw validationError('The period must end after it starts');
  if (diffDays(range.from, range.to) > 400) {
    throw validationError('The calendar shows at most 400 days at a time');
  }
  const owner = await ownerForUser(db, actor);
  const contracts = await contractViews(db, owner.orgId, eq(ownerContracts.ownerId, owner.id));
  const stays: OwnerStay[] = [];
  const blocks: OwnerBlock[] = [];
  for (const contract of contracts) {
    const from = maxDate(range.from, contract.startsOn);
    const to = contract.endsOn ? minDate(range.to, addDays(contract.endsOn, 1)) : range.to;
    if (to <= from) continue;
    const unitIds = await unitsOf(db, contract);
    const scope = unitIds === null ? sql`true` : sql`x.unit_id = ANY(${uuidArray(unitIds)})`;
    const { rows: stayRows } = await db.execute<{
      unit_id: string | null;
      unit_name: string | null;
      check_in: string;
      check_out: string;
      source: string;
      status: OwnerStay['status'];
      revenue: string;
    }>(sql`
      SELECT x.unit_id, u.name AS unit_name, x.check_in::text, x.check_out::text,
        coalesce(r.channel_code, r.source) AS source, x.status,
        coalesce((SELECT sum(n.amount) FROM reservation_nights n WHERE n.reservation_room_id = x.id), 0)::text AS revenue
      FROM reservation_rooms x
      JOIN reservations r ON r.id = x.reservation_id
      LEFT JOIN units u ON u.id = x.unit_id
      WHERE x.property_id = ${contract.propertyId} AND x.status IN ('confirmed', 'in_house', 'checked_out')
        AND x.check_in < ${to}::date AND x.check_out > ${from}::date AND ${scope}
      ORDER BY x.check_in
      LIMIT 2000
    `);
    for (const s of stayRows) {
      stays.push({
        contractId: contract.id,
        unitId: s.unit_id,
        unitName: s.unit_name,
        checkIn: s.check_in,
        checkOut: s.check_out,
        nights: diffDays(s.check_in, s.check_out),
        source: s.source,
        status: s.status,
        revenue: Number(s.revenue),
      });
    }
    const { rows: blockRows } = await db.execute<{
      id: string;
      unit_id: string | null;
      unit_name: string | null;
      start_date: string;
      end_date: string;
      kind: string;
      owner_id: string | null;
    }>(sql`
      SELECT x.id, x.unit_id, u.name AS unit_name, x.start_date::text, x.end_date::text, x.kind, x.owner_id
      FROM inventory_blocks x
      LEFT JOIN units u ON u.id = x.unit_id
      WHERE x.property_id = ${contract.propertyId} AND x.released_at IS NULL AND x.kind <> 'hold'
        AND x.start_date < ${to}::date AND x.end_date > ${from}::date AND ${scope}
      ORDER BY x.start_date
      LIMIT 2000
    `);
    for (const b of blockRows) {
      blocks.push({
        id: b.id,
        contractId: contract.id,
        unitId: b.unit_id,
        unitName: b.unit_name,
        startDate: b.start_date,
        endDate: b.end_date,
        kind: b.kind === 'owner_stay' ? 'owner_stay' : 'unavailable',
        own: b.owner_id === owner.id,
      });
    }
  }
  return { from: range.from, to: range.to, contracts: contracts.map(forOwnerEyes), stays, blocks };
}

/**
 * Nights of owner stays on a contract's units that fall in a calendar year, within the
 * contract: the ones the owner took in the portal and the ones the office entered for them.
 */
async function ownerNightsUsed(
  db: DbOrTx,
  owner: OwnerRow,
  contract: OwnerContractRow,
  year: number,
): Promise<number> {
  const unitIds = await unitsOf(db, contract);
  // A stay before the contract began, or after it ended, was somebody else's.
  const start = maxDate(`${year}-01-01`, contract.startsOn);
  const end = contract.endsOn
    ? minDate(`${year + 1}-01-01`, addDays(contract.endsOn, 1))
    : `${year + 1}-01-01`;
  if (end <= start) return 0;
  const { rows } = await db.execute<{ nights: number }>(sql`
    SELECT coalesce(sum(least(end_date, ${end}::date) - greatest(start_date, ${start}::date)), 0)::int AS nights
    FROM inventory_blocks
    WHERE property_id = ${contract.propertyId} AND kind = 'owner_stay'
      AND (owner_id = ${owner.id} OR owner_id IS NULL)
      AND released_at IS NULL AND start_date < ${end}::date AND end_date > ${start}::date
      AND ${unitIds === null ? sql`true` : sql`unit_id = ANY(${uuidArray(unitIds)})`}
  `);
  return rows[0]?.nights ?? 0;
}

export interface OwnerOverview {
  owner: { id: string; name: string };
  contracts: (ContractView & {
    /** Nights of the owner's own stays this calendar year. */
    ownerNightsUsed: number;
    thisMonth: { nights: number; revenue: number };
    nextMonth: { nights: number; revenue: number };
  })[];
  /** The latest statements issued to the owner. */
  statements: StatementView[];
}

/** The first screen of the portal: each unit's month so far, and the latest statements. */
export async function ownerOverview(
  db: DbOrTx,
  actor: Actor,
  now: Date = new Date(),
): Promise<OwnerOverview> {
  const owner = await ownerForUser(db, actor);
  const contracts = await contractViews(db, owner.orgId, eq(ownerContracts.ownerId, owner.id));
  const out: OwnerOverview['contracts'] = [];
  for (const contract of contracts) {
    const property = await requireProperty(db, owner.orgId, contract.propertyId);
    const today = todayIn(property.timezone, now);
    const thisMonth = monthOf(today);
    const nextMonth = monthOf(thisMonth.end);
    const unitIds = await unitsOf(db, contract);
    const booked = async (period: { start: string; end: string }) => {
      const { rows } = await db.execute<{ nights: number; revenue: string }>(sql`
        SELECT count(*)::int AS nights, coalesce(sum(n.amount), 0)::text AS revenue
        FROM reservation_nights n JOIN reservation_rooms rr ON rr.id = n.reservation_room_id
        WHERE rr.property_id = ${contract.propertyId} AND rr.status IN ('confirmed', 'in_house', 'checked_out')
          AND n.date >= ${maxDate(period.start, contract.startsOn)}::date AND n.date < ${period.end}::date
          AND ${contract.endsOn ? sql`n.date <= ${contract.endsOn}::date` : sql`true`}
          AND ${unitIds === null ? sql`true` : sql`rr.unit_id = ANY(${uuidArray(unitIds)})`}
      `);
      return { nights: rows[0]?.nights ?? 0, revenue: Number(rows[0]?.revenue ?? 0) };
    };
    out.push({
      ...forOwnerEyes(contract),
      ownerNightsUsed: await ownerNightsUsed(db, owner, contract, Number(today.slice(0, 4))),
      thisMonth: await booked(thisMonth),
      nextMonth: await booked(nextMonth),
    });
  }
  const statements = await statementViews(
    db,
    owner.orgId,
    and(eq(ownerStatements.ownerId, owner.id), inArray(ownerStatements.status, ['issued', 'paid'])),
    12,
  );
  return { owner: { id: owner.id, name: owner.name }, contracts: out, statements };
}

/** The statements issued to the signed-in owner. Drafts are the office's working papers and are not shown. */
export async function ownerStatementsFor(db: DbOrTx, actor: Actor): Promise<StatementView[]> {
  const owner = await ownerForUser(db, actor);
  return statementViews(
    db,
    owner.orgId,
    and(eq(ownerStatements.ownerId, owner.id), inArray(ownerStatements.status, ['issued', 'paid'])),
  );
}

export async function ownerStatementFor(
  db: DbOrTx,
  actor: Actor,
  statementId: string,
): Promise<StatementView> {
  const owner = await ownerForUser(db, actor);
  const [statement] = await statementViews(
    db,
    owner.orgId,
    and(
      eq(ownerStatements.id, statementId),
      eq(ownerStatements.ownerId, owner.id),
      inArray(ownerStatements.status, ['issued', 'paid']),
    ),
    1,
  );
  if (!statement) throw notFound('Statement', statementId);
  return statement;
}

/**
 * The owner takes dates for their own use. The dates must be free, inside the
 * contract, asked for with the agreed notice, and within the nights a year
 * the contract allows. The closure reaches the booking sites like any other.
 */
export async function requestOwnerStay(
  db: DbOrTx,
  actor: Actor,
  input: { contractId: string; unitId?: string | null; from: DateString; to: DateString },
  now: Date = new Date(),
): Promise<BlockRow> {
  assertDate(input.from);
  assertDate(input.to);
  if (input.to <= input.from) throw validationError('The stay must end after it starts');
  const owner = await ownerForUser(db, actor);
  const contract = await ownContract(db, owner, input.contractId);
  const property = await requireProperty(db, owner.orgId, contract.propertyId);
  const today = todayIn(property.timezone, now);
  if (input.from < addDays(today, contract.ownerStayNoticeDays)) {
    throw validationError(
      contract.ownerStayNoticeDays > 0
        ? `Your contract asks for ${contract.ownerStayNoticeDays} days\u2019 notice: the earliest arrival is ${addDays(today, contract.ownerStayNoticeDays)}.`
        : 'The stay cannot start in the past',
    );
  }
  if (
    input.from < contract.startsOn ||
    (contract.endsOn && input.to > addDays(contract.endsOn, 1))
  ) {
    throw validationError('Those dates are outside your contract');
  }
  let unitId = contract.unitId;
  if (!unitId) {
    // A contract for a whole property: the owner says which unit, unless there is only one to choose.
    const candidates = await db
      .select({ id: units.id })
      .from(units)
      .where(
        and(eq(units.propertyId, property.id), eq(units.active, true), isNull(units.parentUnitId)),
      );
    unitId = input.unitId ?? (candidates.length === 1 ? candidates[0]!.id : null);
    if (!unitId || !candidates.some((c) => c.id === unitId)) {
      throw validationError('Choose which unit you would like to stay in');
    }
  } else if (input.unitId && input.unitId !== unitId) {
    throw validationError('That unit is not part of this contract');
  }
  if (contract.ownerNightsPerYear !== null) {
    // Each calendar year the stay touches is checked against that year's allowance.
    for (let year = Number(input.from.slice(0, 4)); year <= Number(input.to.slice(0, 4)); year++) {
      const inYear =
        diffDays(maxDate(input.from, `${year}-01-01`), minDate(input.to, `${year + 1}-01-01`)) || 0;
      if (inYear <= 0) continue;
      const used = await ownerNightsUsed(db, owner, contract, year);
      if (used + inYear > contract.ownerNightsPerYear) {
        const left = Math.max(0, contract.ownerNightsPerYear - used);
        throw validationError(
          `Your contract allows ${contract.ownerNightsPerYear} nights a year for your own stays, and ${left} ${left === 1 ? 'is' : 'are'} left for ${year}.`,
        );
      }
    }
  }
  try {
    return await createBlock(db, actor, {
      propertyId: property.id,
      unitId,
      kind: 'owner_stay',
      startDate: input.from,
      endDate: input.to,
      reason: `Owner stay: ${owner.name}`,
      ownerId: owner.id,
    });
  } catch (err) {
    // What is in the way may be a guest's booking: the owner is told when, never who.
    if (isDomainError(err) && (err.code === 'unit_occupied' || err.code === 'no_availability')) {
      const taken = (err.details?.conflicts as { from: string; to: string }[] | undefined)?.[0];
      throw new DomainError(
        err.code,
        taken
          ? `Those dates are not free: the villa is taken from ${longDate(taken.from)} to ${longDate(taken.to)}.`
          : 'Those dates are not free.',
      );
    }
    throw err;
  }
}

/** The owner gives back dates they had taken, as long as the stay has not begun. */
export async function cancelOwnerStay(
  db: DbOrTx,
  actor: Actor,
  blockId: string,
  now: Date = new Date(),
): Promise<void> {
  const owner = await ownerForUser(db, actor);
  const [block] = await db
    .select()
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.id, blockId),
        eq(inventoryBlocks.ownerId, owner.id),
        eq(inventoryBlocks.kind, 'owner_stay'),
        isNull(inventoryBlocks.releasedAt),
      ),
    );
  if (!block) throw notFound('Stay', blockId);
  const property = await requireProperty(db, owner.orgId, block.propertyId);
  if (block.startDate <= todayIn(property.timezone, now)) {
    throw invalidState('This stay has already begun. Ask the office to change it.');
  }
  await releaseBlock(db, actor, blockId);
}
