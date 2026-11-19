import type { Env } from '@pms/config';
import type { Database } from '@pms/db';
import { DomainError } from '../errors';
import { MockGateway } from './mock';
import { RazorpayGateway } from './razorpay';
import { StripeGateway } from './stripe';

/**
 * A payment gateway, reduced to what the PMS needs: ask a guest to pay on the
 * gateway's own hosted page, find out whether they did, and give money back.
 *
 * Card details are entered on the gateway's page and never reach this system.
 */
export interface PaymentGateway {
  readonly name: 'mock' | 'razorpay' | 'stripe';
  createOrder(input: GatewayOrderInput): Promise<GatewayOrder>;
  /** Asks the gateway what became of an order. This, not a webhook or a redirect, is what is believed. */
  fetchOrder(orderId: string): Promise<GatewayOrderState>;
  /** Stops an unpaid order from being paid. Safe to call on one that is already closed. */
  cancelOrder(orderId: string): Promise<void>;
  refund(input: GatewayRefundInput): Promise<GatewayRefund>;
  /**
   * Checks that a webhook call came from the gateway and says which orders
   * it concerns. The caller then asks the gateway about each of them.
   */
  readWebhook(request: GatewayWebhook, now?: Date): GatewayWebhookResult;
}

export interface GatewayOrderInput {
  /** Minor units. */
  amount: number;
  currency: string;
  /** Our own unique reference for it, at most 40 characters. */
  reference: string;
  description: string;
  customer: { name: string; email?: string | null; phone?: string | null };
  /** Where the gateway sends the guest's browser afterwards, paid or not. */
  returnUrl: string;
  expiresAt: Date;
}

export interface GatewayOrder {
  orderId: string;
  /** The hosted page the guest pays on. */
  checkoutUrl: string;
}

export interface GatewayOrderState {
  status: 'open' | 'paid' | 'expired' | 'cancelled';
  /** Set when paid. */
  paymentId?: string;
  amountPaid?: number;
  method?: string | null;
}

export interface GatewayRefundInput {
  paymentId: string;
  amount: number;
  currency: string;
  /** Unique per refund, so a retry cannot refund twice. */
  reference: string;
  reason?: string;
}

export interface GatewayRefund {
  refundId: string;
  /** `pending`: accepted, and the gateway will complete it. */
  status: 'processed' | 'pending';
}

export interface GatewayWebhook {
  headers: Record<string, string | string[] | undefined>;
  /** The body exactly as received: signatures are computed over these bytes. */
  rawBody: Buffer;
}

export type GatewayWebhookResult =
  { ok: true; event: string; orderIds: string[] } | { ok: false; reason: string };

export type GatewayEnv = Pick<
  Env,
  | 'PAYMENT_PROVIDER'
  | 'RAZORPAY_KEY_ID'
  | 'RAZORPAY_KEY_SECRET'
  | 'RAZORPAY_WEBHOOK_SECRET'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'API_PUBLIC_URL'
  | 'isProduction'
>;

export function createGateway(env: GatewayEnv, db: Database): PaymentGateway {
  switch (env.PAYMENT_PROVIDER) {
    case 'razorpay':
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
        throw new DomainError(
          'not_configured',
          'Online payment is not set up: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are missing',
        );
      }
      return new RazorpayGateway({
        keyId: env.RAZORPAY_KEY_ID,
        keySecret: env.RAZORPAY_KEY_SECRET,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      });
    case 'stripe':
      if (!env.STRIPE_SECRET_KEY) {
        throw new DomainError(
          'not_configured',
          'Online payment is not set up: STRIPE_SECRET_KEY is missing',
        );
      }
      return new StripeGateway({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      });
    case 'mock':
      return new MockGateway(db, env.API_PUBLIC_URL);
  }
}

export function headerOf(headers: GatewayWebhook['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One call to a gateway's API. A refusal or an outage becomes an
 * `upstream_failed` error carrying the gateway's own explanation, never the
 * credentials.
 */
export async function gatewayRequest<T>(
  gateway: string,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new DomainError('upstream_failed', `The payment gateway could not be reached`, {
      gateway,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!response.ok || json === undefined) {
    const error = (json as { error?: { description?: string; message?: string; code?: string } })
      ?.error;
    const detail = error?.description ?? error?.message ?? `HTTP ${response.status}`;
    throw new DomainError('upstream_failed', `The payment gateway refused the request: ${detail}`, {
      gateway,
      status: response.status,
      code: error?.code,
    });
  }
  return json as T;
}
