import type {
  ConversationDetail,
  ConversationPage as DomainConversationPage,
  ConversationRow,
  ConversationSummary,
  MessageRow,
  RenderedTemplate,
  TemplateSend,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type Conversation = Serialized<ConversationSummary>;
/** What starting or changing a conversation answers with: the row, without the names joined on. */
export type ConversationRecord = Serialized<ConversationRow>;
export type ConversationWithMessages = Serialized<ConversationDetail>;
export type Message = Serialized<MessageRow>;
export type Attachment = Message['attachments'][number];
/** A template filled in by the server for the guest of one conversation. */
export type MessageTemplate = Serialized<RenderedTemplate>;
export type Channel = Conversation['channel'];
export type ConversationStatus = Conversation['status'];
export type TemplateSendResult = Serialized<{ sent: TemplateSend | null; problems: string[] }>;
export type ConversationPage = Serialized<DomainConversationPage>;

export interface TemplateList {
  templates: MessageTemplate[];
  /** Every placeholder name, with what it stands for. */
  variables: Record<string, string>;
}

/**
 * The answer of `POST /inbox/conversations/:id/draft`: `ReplyDraft` in
 * `packages/ai/src/replies.ts`. The web app does not depend on that package, so the shape is
 * repeated here.
 */
export interface ReplyDraft {
  draft: string | null;
  /** Two-letter code of the language the draft is written in. */
  language: string | null;
  /** The draft in English, when it is in another language. */
  translation: string | null;
  needsStaff: boolean;
  reason: string | null;
  source: 'llm' | 'rules';
}

export interface AiStatus {
  provider: string | null;
}

export interface Translation {
  translation: string;
  sourceLanguage: string | null;
}

/** Someone a conversation can be given to, as `GET /inbox/assignees` lists them. */
export interface StaffMember {
  id: string;
  name: string;
}

export type StatusFilter = 'active' | ConversationStatus | 'all';
export type AssignedFilter = 'all' | 'me' | 'none';

export interface Filters {
  status: StatusFilter;
  channel: Channel | '';
  assigned: AssignedFilter;
  search: string;
}

/**
 * A reply written here. It shows at once, before the server has answered; `sent` is the
 * server's answer, which stands in until the conversation is read again and holds the message.
 */
export interface LocalMessage {
  localId: string;
  body: string;
  /** The subject it goes under, when a template brought one for an email. */
  subject: string | null;
  aiDrafted: boolean;
  createdAt: string;
  sent: Message | null;
}

/** What the thread shows of a message. One that is still on its way to the server has no id. */
export type ThreadMessage = Pick<
  Message,
  | 'direction'
  | 'kind'
  | 'body'
  | 'subject'
  | 'attachments'
  | 'status'
  | 'error'
  | 'attempts'
  | 'sentBy'
  | 'senderName'
  | 'aiDrafted'
  | 'meta'
  | 'createdAt'
> & { id: string | null };
