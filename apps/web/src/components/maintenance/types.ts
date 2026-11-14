import type { MaintenanceIssueView } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Issue = Serialized<MaintenanceIssueView>;
export type IssueStatus = Issue['status'];
export type Priority = Issue['priority'];
export type StatusFilter = 'open' | 'done' | 'all';

/** Dates a room is off sale: `to` is the first night it can be sold again. */
export interface OffSale {
  from: string;
  to: string;
}
