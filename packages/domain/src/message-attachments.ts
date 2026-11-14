import { and, eq } from 'drizzle-orm';
import { conversations, messages, type DbOrTx, type MessageAttachment } from '@pms/db';
import { DomainError, notFound } from './errors';
import { enqueueJob } from './jobs';
import { PermanentSendError, type ConversationRow, type MessageRow } from './inbox';
import { emit } from './outbox';
import { readStoredFile, storeFile, type FileStore, type StoredFileRow } from './storage';
import type { WhatsAppClient } from './transports/whatsapp';

export const ATTACHMENT_JOBS = { fetchWhatsApp: 'message.fetch_media' } as const;

/** Files a guest sent are kept this long, and less when the guest is erased before. */
export const ATTACHMENT_KEEP_DAYS = 180;
const MAX_KEPT_PER_MESSAGE = 10;

export interface ReceivedFile {
  /** Which of the message's attachments this is the content of. */
  index: number;
  name: string;
  data: Buffer;
}

/**
 * Keeps the files that came with a guest's message, encrypted like every
 * other stored file, and notes on the message where each one is. Only photos
 * and PDFs are kept (judged by content, not by name); anything else stays a
 * name in the thread. Returns how many were kept.
 */
export async function keepAttachments(
  db: DbOrTx,
  store: FileStore,
  message: MessageRow,
  conversation: Pick<
    ConversationRow,
    'id' | 'propertyId' | 'reservationId' | 'guestId' | 'channel'
  >,
  files: ReceivedFile[],
  now: Date = new Date(),
): Promise<number> {
  const attachments: MessageAttachment[] = message.attachments.map((a) => ({ ...a }));
  const deleteAfter = new Date(now.getTime() + ATTACHMENT_KEEP_DAYS * 86_400_000);
  let kept = 0;
  for (const file of files.slice(0, MAX_KEPT_PER_MESSAGE)) {
    const attachment = attachments[file.index];
    if (!attachment || attachment.fileId) continue;
    let stored: StoredFileRow;
    try {
      stored = await storeFile(db, store, {
        orgId: message.orgId,
        propertyId: conversation.propertyId,
        reservationId: conversation.reservationId,
        guestId: conversation.guestId,
        kind: 'message_attachment',
        fileName: file.name,
        data: file.data,
        deleteAfter,
      });
    } catch (err) {
      // Too large, empty, or not a photo or PDF: the name alone stays in the thread.
      if (err instanceof DomainError) continue;
      throw err;
    }
    attachment.fileId = stored.id;
    attachment.contentType = stored.contentType;
    attachment.size = stored.size;
    kept++;
  }
  if (kept === 0) return 0;
  await db.update(messages).set({ attachments }).where(eq(messages.id, message.id));
  await emit(db, message.orgId, [
    {
      kind: 'message.received',
      propertyId: conversation.propertyId,
      payload: {
        conversationId: conversation.id,
        channel: conversation.channel,
        attachments: true,
      },
    },
  ]);
  return kept;
}

/** Asks the worker to fetch the photo or document of a WhatsApp message. */
export async function queueWhatsAppMedia(
  db: DbOrTx,
  messageId: string,
  media: { id: string; fileName: string | null },
): Promise<void> {
  await enqueueJob(
    db,
    ATTACHMENT_JOBS.fetchWhatsApp,
    { messageId, mediaId: media.id, fileName: media.fileName },
    { uniqueKey: `${ATTACHMENT_JOBS.fetchWhatsApp}:${messageId}`, maxAttempts: 5 },
  );
}

/**
 * Fetches the file of a WhatsApp message and keeps it. Run by the worker. A
 * failure that may pass is thrown so the job is tried again; one that will
 * not is reported and the name alone stays in the thread.
 */
export async function fetchWhatsAppMedia(
  db: DbOrTx,
  store: FileStore,
  client: Pick<WhatsAppClient, 'downloadMedia'>,
  input: { messageId: string; mediaId: string; fileName?: string | null },
): Promise<{ kept: boolean; reason?: string }> {
  const [row] = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, input.messageId));
  if (!row) return { kept: false, reason: 'The message no longer exists' };
  if (row.message.attachments.length === 0 || row.message.attachments[0]!.fileId) {
    return { kept: false, reason: 'Nothing to fetch' };
  }
  let media: { data: Buffer; mimeType: string | null };
  try {
    media = await client.downloadMedia(input.mediaId);
  } catch (err) {
    if (err instanceof PermanentSendError) return { kept: false, reason: err.message };
    throw err;
  }
  const extension = media.mimeType?.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg');
  const name =
    input.fileName ?? `${row.message.attachments[0]!.name}${extension ? `.${extension}` : ''}`;
  const kept = await keepAttachments(db, store, row.message, row.conversation, [
    { index: 0, name, data: media.data },
  ]);
  return kept > 0 ? { kept: true } : { kept: false, reason: 'Only photos and PDF files are kept' };
}

/** One kept attachment of a message, for someone who may read its conversation. */
export async function readAttachment(
  db: DbOrTx,
  store: FileStore,
  orgId: string,
  messageId: string,
  fileId: string,
): Promise<{ file: StoredFileRow; data: Buffer }> {
  const [message] = await db
    .select({ attachments: messages.attachments })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)));
  // The file must belong to this message: knowing a file's id is not a way to read it.
  if (!message?.attachments.some((a) => a.fileId === fileId)) throw notFound('Attachment', fileId);
  return readStoredFile(db, store, orgId, fileId);
}
