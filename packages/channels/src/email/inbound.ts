import { and, eq } from 'drizzle-orm';
import { channelConnections, properties, type Database } from '@pms/db';
import { notFound, validationError, writeAudit, type Actor } from '@pms/domain';
import { emailToEventWithFallback, parseMime, type EmailConnectionConfig } from './adapter';
import { ingestBookingEvent, type IngestResult } from '../engine/inbound';
import { requireConnection, updateConnection } from '../engine/connections';

export type InboundEmailOutcome =
  | { handled: true; result: IngestResult }
  /** The email is not about a booking, or is addressed to someone else. */
  | { handled: false; reason: 'not_a_booking' | 'other_recipient' | 'connection_off' };

/**
 * Takes one email handed over by a mail service (forwarding, or an "inbound
 * mail" hook) and runs it through the same pipeline as mail read from the
 * mailbox. The same email handed over twice is recorded once.
 */
export async function ingestInboundEmail(
  db: Database,
  connectionId: string,
  source: Buffer | string,
): Promise<InboundEmailOutcome> {
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.adapter, 'email')));
  if (!connection) throw notFound('Mailbox connection', connectionId);
  if (connection.status !== 'active' && connection.status !== 'error') {
    return { handled: false, reason: 'connection_off' };
  }
  const config = connection.config as EmailConnectionConfig;
  const message = await parseMime(source);
  if (config.recipient && !message.to.includes(config.recipient.toLowerCase())) {
    return { handled: false, reason: 'other_recipient' };
  }
  const event = await emailToEventWithFallback(
    message,
    {
      dayFirst: config.dayFirst ?? true,
      currency: config.currency ?? 'INR',
      trustUnverifiedSenders: config.trustUnverifiedSenders ?? false,
    },
    { orgId: connection.orgId },
  );
  if (!event) return { handled: false, reason: 'not_a_booking' };
  return { handled: true, result: await ingestBookingEvent(db, connection, event, 'webhook') };
}

export interface MailboxInput {
  host?: string | null;
  port?: number | null;
  user?: string | null;
  /** Omit to keep the stored password. */
  password?: string | null;
  folder?: string | null;
  recipient?: string | null;
  trustUnverifiedSenders?: boolean;
}

/**
 * Saves how a property's reservations mailbox is read. How dates and amounts
 * are read is taken from the property: day-first dates everywhere except the
 * United States, and the property's currency for amounts that name none.
 */
export async function saveMailbox(
  db: Database,
  actor: Actor,
  connectionId: string,
  input: MailboxInput,
): Promise<void> {
  const connection = await requireConnection(db, actor.orgId, connectionId);
  if (connection.adapter !== 'email') throw validationError('This is not a mailbox connection');
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  const before = connection.config as EmailConnectionConfig;
  const host = input.host === undefined ? before.mailbox?.host : input.host?.trim() || undefined;
  const user = input.user === undefined ? before.mailbox?.user : input.user?.trim() || undefined;
  if (host && !/^[a-z0-9.-]+$/i.test(host))
    throw validationError('The mail server name is not valid');
  const port = input.port === undefined ? before.mailbox?.port : (input.port ?? undefined);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw validationError('The mail server port must be between 1 and 65535');
  }
  // Half a mailbox cannot be read, and fails later in words that do not say what is missing.
  if (Boolean(host) !== Boolean(user)) {
    throw validationError('Enter the mail server and the user name together, or leave both empty');
  }
  if (host && !input.password && connection.secretsEnc === null) {
    throw validationError('Enter the password of the mailbox');
  }
  // With no mailbox left to read, the password that was kept for it is forgotten.
  const forgetPassword = !host && !input.password && connection.secretsEnc !== null;
  const config: EmailConnectionConfig = {
    ...before,
    mailbox: {
      host,
      user,
      port,
      folder:
        input.folder === undefined ? before.mailbox?.folder : input.folder?.trim() || undefined,
    },
    recipient:
      input.recipient === undefined
        ? before.recipient
        : input.recipient?.trim().toLowerCase() || undefined,
    trustUnverifiedSenders: input.trustUnverifiedSenders ?? before.trustUnverifiedSenders ?? false,
    dayFirst: property!.country.toUpperCase() !== 'US',
    currency: property!.currency,
  };
  await updateConnection(db, actor, connectionId, {
    config: { ...config },
    ...(input.password ? { secrets: { password: input.password } } : {}),
  });
  // A different mailbox means the remembered position no longer applies.
  if (host !== before.mailbox?.host || user !== before.mailbox?.user) {
    await db
      .update(channelConnections)
      .set({ state: {} })
      .where(eq(channelConnections.id, connectionId));
  }
  if (forgetPassword) {
    await db
      .update(channelConnections)
      .set({ secretsEnc: null })
      .where(eq(channelConnections.id, connectionId));
  }
  await writeAudit(db, actor, {
    action: 'channel.mailbox_saved',
    entityType: 'channel_connection',
    entityId: connectionId,
    propertyId: connection.propertyId,
    summary: `Saved the reservations mailbox settings for ${property!.name}`,
    changes: {
      host,
      user,
      passwordChanged: Boolean(input.password),
      ...(forgetPassword ? { passwordForgotten: true } : {}),
    },
  });
}
