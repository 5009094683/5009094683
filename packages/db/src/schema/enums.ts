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

/** SQL fragment helper: `'a','b','c'` for CHECK constraints. */
export function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(',');
}
