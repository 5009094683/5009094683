import type {
  AccountEntry,
  CompanyView,
  InvoiceRow,
  NightAuditRow,
  NightAuditStatus,
  TaxRuleRow,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Invoice = Serialized<InvoiceRow>;
export type InvoiceLine = Invoice['lines'][number];
export type InvoiceParty = Invoice['seller'];
export type InvoiceType = Invoice['type'];

export type Company = Serialized<CompanyView>;
export type CompanyKind = Company['kind'];

export type StatementEntry = Serialized<AccountEntry>;

/** What a company owes at one property. Payments are recorded against it. */
export interface StatementAccount {
  folioId: string;
  propertyName: string;
  balance: number;
}

export interface Statement {
  company: Company;
  entries: StatementEntry[];
  accounts: StatementAccount[];
}

export type NightAudit = Serialized<NightAuditRow>;
export type AuditStatus = Serialized<NightAuditStatus>;

export type TaxRule = Serialized<TaxRuleRow>;
export type TaxCategory = TaxRule['category'];
export type TaxSlab = TaxRule['slabs'][number];
export type TaxComponent = TaxRule['components'][number];
