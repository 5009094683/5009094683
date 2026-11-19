import { Globe, Mail, MessageCircle, type LucideIcon } from 'lucide-react';
import { CHANNEL_NAMES } from '@/lib/format';
import type {
  AssignedFilter,
  Attachment,
  Channel,
  Conversation,
  ConversationStatus,
  Message,
  StatusFilter,
} from './types';

export const CHANNEL_ICONS: Record<Channel, LucideIcon> = {
  ota: Globe,
  whatsapp: MessageCircle,
  email: Mail,
};

/** The ways a message can arrive, as the filter and the "new message" choices name them. */
export const CHANNEL_KINDS: { value: Channel; label: string }[] = [
  { value: 'ota', label: 'Booking sites' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
];

/** The name of a booking site from the code a reservation carries. */
export function bookingSiteName(channelCode: string | null | undefined): string | null {
  if (!channelCode) return null;
  return CHANNEL_NAMES[channelCode.toUpperCase()] ?? channelCode;
}

/**
 * What staff call the channel of a conversation: the booking site itself when the conversation
 * says which one it is, else the one its reservation came from.
 */
export function channelName(
  conversation: Pick<Conversation, 'channel' | 'meta'> &
    Partial<Pick<Conversation, 'reservationChannelCode'>>,
): string {
  if (conversation.channel === 'email') return 'Email';
  if (conversation.channel === 'whatsapp') return 'WhatsApp';
  const provider = conversation.meta.provider;
  if (typeof provider === 'string' && provider.trim()) return provider.trim();
  return bookingSiteName(conversation.reservationChannelCode) ?? 'Booking site';
}

export const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'open', label: 'Open' },
  { value: 'waiting', label: 'Waiting for guest' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export const ASSIGNED_OPTIONS: { value: AssignedFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'me', label: 'Mine' },
  { value: 'none', label: 'Unassigned' },
];

export const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: 'Open',
  waiting: 'Waiting for guest',
  closed: 'Closed',
};

export const STATUS_TONES: Record<ConversationStatus, 'brand' | 'info' | 'neutral'> = {
  open: 'brand',
  waiting: 'info',
  closed: 'neutral',
};

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const shortDayYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const longDay = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const longDayYear = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const dayAndClock = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** How many of the viewer's own calendar days lie between two moments. */
function daysBetween(then: Date, now: Date): number {
  const from = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const to = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((to - from) / 86_400_000);
}

/** The viewer's own calendar day of a moment, to group messages by. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** `14:05` */
export const clockTime = (iso: string): string => clock.format(new Date(iso));

/** `Fri 13 Nov 2026, 14:05`, for the full moment behind a short one. */
export const fullTime = (iso: string): string => dayAndClock.format(new Date(iso));

/** When a conversation last moved: the time today, then `Yesterday`, then the date. */
export function listTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const days = daysBetween(then, now);
  if (days <= 0) return clock.format(then);
  if (days === 1) return 'Yesterday';
  return then.getFullYear() === now.getFullYear()
    ? shortDay.format(then)
    : shortDayYear.format(then);
}

/** The heading over a day of messages: `Today`, `Yesterday`, `Thursday 12 November`. */
export function dayLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  const days = daysBetween(then, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.getFullYear() === now.getFullYear() ? longDay.format(then) : longDayYear.format(then);
}

let languageNames: Intl.DisplayNames | undefined;

/** `French` from `fr`; the code itself when the browser does not know it. */
export function languageName(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return languageNames.of(code.toLowerCase()) ?? code;
  } catch {
    return code;
  }
}

/** A message the booking site wrote itself (a confirmation, a reminder), not the guest or the property. */
export const isSystemMessage = (message: Pick<Message, 'meta'>): boolean =>
  message.meta.system === true;

/** A note colleagues left on the conversation: never sent to the guest. */
export const isStaffNote = (message: Pick<Message, 'kind'>): boolean => message.kind === 'note';

/** What an outgoing message's state is called. */
export function deliveryLabel(status: Message['status']): string {
  switch (status) {
    case 'queued':
      return 'Sending';
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Delivered';
    case 'read':
      return 'Read';
    case 'failed':
      return 'Not sent';
    case 'received':
      return 'Received';
  }
}

/** Where an attachment can be opened: a file kept here, or the web address the channel gave for it. */
export function attachmentLink(attachment: Attachment, messageId: string | null): string | null {
  if (attachment.fileId && messageId) {
    return `/api/inbox/messages/${messageId}/attachments/${attachment.fileId}`;
  }
  if (!attachment.url) return null;
  try {
    const url = new URL(attachment.url);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** `240 KB`, `1.4 MB` */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
