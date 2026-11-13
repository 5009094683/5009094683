import type { ReportKind } from '@pms/db';

/**
 * What each report is called: on its tab, in the list of reports that can be sent by email,
 * at the top of its spreadsheet and in the email that carries it.
 */
export const REPORT_TITLES: Record<ReportKind, string> = {
  performance: 'Occupancy and rates',
  channel_mix: 'Where bookings come from',
  pace: 'Pace',
  revenue: 'Charges and takings',
  agent_commission: 'Travel agent commission',
};
