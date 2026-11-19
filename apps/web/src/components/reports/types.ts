import type {
  ChannelMixReport,
  ChannelMixRow,
  PaceReport,
  PaceRow,
  PerformanceGrouping,
  PerformanceReport,
  PerformanceRow,
  ReportScheduleInput,
  ReportScheduleRow,
  RevenueDay,
  RevenueReport,
  agentCommissionReport,
  sendScheduledReport,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Performance = Serialized<PerformanceReport>;
export type PerformanceLine = Serialized<PerformanceRow>;
export type PerformanceGroup = PerformanceGrouping;

export type ChannelMix = Serialized<ChannelMixReport>;
export type ChannelMixLine = Serialized<ChannelMixRow>;
export type ChannelMixTotal = ChannelMix['total'];

export type Pace = Serialized<PaceReport>;
export type PaceLine = Serialized<PaceRow>;
export type PaceTotal = Pace['total'];
export type PaceGroup = Pace['groupBy'];

export type Takings = Serialized<RevenueReport>;
export type TakingsDay = Serialized<RevenueDay>;
export type TakingsTotal = Takings['total'];
export type PaymentMethod = keyof TakingsTotal['payments'];

export type AgentCommission = Serialized<Awaited<ReturnType<typeof agentCommissionReport>>>;
export type AgentLine = AgentCommission['rows'][number];

export type Schedule = Serialized<ReportScheduleRow>;
export type ScheduleBody = ReportScheduleInput;
export type ReportKind = Schedule['report'];
export type ReportPeriod = Schedule['period'];
export type ReportFrequency = Schedule['frequency'];
export type SendResult = Serialized<Awaited<ReturnType<typeof sendScheduledReport>>>;

/** What `GET /reports/schedules` answers. */
export interface SchedulesAnswer {
  schedules: Schedule[];
  mailConfigured: boolean;
}
