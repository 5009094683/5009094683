import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { conversations, guests, messages, properties, type DbOrTx } from '@pms/db';
import {
  PermanentSendError,
  receiveMessage,
  threadKey,
  type MessageTransport,
  type Received,
} from '../inbox';
import type { Mailer } from '../mailer';
import { keepAttachments } from '../message-attachments';
import type { FileStore } from '../storage';

/**
 * Sends inbox messages as email. Replies are asked for at `replyAddress` when
 * one is configured (its mail is fed back into the inbox), otherwise at the
 * property's own address.
 */
export function emailTransport(
  db: DbOrTx,
  mailer: Mailer,
  options: { replyAddress?: string } = {},
): MessageTransport {
  return {
    channel: 'email',
    unavailable(target) {
      if (!mailer.configured)
        return 'Email is not set up: no mail server (SMTP_URL) is configured.';
      if (!target.contactAddress) return 'There is no email address for this guest.';
      return null;
    },
    async send(conversation, message) {
      const [property] = conversation.propertyId
        ? await db
            .select({ name: properties.name, email: properties.email })
            .from(properties)
            .where(eq(properties.id, conversation.propertyId))
        : [];
      // Answering the guest's last email keeps the exchange in one thread in their mail client.
      const [last] = await db
        .select({ meta: messages.meta, subject: messages.subject })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'in'),
            sql`${messages.meta}->>'messageId' IS NOT NULL`,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const lastId = typeof last?.meta.messageId === 'string' ? last.meta.messageId : undefined;
      const inReplyTo = lastId ? `<${lastId.replace(/^<|>$/g, '')}>` : undefined;
      const subject =
        message.subject ??
        (last?.subject ? `Re: ${last.subject.replace(/^(re:\s*)+/i, '')}` : null) ??
        conversation.subject ??
        `Message from ${property?.name ?? 'your hotel'}`;
      const result = await mailer.send({
        to: conversation.contactAddress!,
        subject,
        text: message.body,
        replyTo: options.replyAddress ?? property?.email ?? undefined,
        inReplyTo,
        references: inReplyTo ? [inReplyTo] : undefined,
      });
      if (!result.delivered) throw new PermanentSendError('The mail server is not configured.');
      return { externalId: result.messageId ?? null };
    },
  };
}

export interface GuestEmail {
  from: string;
  fromName?: string | null;
  subject?: string | null;
  text: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date | null;
  attachments?: {
    name: string;
    contentType?: string | null;
    size?: number | null;
    /** The file itself, when it is to be kept. */
    content?: Buffer;
  }[];
}

/**
 * Cuts the copy of the earlier message that mail programs put under a reply,
 * so the inbox shows what the guest wrote and not the whole exchange again.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const markers = [
    /^On .{6,200}wrote:\s*$/i,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^_{10,}\s*$/,
    /^From: .+$/i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // "From:" only counts as the start of a quoted message when a mail header block follows it.
    if (
      /^From: /i.test(line) &&
      !/^(Sent|Date|To|Subject): /im.test(lines.slice(i + 1, i + 5).join('\n'))
    ) {
      continue;
    }
    if (markers.some((m) => m.test(line))) {
      cut = i;
      break;
    }
  }
  let kept = lines.slice(0, cut);
  // A block of "> quoted" lines at the very end is also the earlier message.
  while (
    kept.length > 0 &&
    (/^\s*>/.test(kept[kept.length - 1]!) || kept[kept.length - 1]!.trim() === '')
  ) {
    kept = kept.slice(0, -1);
  }
  const result = kept.join('\n').trim();
  return result || text.trim();
}

/**
 * Puts an email from a guest into the inbox. Mail is accepted only from an
 * address already in conversation, an address on a guest profile, or in
 * answer to a message sent from the inbox; anything else is left alone, so a
 * shared mailbox's other mail and spam do not flood the inbox. Returns null
 * for mail that was left alone.
 */
export async function receiveGuestEmail(
  db: DbOrTx,
  orgId: string,
  mail: GuestEmail,
  /** Where to keep the photos and PDFs that came with it. Without one, only their names are kept. */
  store?: FileStore,
): Promise<Received | null> {
  const from = threadKey('email', mail.from);
  if (!/^[^\s@]+@[^\s@]+$/.test(from)) return null;
  const [thread] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.channel, 'email'),
        eq(conversations.externalThreadId, from),
      ),
    );
  let known = Boolean(thread);
  if (!known) {
    const [guest] = await db
      .select({ id: guests.id })
      .from(guests)
      .where(
        and(eq(guests.orgId, orgId), eq(guests.email, from), sql`${guests.anonymizedAt} IS NULL`),
      )
      .limit(1);
    known = Boolean(guest);
  }
  // Mail programs and libraries disagree on whether an id carries its angle brackets: try both.
  const answered = [mail.inReplyTo, ...(mail.references ?? [])]
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 20)
    .flatMap((id) => {
      const bare = id.replace(/^<|>$/g, '');
      return [bare, `<${bare}>`];
    });
  if (!known && answered.length > 0) {
    const [ours] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.direction, 'out'),
          inArray(messages.externalId, answered),
        ),
      )
      .limit(1);
    known = Boolean(ours);
  }
  if (!known) return null;
  const received = await receiveMessage(db, {
    orgId,
    channel: 'email',
    externalThreadId: from,
    externalId: mail.messageId ?? null,
    contactName: mail.fromName ?? null,
    contactAddress: from,
    subject: mail.subject ?? null,
    body: stripQuotedReply(mail.text),
    attachments: (mail.attachments ?? []).map((a) => ({
      name: a.name,
      contentType: a.contentType ?? null,
      size: a.size ?? null,
    })),
    receivedAt: mail.date ?? undefined,
    meta: mail.messageId ? { messageId: mail.messageId } : {},
  });
  if (store && received.message) {
    const files = (mail.attachments ?? []).flatMap((a, index) =>
      a.content ? [{ index, name: a.name, data: a.content }] : [],
    );
    if (files.length > 0) {
      await keepAttachments(db, store, received.message, received.conversation, files);
    }
  }
  return received;
}
