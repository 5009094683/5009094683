import { REPORT_TITLES } from '@pms/domain/shared';
import type { PaceGroup, PerformanceGroup } from './types';

// Each report is called the same thing here, at the top of its spreadsheet and in its email.
export const VIEWS = [
  { key: 'performance', label: REPORT_TITLES.performance },
  { key: 'sources', label: REPORT_TITLES.channel_mix },
  { key: 'pace', label: REPORT_TITLES.pace },
  { key: 'takings', label: REPORT_TITLES.revenue },
  { key: 'agents', label: REPORT_TITLES.agent_commission },
  { key: 'schedules', label: 'Scheduled emails' },
] as const;

export type ViewKey = (typeof VIEWS)[number]['key'];
export type ReportKey = Exclude<ViewKey, 'schedules'>;

export const DEFAULT_VIEW: ViewKey = 'performance';

export function viewLabel(view: ViewKey): string {
  return VIEWS.find((entry) => entry.key === view)?.label ?? '';
}

export const ENDPOINTS: Record<ReportKey, string> = {
  performance: '/reports/performance',
  sources: '/reports/channel-mix',
  pace: '/reports/pace',
  takings: '/reports/revenue',
  agents: '/reports/agent-commission',
};

const PERFORMANCE_GROUP_LABELS: Record<PerformanceGroup, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  property: 'Property',
  room_type: 'Room type',
};

const PACE_GROUP_LABELS: Record<PaceGroup, string> = { day: 'Day', month: 'Month' };

const options = <T extends string>(labels: Record<T, string>): { value: T; label: string }[] =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

export const PERFORMANCE_GROUPS = options(PERFORMANCE_GROUP_LABELS);
export const PACE_GROUPS = options(PACE_GROUP_LABELS);

/** Past this many days a day-by-day report is too long to read, so it starts out grouped. */
const DAYS_BY_DAY = 62;
const DAYS_BY_WEEK = 190;

/** How a performance report is grouped: as asked for, else by what suits the length of the period. */
export function performanceGroup(asked: string | null, days: number): PerformanceGroup {
  const known = PERFORMANCE_GROUPS.find((option) => option.value === asked);
  if (known) return known.value;
  return days <= DAYS_BY_DAY ? 'day' : days <= DAYS_BY_WEEK ? 'week' : 'month';
}

export function paceGroup(asked: string | null, days: number): PaceGroup {
  const known = PACE_GROUPS.find((option) => option.value === asked);
  if (known) return known.value;
  return days <= DAYS_BY_DAY ? 'day' : 'month';
}
