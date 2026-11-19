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

const API = 'https://api.razorpay.com/v1';
/** Razorpay refuses a payment link that expires sooner than this. */
const MIN_EXPIRY_MS = 16 * 60_000;

interface PaymentLink {
  id: string;
  short_url: string;
  status: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid';
  amount_paid: number;
  payments: { payment_id: string; amount: number; method?: string; status: string }[] | null;
}

/**
 * Razorpay, through Payment Links: the guest pays on Razorpay's hosted page
 * (cards, UPI, net banking, wallets) and is sent back afterwards.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly config: { keyId: string; keySecret: string; webhookSecret?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString('base64');
    return gatewayRequest<T>(
      this.name,
      `${API}${path}`,
      {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      this.fetchImpl,
    );
  }

  async createOrder(input: GatewayOrderInput): Promise<GatewayOrder> {
    const expireBy = Math.max(input.expiresAt.getTime(), Date.now() + MIN_EXPIRY_MS);
    const link = await this.call<PaymentLink>('POST', '/payment_links', {
      amount: input.amount,
      currency: input.currency,
      accept_partial: false,
      expire_by: Math.ceil(expireBy / 1000),
      reference_id: input.reference.slice(0, 40),
      description: input.description.slice(0, 2048),
      customer: {
        name: input.customer.name,
        ...(input.customer.email ? { email: input.customer.email } : {}),
        ...(input.customer.phone ? { contact: input.customer.phone } : {}),
      },
      // The PMS sends its own messages; the guest should not get a second set from the gateway.
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: input.returnUrl,
      callback_method: 'get',
      notes: { reference: input.reference },
    });
    return { orderId: link.id, checkoutUrl: link.short_url };
  }

  async fetchOrder(orderId: string): Promise<GatewayOrderState> {
    const link = await this.call<PaymentLink>(
      'GET',
      `/payment_links/${encodeURIComponent(orderId)}`,
    );
    if (link.status === 'paid') {
      const payment = link.payments?.find((p) => p.status === 'captured') ?? link.payments?.[0];
      if (payment) {
        return {
          status: 'paid',
          paymentId: payment.payment_id,
          amountPaid: link.amount_paid,
          method: payment.method ?? null,
        };
      }
    }
    if (link.status === 'expired') return { status: 'expired' };
    if (link.status === 'cancelled') return { status: 'cancelled' };
    return { status: 'open' };
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.call('POST', `/payment_links/${encodeURIComponent(orderId)}/cancel`);
    } catch (err) {
      // A link that is already paid, expired or cancelled cannot be cancelled; that is the state wanted.
      const status = (err as { details?: { status?: number } }).details?.status;
      if (status !== 400) throw err;
    }
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    const refund = await this.call<{ id: string; status: string }>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        amount: input.amount,
        receipt: input.reference.slice(0, 40),
        notes: { reference: input.reference, ...(input.reason ? { reason: input.reason } : {}) },
      },
    );
    return { refundId: refund.id, status: refund.status === 'processed' ? 'processed' : 'pending' };
  }

  readWebhook(request: GatewayWebhook): GatewayWebhookResult {
    if (!this.config.webhookSecret) {
      return { ok: false, reason: 'RAZORPAY_WEBHOOK_SECRET is not set' };
    }
    const signature = headerOf(request.headers, 'x-razorpay-signature');
    if (!signature) return { ok: false, reason: 'The request is not signed' };
    const expected = hmacSha256Hex(this.config.webhookSecret, request.rawBody);
    if (!safeEqual(signature.trim().toLowerCase(), expected)) {
      return { ok: false, reason: 'The signature does not match' };
    }
    let body: {
      event?: string;
      payload?: { payment_link?: { entity?: { id?: string } } };
    };
    try {
      body = JSON.parse(request.rawBody.toString('utf8')) as typeof body;
    } catch {
      return { ok: false, reason: 'The body is not valid JSON' };
    }
    const linkId = body.payload?.payment_link?.entity?.id;
    return {
      ok: true,
      event: typeof body.event === 'string' ? body.event : 'unknown',
      orderIds: typeof linkId === 'string' ? [linkId] : [],
    };
  }
}
