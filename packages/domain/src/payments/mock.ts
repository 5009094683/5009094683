import { and, eq, sql } from 'drizzle-orm';
import { paymentOrders, type Database } from '@pms/db';
import { randomToken } from '../crypto';
import type {
  GatewayOrder,
  GatewayOrderInput,
  GatewayOrderState,
  GatewayRefund,
  GatewayWebhookResult,
  PaymentGateway,
} from './gateway';

interface MockState {
  outcome?: 'paid' | 'cancelled';
  paymentId?: string;
}

/**
 * A stand-in gateway for development and tests. Its "hosted page" is a page
 * served by the API with a Pay and a Cancel button, and what happened is kept
 * on the payment order itself. It approves whatever it is asked to, so the
 * configuration refuses to fall back to it in production.
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock' as const;

  constructor(
    private readonly db: Database,
    private readonly apiPublicUrl: string,
  ) {}

  async createOrder(_input: GatewayOrderInput): Promise<GatewayOrder> {
    const orderId = `mock_${randomToken(12)}`;
    return {
      orderId,
      checkoutUrl: `${this.apiPublicUrl.replace(/\/+$/, '')}/public/mock-pay/${orderId}`,
    };
  }

  private async row(orderId: string) {
    const [row] = await this.db
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.provider, 'mock'), eq(paymentOrders.providerOrderId, orderId)));
    return row;
  }

  async fetchOrder(orderId: string): Promise<GatewayOrderState> {
    const row = await this.row(orderId);
    const state = (row?.meta.mock ?? {}) as MockState;
    if (row && state.outcome === 'paid' && state.paymentId) {
      return { status: 'paid', paymentId: state.paymentId, amountPaid: row.amount, method: 'card' };
    }
    if (state.outcome === 'cancelled') return { status: 'cancelled' };
    return { status: 'open' };
  }

  /** What the Pay and Cancel buttons of the stand-in page do. Returns false for an order that is not open. */
  async complete(orderId: string, outcome: 'paid' | 'cancelled'): Promise<boolean> {
    const state: MockState =
      outcome === 'paid' ? { outcome, paymentId: `mockpay_${randomToken(12)}` } : { outcome };
    const result = await this.db
      .update(paymentOrders)
      .set({ meta: sql`${paymentOrders.meta} || ${JSON.stringify({ mock: state })}::jsonb` })
      .where(
        and(
          eq(paymentOrders.provider, 'mock'),
          eq(paymentOrders.providerOrderId, orderId),
          sql`${paymentOrders.meta}->'mock'->>'outcome' IS NULL`,
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.complete(orderId, 'cancelled');
  }

  async refund(): Promise<GatewayRefund> {
    return { refundId: `mockrfnd_${randomToken(12)}`, status: 'processed' };
  }

  readWebhook(): GatewayWebhookResult {
    return { ok: false, reason: 'The stand-in gateway sends no webhooks' };
  }
}
