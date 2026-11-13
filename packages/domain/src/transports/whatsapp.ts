import type { Env } from '@pms/config';
import { hmacSha256Hex, safeEqual } from '../crypto';
import { PermanentSendError, type MessageTransport } from '../inbox';

const GRAPH = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 20_000;
/** The largest file fetched from WhatsApp: what the file store accepts. */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

/**
 * Error codes of the WhatsApp Cloud API that mean "try again later": rate
 * limits and outages. Anything else (a number not on WhatsApp, a template
 * that is not approved, the 24-hour window having closed) will fail the same
 * way next time.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

interface GraphError {
  error?: {
    message?: string;
    code?: number;
    error_data?: { details?: string };
  };
}

/** The part of the WhatsApp Business Cloud API the inbox uses: sending text and templates, and fetching what guests send. */
export class WhatsAppClient {
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(payload: Record<string, unknown>): Promise<string> {
    const url = `${GRAPH}/${this.config.apiVersion}/${encodeURIComponent(this.config.phoneNumberId)}/messages`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `WhatsApp could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const body = (await response.json().catch(() => ({}))) as GraphError & {
      messages?: { id?: string }[];
    };
    if (!response.ok) {
      const code = body.error?.code;
      const detail =
        body.error?.error_data?.details ?? body.error?.message ?? `HTTP ${response.status}`;
      const text = `WhatsApp refused the message: ${detail}${code ? ` (code ${code})` : ''}`;
      const retryable =
        response.status >= 500 ||
        response.status === 429 ||
        (code !== undefined && RETRYABLE_CODES.has(code));
      throw retryable ? new Error(text) : new PermanentSendError(text);
    }
    const id = body.messages?.[0]?.id;
    if (!id) throw new Error('WhatsApp accepted the message but returned no id');
    return id;
  }

  /** Free text. Only allowed within 24 hours of the guest's last message. */
  sendText(to: string, body: string): Promise<string> {
    return this.post({
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    });
  }

  /**
   * Fetches a photo or document a guest sent. WhatsApp gives a short-lived
   * address for it, readable only with the access token.
   */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string | null }> {
    const headers = { authorization: `Bearer ${this.config.accessToken}` };
    const request = async (url: string): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(
          `WhatsApp could not be reached: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    };
    const lookup = await request(
      `${GRAPH}/${this.config.apiVersion}/${encodeURIComponent(mediaId)}`,
    );
    const found = (await lookup.json().catch(() => ({}))) as GraphError & {
      url?: string;
      mime_type?: string;
      file_size?: number;
    };
    if (!lookup.ok || !found.url) {
      const text = `WhatsApp did not give the file: ${found.error?.message ?? `HTTP ${lookup.status}`}`;
      throw lookup.status >= 500 || lookup.status === 429
        ? new Error(text)
        : new PermanentSendError(text);
    }
    if ((found.file_size ?? 0) > MAX_MEDIA_BYTES) {
      throw new PermanentSendError('The file is larger than 8 MB');
    }
    // The token goes only to WhatsApp's own servers.
    const address = new URL(found.url);
    if (
      address.protocol !== 'https:' ||
      !/(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i.test(address.hostname)
    ) {
      throw new PermanentSendError('WhatsApp gave an address for the file that is not its own');
    }
    const download = await request(address.toString());
    if (!download.ok) {
      const text = `WhatsApp did not give the file: HTTP ${download.status}`;
      throw download.status >= 500 || download.status === 429
        ? new Error(text)
        : new PermanentSendError(text);
    }
    const data = Buffer.from(await download.arrayBuffer());
    if (data.length > MAX_MEDIA_BYTES) throw new PermanentSendError('The file is larger than 8 MB');
    return { data, mimeType: found.mime_type ?? null };
  }

  /** A template approved in WhatsApp Business Manager, with its variables in order. */
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string> {
    return this.post({
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        ...(params.length > 0
          ? {
              components: [
                {
                  type: 'body',
                  // WhatsApp rejects an empty variable and one containing a line break or tab.
                  parameters: params.map((text) => ({
                    type: 'text',
                    text: text.replace(/\s+/g, ' ').trim() || '-',
                  })),
                },
              ],
            }
          : {}),
      },
    });
  }
}

export function whatsappConfig(
  env: Pick<Env, 'WHATSAPP_ACCESS_TOKEN' | 'WHATSAPP_PHONE_NUMBER_ID' | 'WHATSAPP_API_VERSION'>,
): WhatsAppConfig | null {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return null;
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
  };
}

export function whatsappTransport(client: WhatsAppClient | null): MessageTransport {
  return {
    channel: 'whatsapp',
    unavailable(target) {
      if (!client) {
        return 'WhatsApp is not set up: WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are missing.';
      }
      if (!target.contactAddress) return 'There is no phone number for this guest.';
      return null;
    },
    async send(conversation, message) {
      const to = conversation.externalThreadId;
      const template = message.meta.whatsappTemplate;
      const externalId =
        typeof template === 'string' && template
          ? await client!.sendTemplate(
              to,
              template,
              typeof message.meta.whatsappLanguage === 'string'
                ? message.meta.whatsappLanguage
                : 'en',
              Array.isArray(message.meta.whatsappParams)
                ? message.meta.whatsappParams.map((p) => String(p))
                : [],
            )
          : await client!.sendText(to, message.body);
      return { externalId };
    },
  };
}

/** Checks the `X-Hub-Signature-256` header Meta puts on webhook calls: `sha256=<hex HMAC of the body>`. */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7).trim().toLowerCase(), hmacSha256Hex(appSecret, rawBody));
}

export interface WhatsAppInbound {
  /** The business number the message was sent to. */
  phoneNumberId: string | null;
  /** The guest's number, digits only, with country code. */
  from: string;
  name: string | null;
  id: string;
  at: Date;
  body: string;
  /** For media: what kind it was, in words. */
  attachment: string | null;
  /** For a photo or a document: what is needed to fetch the file itself. */
  media: { id: string; fileName: string | null; mimeType: string | null } | null;
}

export interface WhatsAppReceipt {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  error: string | null;
}

interface WebhookMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  [media: string]: unknown;
}

const MEDIA_LABELS: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  document: 'Document',
  sticker: 'Sticker',
  contacts: 'Contact card',
};

/** Photos and documents can be kept; the file store takes nothing else. */
function mediaOf(message: WebhookMessage): WhatsAppInbound['media'] {
  const type = message.type ?? '';
  if (type !== 'image' && type !== 'document') return null;
  const media = message[type] as { id?: string; filename?: string; mime_type?: string } | undefined;
  if (!media?.id) return null;
  return { id: media.id, fileName: media.filename ?? null, mimeType: media.mime_type ?? null };
}

function textOf(message: WebhookMessage): { body: string; attachment: string | null } {
  const type = message.type ?? 'unknown';
  if (type === 'text') return { body: message.text?.body ?? '', attachment: null };
  if (type === 'button') return { body: message.button?.text ?? '', attachment: null };
  if (type === 'interactive') {
    const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    return { body: reply?.title ?? '', attachment: null };
  }
  if (type === 'location') {
    const l = message.location ?? {};
    const place = [l.name, l.address].filter(Boolean).join(', ');
    return {
      body: `[Location] ${place ? `${place} ` : ''}${l.latitude ?? ''},${l.longitude ?? ''}`.trim(),
      attachment: null,
    };
  }
  const label = MEDIA_LABELS[type];
  if (label) {
    const caption = (message[type] as { caption?: string } | undefined)?.caption;
    return { body: caption ? `[${label}] ${caption}` : `[${label}]`, attachment: label };
  }
  return { body: '[A message of a kind that cannot be shown here]', attachment: null };
}

/** Pulls the guest messages and delivery receipts out of a webhook body. Anything unrecognised is skipped. */
export function readWhatsAppWebhook(body: unknown): {
  messages: WhatsAppInbound[];
  receipts: WhatsAppReceipt[];
} {
  const messages: WhatsAppInbound[] = [];
  const receipts: WhatsAppReceipt[] = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return { messages, receipts };
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value || typeof value !== 'object') continue;
      const phoneNumberId =
        (value.metadata as { phone_number_id?: string } | undefined)?.phone_number_id ?? null;
      const names = new Map<string, string>();
      for (const contact of (value.contacts as { wa_id?: string; profile?: { name?: string } }[]) ??
        []) {
        if (contact.wa_id && contact.profile?.name) names.set(contact.wa_id, contact.profile.name);
      }
      for (const message of (value.messages as WebhookMessage[]) ?? []) {
        if (!message.from || !message.id) continue;
        const { body: text, attachment } = textOf(message);
        messages.push({
          phoneNumberId,
          from: message.from.replace(/\D/g, ''),
          name: names.get(message.from) ?? null,
          id: message.id,
          at: new Date(Number(message.timestamp ?? 0) * 1000 || Date.now()),
          body: text,
          attachment,
          media: mediaOf(message),
        });
      }
      for (const status of (value.statuses as {
        id?: string;
        status?: string;
        timestamp?: string;
        errors?: { title?: string; message?: string; error_data?: { details?: string } }[];
      }[]) ?? []) {
        if (!status.id || !['sent', 'delivered', 'read', 'failed'].includes(status.status ?? '')) {
          continue;
        }
        const error = status.errors?.[0];
        receipts.push({
          id: status.id,
          status: status.status as WhatsAppReceipt['status'],
          at: new Date(Number(status.timestamp ?? 0) * 1000 || Date.now()),
          error: error ? (error.error_data?.details ?? error.message ?? error.title ?? null) : null,
        });
      }
    }
  }
  return { messages, receipts };
}
