import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { paymentOrders, webhookEvents } from '@pms/db';
import { parseMime } from '@pms/channels';
import {
  DomainError,
  organizationForSender,
  queueWhatsAppMedia,
  receiveGuestEmail,
  receiveMessage,
  readWhatsAppWebhook,
  recordDeliveryReceipt,
  syncPaymentOrder,
  validationError,
  verifyWhatsAppSignature,
} from '@pms/domain';

const rawOf = (req: FastifyRequest): Buffer =>
  Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

function sameSecret(expected: string | undefined, given: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Calls made to the PMS by the payment gateway, by WhatsApp and by a mail
 * service handing over a guest's email. Each is authenticated by its own
 * signature or secret, computed over the body exactly as it arrived, which
 * is why this plugin reads bodies as raw bytes.
 */
export async function engagementWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.removeContentTypeParser('application/json');
  for (const type of ['application/json', 'message/rfc822', 'text/plain']) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  // ---------------------------------------------------------------------------
  // Payment gateway

  app.post(
    '/webhooks/payments/:provider',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
      schema: { tags: ['webhooks'], summary: 'Payment gateway notifications' },
    },
    async (req, reply) => {
      const { provider } = req.params as { provider: string };
      const gateway = app.gateway();
      if (provider !== gateway.name) {
        throw new DomainError('not_found', 'No such payment gateway is in use');
      }
      const verdict = gateway.readWebhook({ headers: req.headers, rawBody: rawOf(req) });
      if (!verdict.ok) {
        req.log.warn({ reason: verdict.reason, provider }, 'refused a payment webhook call');
        throw new DomainError('unauthenticated', 'Webhook verification failed');
      }
      await app.db.insert(webhookEvents).values({
        source: `payments:${provider}`,
        eventType: verdict.event,
        // Only what identifies the order is kept: payment bodies can carry card and contact details.
        payload: { orderIds: verdict.orderIds },
        processedAt: new Date(),
      });
      // The call only says "look": what happened is read from the gateway itself.
      let checked = 0;
      for (const providerOrderId of verdict.orderIds) {
        const [order] = await app.db
          .select({ id: paymentOrders.id })
          .from(paymentOrders)
          .where(
            and(
              eq(paymentOrders.provider, provider),
              eq(paymentOrders.providerOrderId, providerOrderId),
            ),
          );
        if (!order) continue;
        // A failure here answers 5xx, and the gateway delivers again later.
        await syncPaymentOrder(app.db, gateway, order.id);
        checked++;
      }
      return reply.status(200).send({ received: true, checked });
    },
  );

  // ---------------------------------------------------------------------------
  // WhatsApp

  // Meta checks the address once, when the webhook is set up, by asking for a value to be echoed.
  app.get(
    '/webhooks/whatsapp',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { hide: true },
    },
    async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      if (
        query['hub.mode'] === 'subscribe' &&
        sameSecret(app.env.WHATSAPP_VERIFY_TOKEN, query['hub.verify_token'] ?? '')
      ) {
        return reply.type('text/plain').send(query['hub.challenge'] ?? '');
      }
      throw new DomainError('forbidden', 'The verify token does not match');
    },
  );

  app.post(
    '/webhooks/whatsapp',
    {
      config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
      schema: { tags: ['webhooks'], summary: 'WhatsApp messages and delivery receipts' },
    },
    async (req, reply) => {
      const rawBody = rawOf(req);
      const secret = app.env.WHATSAPP_APP_SECRET;
      const signature = req.headers['x-hub-signature-256'];
      if (
        !secret ||
        !verifyWhatsAppSignature(
          secret,
          rawBody,
          Array.isArray(signature) ? signature[0] : signature,
        )
      ) {
        req.log.warn('refused a WhatsApp webhook call');
        throw new DomainError('unauthenticated', 'Webhook verification failed');
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw validationError('The webhook body is not valid JSON');
      }
      const { messages, receipts } = readWhatsAppWebhook(body);
      let stored = 0;
      for (const message of messages) {
        // A number other than ours means the webhook is shared with another app: not for this inbox.
        if (
          message.phoneNumberId &&
          app.env.WHATSAPP_PHONE_NUMBER_ID &&
          message.phoneNumberId !== app.env.WHATSAPP_PHONE_NUMBER_ID
        ) {
          continue;
        }
        const orgId = await organizationForSender(app.db, 'whatsapp', message.from);
        if (!orgId) {
          req.log.warn('a WhatsApp message could not be matched to an organisation');
          continue;
        }
        const result = await receiveMessage(app.db, {
          orgId,
          channel: 'whatsapp',
          externalThreadId: message.from,
          externalId: message.id,
          contactName: message.name,
          contactAddress: `+${message.from}`,
          body: message.body,
          attachments: message.attachment
            ? [
                {
                  name: message.media?.fileName ?? message.attachment,
                  contentType: message.media?.mimeType ?? null,
                },
              ]
            : [],
          receivedAt: message.at,
        });
        if (!result.duplicate) stored++;
        // The photo or document itself is fetched by the worker: WhatsApp expects an answer at once.
        if (result.message && message.media) {
          await queueWhatsAppMedia(app.db, result.message.id, message.media);
        }
      }
      let updated = 0;
      for (const receipt of receipts) {
        if (
          await recordDeliveryReceipt(app.db, {
            externalId: receipt.id,
            status: receipt.status,
            at: receipt.at,
            error: receipt.error,
          })
        ) {
          updated++;
        }
      }
      return reply.status(200).send({ received: true, stored, updated });
    },
  );

  // ---------------------------------------------------------------------------
  // Email from guests

  app.post(
    '/webhooks/inbox/email',
    {
      // Room for a message with a few photos attached.
      bodyLimit: 15 * 1024 * 1024,
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
      schema: {
        tags: ['webhooks'],
        summary: 'One email from a guest, handed over by a mail service as the raw message',
      },
    },
    async (req, reply) => {
      const given =
        (req.headers['x-inbound-email-secret'] as string | undefined) ??
        (req.query as { secret?: string }).secret ??
        '';
      if (!sameSecret(app.env.INBOUND_EMAIL_SECRET, given)) {
        throw new DomainError(
          'unauthenticated',
          'Inbound email is not set up, or the secret is wrong',
        );
      }
      const body = rawOf(req);
      let source: Buffer | string = body;
      if ((req.headers['content-type'] ?? '').includes('application/json')) {
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw validationError('The body is not valid JSON');
        }
        // Services differ in what they call the raw message.
        const raw = json.raw ?? json.RawEmail ?? json.email ?? json.mime ?? json['body-mime'];
        if (typeof raw !== 'string' || !raw.trim()) {
          throw validationError('The raw message is missing: send it as "raw"');
        }
        source = raw;
      }
      if (source.length === 0) throw validationError('The message is empty');
      const mail = await parseMime(source);
      // A sender the receiving server found to be forged is never shown as a guest.
      if (mail.authentication === 'fail') {
        return reply.status(200).send({ received: true, ignored: 'sender_not_genuine' });
      }
      const orgId = await organizationForSender(app.db, 'email', mail.from);
      if (!orgId) return reply.status(200).send({ received: true, ignored: 'unknown_sender' });
      const result = await receiveGuestEmail(
        app.db,
        orgId,
        {
          from: mail.from,
          fromName: mail.fromName,
          subject: mail.subject,
          text: mail.text,
          messageId: mail.messageId,
          inReplyTo: mail.inReplyTo,
          references: mail.references,
          date: mail.date,
          attachments: mail.attachments,
        },
        app.files,
      );
      return reply
        .status(200)
        .send(
          result
            ? { received: true, duplicate: result.duplicate }
            : { received: true, ignored: 'unknown_sender' },
        );
    },
  );
}
