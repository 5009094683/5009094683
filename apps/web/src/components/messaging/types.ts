import type { AutomationLogEntry, AutomationRuleRow, MessageTemplateRow } from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type MessageTemplate = Serialized<MessageTemplateRow>;
export type AutomationRule = Serialized<AutomationRuleRow>;
export type AutomationLog = Serialized<AutomationLogEntry>;

/** A way of reaching a guest: email, WhatsApp, or the message box of the booking site they booked on. */
export type MessageChannel = AutomationRule['channels'][number];
export type AutomationTrigger = AutomationRule['trigger'];
/** Where a booking came from, as far as an automatic message can be limited to it. */
export type BookingSource = NonNullable<AutomationRule['sources']>[number];

/** What `GET /messaging/templates` answers. */
export interface TemplatesAnswer {
  templates: MessageTemplate[];
  /** Each name that can stand in a template as `{{name}}`, with what it is replaced by. */
  variables: Record<string, string>;
}

/** What `GET /messaging/automations` answers. */
export interface AutomationsAnswer {
  rules: AutomationRule[];
  /** The last hundred times a rule wrote to a guest, or could not. Newest first. */
  log: AutomationLog[];
}
