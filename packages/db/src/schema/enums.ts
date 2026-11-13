export const PROPERTY_KINDS = ['hotel', 'villa'] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const USER_STATUSES = ['active', 'invited', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLES = [
  'org_admin',
  'general_manager',
  'revenue_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
  'accountant',
  'read_only',
  'villa_owner',
] as const;
export type Role = (typeof ROLES)[number];

export const UNIT_ASSIGNMENT_MODES = ['at_booking', 'at_check_in'] as const;
export type UnitAssignmentMode = (typeof UNIT_ASSIGNMENT_MODES)[number];

export const HOUSEKEEPING_STATUSES = ['clean', 'dirty', 'inspected', 'out_of_service'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

export const MEAL_PLANS = [
  'room_only',
  'breakfast',
  'half_board',
  'full_board',
  'all_inclusive',
] as const;
export type MealPlan = (typeof MEAL_PLANS)[number];

export const RESERVATION_STATUSES = [
  'tentative',
  'confirmed',
  'in_house',
  'checked_out',
  'cancelled',
  'no_show',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Statuses in which a reservation room consumes inventory for its nights. */
export const INVENTORY_HOLDING_STATUSES = [
  'tentative',
  'confirmed',
  'in_house',
  'checked_out',
] as const satisfies readonly ReservationStatus[];

export const RESERVATION_SOURCES = [
  'direct',
  'walk_in',
  'phone',
  'website',
  'ota',
  'corporate',
  'travel_agent',
  'owner',
  'group',
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const PAYMENT_COLLECT = ['property', 'channel'] as const;
export type PaymentCollect = (typeof PAYMENT_COLLECT)[number];

export const BLOCK_KINDS = ['block', 'maintenance', 'owner_stay', 'hold'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCK_SOURCES = ['manual', 'ical', 'email', 'system', 'housekeeping'] as const;
export type BlockSource = (typeof BLOCK_SOURCES)[number];

export const CHANNEL_ADAPTERS = ['channex', 'ical', 'email'] as const;
export type ChannelAdapterKind = (typeof CHANNEL_ADAPTERS)[number];

export const CONNECTION_STATUSES = ['pending', 'active', 'paused', 'error', 'disabled'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const SYNC_KINDS = ['availability', 'restrictions'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const REVISION_STATUSES = [
  'received',
  'applied',
  'superseded',
  'unmapped',
  'failed',
] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACTOR_TYPES = ['user', 'system', 'channel', 'api_key', 'copilot', 'guest'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const COMPANY_KINDS = ['corporate', 'travel_agent'] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

export const FOLIO_KINDS = ['guest', 'company', 'house'] as const;
export type FolioKind = (typeof FOLIO_KINDS)[number];

export const FOLIO_STATUSES = ['open', 'closed'] as const;
export type FolioStatus = (typeof FOLIO_STATUSES)[number];

/** What a folio line is. Charges are positive amounts; payments, discounts and refunds of charges negative. */
export const FOLIO_LINE_KINDS = [
  'room',
  'food',
  'service',
  'extra',
  'fee',
  'discount',
  'payment',
  'refund',
  'transfer',
] as const;
export type FolioLineKind = (typeof FOLIO_LINE_KINDS)[number];

/** What a tax rule applies to. A charge is taxed by the rule for its category. */
export const TAX_CATEGORIES = ['room', 'food', 'service', 'extra', 'fee'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const PAYMENT_METHODS = [
  'cash',
  'card',
  'upi',
  'bank_transfer',
  'online',
  'channel',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['pending', 'captured', 'failed', 'voided'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const INVOICE_TYPES = ['invoice', 'credit_note'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const HOUSEKEEPING_TASK_KINDS = [
  'departure',
  'stayover',
  'touch_up',
  'deep_clean',
  'inspection',
] as const;
export type HousekeepingTaskKind = (typeof HOUSEKEEPING_TASK_KINDS)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAINTENANCE_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** SQL fragment helper: `'a','b','c'` for CHECK constraints. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}
