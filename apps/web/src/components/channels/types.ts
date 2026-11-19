import type {
  ApplyResult,
  ChannexStatus,
  ChannexStructure,
  ConnectionSummary,
  IcalFeedInput,
  IcalFeedView,
  MailboxInput,
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

/** The kinds of connection a property can have. */
export type Kind = Connection['adapter'];

/**
 * One calendar of a calendar connection. The two addresses are left out for people who may look
 * at a connection but not change it.
 */
export type CalendarFeed = Omit<Serialized<IcalFeedView>, 'exportUrl'> & {
  exportUrl: string | null;
};
export type CalendarFeedInput = IcalFeedInput;

type MailboxFields = Omit<MailboxInput, 'password' | 'trustUnverifiedSenders'>;

/**
 * How a reservations mailbox is read, as the server gives it back. The password never comes
 * back, only whether one is stored. The server has no type of its own for this answer, so it is
 * built on the type of what is saved.
 */
export type MailboxSettings = {
  [Field in keyof MailboxFields]-?: NonNullable<MailboxFields[Field]> | null;
} & {
  trustUnverifiedSenders: boolean;
  hasPassword: boolean;
  /** Where a mail service can hand over emails instead. Null where the installation has not set that up. */
  forwardingUrl: string | null;
};
export type MailboxSaved = MailboxInput;
