import type {
  ApplyResult,
  ChannexStatus,
  ChannexStructure,
  ConnectionSummary,
  ProvisionResult,
  RevisionSummary,
  WebhookRegistration,
  WorkerStatus,
  connectionLog,
  getMappings,
  listChannexProperties,
} from '@pms/channels';
import type { Serialized } from '@/lib/types';

export type Connection = Serialized<ConnectionSummary>;
export type Revision = Serialized<RevisionSummary>;
export type Mappings = Serialized<Awaited<ReturnType<typeof getMappings>>>;
export type SyncLogRow = Serialized<Awaited<ReturnType<typeof connectionLog>>[number]>;
export type ChannelManagerAccount = Serialized<ChannexStatus>;
export type ChannelManagerStructure = Serialized<ChannexStructure>;
export type ChannelManagerProperty = Serialized<
  Awaited<ReturnType<typeof listChannexProperties>>[number]
>;
export type Provisioned = Serialized<ProvisionResult>;
export type Reapplied = Serialized<ApplyResult>;
export type AnnouncementRegistration = Serialized<WebhookRegistration>;

export interface ChannelsStatus {
  channex: Pick<ChannelManagerAccount, 'configured' | 'environment' | 'webhookSecured'>;
  worker: Serialized<WorkerStatus>;
  simulatorUrl: string | null;
}

export interface ConnectionDetail {
  connection: Connection;
  mappings: Mappings;
  log: SyncLogRow[];
}
