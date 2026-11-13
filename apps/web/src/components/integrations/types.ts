import type {
  ApiKeyView,
  WebhookDeliveryView,
  WebhookEndpointView,
  WebhookEvent,
} from '@pms/domain';
import type { Serialized } from '@/lib/types';

export type ApiKey = Serialized<ApiKeyView>;
export type KeyGrant = ApiKey['grants'][number];
export type KeyRole = KeyGrant['role'];

/** What `GET /api-keys` answers. */
export interface ApiKeysAnswer {
  keys: ApiKey[];
  /** The roles a key may be given, each with its name. */
  roles: { role: KeyRole; label: string }[];
}

/** What `POST /api-keys` answers. `key` is the key itself, given here and never again. */
export interface CreatedApiKey {
  key: string;
  apiKey: ApiKey;
}

export type WebhookEndpoint = Serialized<WebhookEndpointView>;
export type WebhookDelivery = Serialized<WebhookDeliveryView>;
export type { WebhookEvent };

/** What `GET /outbound-webhooks` answers. */
export interface WebhooksAnswer {
  endpoints: WebhookEndpoint[];
  /** Every event a webhook can ask for. */
  events: WebhookEvent[];
}

/** What `POST /outbound-webhooks` answers. `secret` signs the deliveries; given here and never again. */
export interface CreatedWebhook {
  endpoint: WebhookEndpoint;
  secret: string;
}
