import type { Env } from '@pms/config';
import type { Database } from '@pms/db';
import {
  emailTransport,
  registerTransport,
  WhatsAppClient,
  whatsappConfig,
  whatsappTransport,
  type Mailer,
} from '@pms/domain';
import { hasAdapter, registerAdapter } from './adapter';
import { channexAdapter } from './channex/adapter';
import { emailAdapter } from './email/adapter';
import { otaTransport } from './engine/messages';
import { icalAdapter } from './ical/adapter';

/**
 * Makes the built-in routes available to the engine. Called at start-up by
 * every process that touches connections (the API and the worker). A kind
 * that already has an adapter (a test double, say) keeps it.
 */
export function registerDefaultAdapters(): void {
  if (!hasAdapter('channex')) registerAdapter('channex', channexAdapter);
  if (!hasAdapter('ical')) registerAdapter('ical', icalAdapter);
  if (!hasAdapter('email')) registerAdapter('email', emailAdapter);
}

/**
 * Makes the three ways of writing to a guest available to the inbox: email,
 * WhatsApp and the booking sites' own message boxes. Called once by every
 * process that sends messages or says whether they can be sent.
 */
export function registerMessageTransports(
  db: Database,
  env: Pick<
    Env,
    | 'INBOX_REPLY_ADDRESS'
    | 'WHATSAPP_ACCESS_TOKEN'
    | 'WHATSAPP_PHONE_NUMBER_ID'
    | 'WHATSAPP_API_VERSION'
  >,
  mailer: Mailer,
): void {
  registerTransport(emailTransport(db, mailer, { replyAddress: env.INBOX_REPLY_ADDRESS }));
  const whatsapp = whatsappConfig(env);
  registerTransport(whatsappTransport(whatsapp ? new WhatsAppClient(whatsapp) : null));
  registerTransport(otaTransport(db));
}
