import { hmacSha256Hex, safeEqual } from '../crypto';
import {
  gatewayRequest,
  headerOf,
  type GatewayOrder,
  type GatewayOrderInput,
  type GatewayOrderState,
  type GatewayRefund,
  type GatewayRefundInput,
  type GatewayWebhook,
  type GatewayWebhookResult,
  type PaymentGateway,
} from './gateway';

const API = 'https://api.stripe.com/v1';
/** Stripe only accepts a Checkout Session that stays open between 30 minutes and 24 hours. */
const MIN_EXPIRY_MS = 31 * 60_000;
const MAX_EXPIRY_MS = 23 * 3_600_000;
/** How old a signed webhook may be before it is treated as a replay. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  payment_intent: string | null;
  amount_total: number | null;
}

/** Stripe, through Checkout: the guest pays on Stripe's hosted page and is sent back afterwards. */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;

  constructor(
    private readonly config: { secretKey: string; webhookSecret?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private call<T>(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string | number | undefined | null>,
    idempotencyKey?: string,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form ?? {})) {
      if (value !== undefined && value !== null && value !== '') body.set(key, String(value));
    }
    return gatewayRequest<T>(
      this.name,
      `${API}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: method === 'POST' ? body.toString() : undefined,
      },
      this.fetchImpl,
    );
  }

  async createOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    const now = Date.now();
    const expiresAt = Math.min(
      Math.max(input.expiresAt.getTime(), now + MIN_EXPIRY_MS),
      now + MAX_EXPIRY_MS,
    );
    const session = await this.call<CheckoutSession>(
      'POST',
      '/checkout/sessions',
      {
        mode: 'payment',
        'line_items[0][quantity]': 1,
        'line_items[0][price_data][currency]': input.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': input.amount,
        'line_items[0][price_data][product_data][name]': input.description.slice(0, 250),
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        client_reference_id: input.reference,
        customer_email: input.customer.email,
        expires_at: Math.ceil(expiresAt / 1000),
        'metadata[reference]': input.reference,
        'payment_intent_data[description]': input.description.slice(0, 500),
        'payment_intent_data[metadata][reference]': input.reference,
      },
      `order-${input.reference}`,
    );
    if (!session.url) throw new Error('Stripe returned a checkout session without a URL');
    return { orderId: session.id, checkoutUrl: session.url };
  }

  async fetchOrder(orderId: string): Promise<GatewayOrderState> {
    const session = await this.call<CheckoutSession>(
      'GET',
      `/checkout/sessions/${encodeURIComponent(orderId)}`,
    );
    if (session.payment_status === 'paid' && session.payment_intent) {
      return {
        status: 'paid',
        paymentId: session.payment_intent,
        amountPaid: session.amount_total ?? undefined,
        method: null,
      };
    }
    if (session.status === 'expired') return { status: 'expired' };
    // A completed session that is not yet paid is a delayed method (bank debit) still settling.
    return { status: 'open' };
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.call('POST', `/checkout/sessions/${encodeURIComponent(orderId)}/expire`);
    } catch (err) {
      // Only an open session can be expired; one that is complete or expired already is fine.
      const status = (err as { details?: { status?: number } }).details?.status;
      if (status !== 400) throw err;
    }
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(
      'POST',
      '/refunds',
      {
        payment_intent: input.paymentId,
        amount: input.amount,
        reason: 'requested_by_customer',
        'metadata[reference]': input.reference,
        'metadata[note]': input.reason?.slice(0, 450),
      },
      `refund-${input.reference}`,
    );
    return { refundId: refund.id, status: refund.status === 'succeeded' ? 'processed' : 'pending' };
  }

  readWebhook(request: GatewayWebhook, now: Date = new Date()): GatewayWebhookResult {
    if (!this.config.webhookSecret) {
      return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set' };
    }
    const header = headerOf(request.headers, 'stripe-signature');
    if (!header) return { ok: false, reason: 'The request is not signed' };
    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [key, value] = part.split('=', 2).map((s) => s.trim());
      if (key === 't') timestamp = value;
      if (key === 'v1' && value) signatures.push(value);
    }
    if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
      return { ok: false, reason: 'The signature header is malformed' };
    }
    if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
      return { ok: false, reason: 'The signature timestamp is too old or too new' };
    }
    const expected = hmacSha256Hex(
      this.config.webhookSecret,
      Buffer.concat([Buffer.from(`${timestamp}.`), request.rawBody]),
    );
    if (!signatures.some((s) => safeEqual(s.toLowerCase(), expected))) {
      return { ok: false, reason: 'The signature does not match' };
    }
    let body: { type?: string; data?: { object?: { object?: string; id?: string } } };
    try {
      body = JSON.parse(request.rawBody.toString('utf8')) as typeof body;
    } catch {
      return { ok: false, reason: 'The body is not valid JSON' };
    }
    const object = body.data?.object;
    return {
      ok: true,
      event: typeof body.type === 'string' ? body.type : 'unknown',
      orderIds:
        object?.object === 'checkout.session' && typeof object.id === 'string' ? [object.id] : [],
    };
  }
}
