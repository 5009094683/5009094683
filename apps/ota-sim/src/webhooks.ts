import { createHmac } from 'node:crypto';
import type { SimState, SimWebhook } from './state';

export interface DeliveryOptions {
  /** When set, deliveries are signed the way Channex signs them. */
  signingSecret?: string;
  /** Pauses between attempts after a 5xx or a connection failure. */
  retryDelaysMs: number[];
  fetch?: typeof fetch;
}

interface QueuedDelivery {
  webhook: SimWebhook;
  event: string;
  body: string;
}

function matches(webhook: SimWebhook, event: string, propertyId: string): boolean {
  if (!webhook.isActive) return false;
  if (!webhook.isGlobal && webhook.propertyId !== propertyId) return false;
  return webhook.eventMask === '*' || webhook.eventMask.split(';').includes(event);
}

/**
 * Sends webhook events to their subscribers: one queue, first in first out,
 * with retries on failure, as the real service does.
 */
export class WebhookSender {
  private queue: QueuedDelivery[] = [];
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly state: SimState,
    private readonly options: DeliveryOptions,
  ) {}

  announce(event: string, propertyId: string, payload: Record<string, unknown>): void {
    const targets = [...this.state.webhooks.values()].filter((w) => matches(w, event, propertyId));
    for (const webhook of targets) {
      if (this.state.faults.dropWebhooks) {
        this.state.deliveries.push({
          at: new Date().toISOString(),
          webhookId: webhook.id,
          event,
          attempt: 0,
          status: 'dropped',
        });
        continue;
      }
      const body = JSON.stringify({
        event,
        property_id: propertyId,
        user_id: null,
        timestamp: new Date().toISOString(),
        ...(webhook.sendData ? { payload } : {}),
      });
      const copies = this.state.faults.duplicateWebhooks ? 2 : 1;
      for (let i = 0; i < copies; i++) this.queue.push({ webhook, event, body });
    }
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  /** Resolves when everything queued so far has been delivered or given up on. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const next = this.queue.shift()!;
      await this.deliver(next);
    }
  }

  private async deliver({ webhook, event, body }: QueuedDelivery): Promise<void> {
    const send = this.options.fetch ?? fetch;
    const delays = this.options.retryDelaysMs;
    for (let attempt = 1; attempt <= delays.length + 1 && !this.stopped; attempt++) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...webhook.headers,
      };
      if (this.options.signingSecret) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        headers['x-hmac-timestamp'] = timestamp;
        headers['x-hmac-signature-256'] = createHmac('sha256', this.options.signingSecret)
          .update(`${timestamp}.${body}`)
          .digest('hex');
        headers['x-hmac-keys-256'] = `...${this.options.signingSecret.slice(-6)}`;
      }
      let status: number | 'error';
      try {
        const response = await send(webhook.callbackUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = response.status;
      } catch {
        status = 'error';
      }
      this.state.deliveries.push({
        at: new Date().toISOString(),
        webhookId: webhook.id,
        event,
        attempt,
        status,
      });
      // Like the real service: only a server error or no answer at all is tried again.
      if (typeof status === 'number' && status < 500) return;
      const wait = delays[attempt - 1];
      if (wait === undefined) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
