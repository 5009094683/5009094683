import type { ContractView, OwnerExpenseRow, OwnerView, StatementView } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Owner = Serialized<OwnerView>;
export type OwnerSignIn = NonNullable<Owner['user']>;
export type Contract = Serialized<ContractView>;
export type ContractModel = Contract['model'];
export type FeeBasis = Contract['feeBasis'];

export type Expense = Serialized<OwnerExpenseRow>;
export type ExpenseCategory = Expense['category'];

export type Statement = Serialized<StatementView>;
export type StatementStatus = Statement['status'];
export type StatementStay = Statement['lines']['stays'][number];
export type StatementExpense = Statement['lines']['expenses'][number];
export type StatementAdjustment = Statement['lines']['adjustments'][number];

/** What issuing a statement answers with: the statement, and whether the owner was emailed. */
export type IssuedStatement = Statement & { ownerEmailed: boolean };

/** The answer to inviting an owner to the portal. */
export interface PortalInvite {
  userId: string;
  /** Absent only when the sign-in was created with a password, which this screen never does. */
  inviteLink?: string;
  inviteEmailed: boolean;
}
