import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { companies, type CompanyKind, type DbOrTx } from '@pms/db';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { notFound, validationError } from './errors';
import { transact } from './sqlx';

export type CompanyRow = typeof companies.$inferSelect;

export interface CompanyInput {
  kind?: CompanyKind;
  name: string;
  legalName?: string | null;
  gstin?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  /** Most that may be outstanding on account, in minor units. Null: no limit. */
  creditLimit?: number | null;
  paymentTermsDays?: number;
  /** For travel agents: commission in basis points of room revenue. */
  commissionBp?: number;
  notes?: string | null;
  active?: boolean;
}

function clean(input: Partial<CompanyInput>): Partial<typeof companies.$inferInsert> {
  const out: Partial<typeof companies.$inferInsert> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw validationError('A company needs a name');
    out.name = input.name.trim().slice(0, 200);
  }
  if (input.gstin !== undefined) {
    const gstin = input.gstin?.trim().toUpperCase() || null;
    if (gstin && !/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)) {
      throw validationError('A GSTIN is 15 characters, starting with the two-digit state code');
    }
    out.gstin = gstin;
    // The first two digits of a GSTIN are the state code; keep the two in step.
    if (gstin && input.stateCode === undefined) out.stateCode = gstin.slice(0, 2);
  }
  if (input.creditLimit !== undefined) {
    if (
      input.creditLimit !== null &&
      (!Number.isInteger(input.creditLimit) || input.creditLimit < 0)
    ) {
      throw validationError('The credit limit must be a non-negative whole amount');
    }
    out.creditLimit = input.creditLimit;
  }
  if (input.paymentTermsDays !== undefined) {
    if (
      !Number.isInteger(input.paymentTermsDays) ||
      input.paymentTermsDays < 0 ||
      input.paymentTermsDays > 365
    ) {
      throw validationError('Payment terms must be between 0 and 365 days');
    }
    out.paymentTermsDays = input.paymentTermsDays;
  }
  if (input.commissionBp !== undefined) {
    if (
      !Number.isInteger(input.commissionBp) ||
      input.commissionBp < 0 ||
      input.commissionBp > 5_000
    ) {
      throw validationError('Commission must be between 0% and 50%');
    }
    out.commissionBp = input.commissionBp;
  }
  for (const field of [
    'legalName',
    'addressLine1',
    'city',
    'state',
    'stateCode',
    'postalCode',
    'email',
    'phone',
    'contactName',
    'notes',
  ] as const) {
    if (input[field] !== undefined) out[field] = input[field]?.trim() || null;
  }
  if (input.kind !== undefined) out.kind = input.kind;
  if (input.country !== undefined) out.country = input.country.trim().toUpperCase() || 'IN';
  if (input.active !== undefined) out.active = input.active;
  return out;
}

export async function createCompany(
  db: DbOrTx,
  actor: Actor,
  input: CompanyInput,
): Promise<CompanyRow> {
  const values = clean(input);
  return transact(db, async (tx) => {
    const [row] = await tx
      .insert(companies)
      .values({ ...values, orgId: actor.orgId, name: values.name! })
      .returning();
    await writeAudit(tx, actor, {
      action: 'company.created',
      entityType: 'company',
      entityId: row!.id,
      summary: `Added ${row!.kind === 'travel_agent' ? 'travel agent' : 'company'} ${row!.name}`,
    });
    return row!;
  });
}

export async function updateCompany(
  db: DbOrTx,
  actor: Actor,
  companyId: string,
  patch: Partial<CompanyInput>,
): Promise<CompanyRow> {
  const values = clean(patch);
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.orgId, actor.orgId)))
      .for('update');
    if (!before) throw notFound('Company', companyId);
    if (Object.keys(values).length === 0) return before;
    const [after] = await tx
      .update(companies)
      .set(values)
      .where(eq(companies.id, companyId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'company.updated',
      entityType: 'company',
      entityId: companyId,
      summary: `Updated ${before.name}`,
      changes: diff(before, after!),
    });
    return after!;
  });
}

export interface CompanyView extends CompanyRow {
  /** Owed on account across all properties. */
  outstanding: number;
}

/** Companies and travel agents, with what each owes on account. */
export async function listCompanies(
  db: DbOrTx,
  orgId: string,
  filter: { search?: string; kind?: CompanyKind; includeInactive?: boolean } = {},
): Promise<CompanyView[]> {
  const q = filter.search?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db
    .select({
      company: companies,
      outstanding: sql<string>`coalesce((
        SELECT sum(l.amount + l.tax_amount) FROM folio_lines l JOIN folios f ON f.id = l.folio_id
        WHERE f.company_id = "companies"."id" AND f.kind = 'company' AND f.reservation_id IS NULL
          AND l.voided_at IS NULL), 0)::text`,
    })
    .from(companies)
    .where(
      and(
        eq(companies.orgId, orgId),
        filter.kind ? eq(companies.kind, filter.kind) : undefined,
        filter.includeInactive ? undefined : eq(companies.active, true),
        like ? or(ilike(companies.name, like), ilike(companies.gstin, like)) : undefined,
      ),
    )
    .orderBy(asc(companies.name))
    .limit(500);
  return rows.map((r) => ({ ...r.company, outstanding: Number(r.outstanding) }));
}

export async function getCompany(
  db: DbOrTx,
  orgId: string,
  companyId: string,
): Promise<CompanyView> {
  const [row] = (await listCompanies(db, orgId, { includeInactive: true })).filter(
    (c) => c.id === companyId,
  );
  if (!row) throw notFound('Company', companyId);
  return row;
}

export interface AccountEntry {
  folioId: string;
  propertyId: string;
  propertyName: string;
  date: string;
  description: string;
  /** Positive: billed to the company. Negative: paid by it. */
  amount: number;
  /** Days since the entry, for amounts billed. */
  ageDays: number;
}

/** A company's account: what was billed to it and what it has paid, oldest first. */
export async function companyStatement(
  db: DbOrTx,
  orgId: string,
  companyId: string,
): Promise<{
  company: CompanyView;
  entries: AccountEntry[];
  accounts: { folioId: string; propertyName: string; balance: number }[];
}> {
  const company = await getCompany(db, orgId, companyId);
  const { rows } = await db.execute<{
    folio_id: string;
    property_id: string;
    property_name: string;
    business_date: string;
    description: string;
    amount: string;
    age: number;
  }>(sql`
    SELECT f.id AS folio_id, p.id AS property_id, p.name AS property_name,
           l.business_date::text, l.description, (l.amount + l.tax_amount)::text AS amount,
           (current_date - l.business_date)::int AS age
    FROM folio_lines l
    JOIN folios f ON f.id = l.folio_id
    JOIN properties p ON p.id = f.property_id
    WHERE f.company_id = ${companyId} AND f.kind = 'company' AND f.reservation_id IS NULL
      AND l.voided_at IS NULL AND p.org_id = ${orgId}
    ORDER BY l.business_date, l.seq
  `);
  const entries = rows.map((r) => ({
    folioId: r.folio_id,
    propertyId: r.property_id,
    propertyName: r.property_name,
    date: r.business_date,
    description: r.description,
    amount: Number(r.amount),
    ageDays: r.age,
  }));
  const accounts = new Map<string, { folioId: string; propertyName: string; balance: number }>();
  for (const entry of entries) {
    const account = accounts.get(entry.folioId) ?? {
      folioId: entry.folioId,
      propertyName: entry.propertyName,
      balance: 0,
    };
    account.balance += entry.amount;
    accounts.set(entry.folioId, account);
  }
  return { company, entries, accounts: [...accounts.values()] };
}
