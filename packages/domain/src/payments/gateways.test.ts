import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { RazorpayGateway } from './razorpay';
import { StripeGateway } from './stripe';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A stand-in for `fetch` that answers from a script and records what was asked. */
function scripted(answers: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const answer = answers.shift();
    if (!answer) throw new Error('No scripted answer left');
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const order = {
  amount: 945_000,
  currency: 'INR',
  reference: 'ABCD2345-XYZ789',
  description: 'Sea Breeze Candolim, booking ABCD2345',
  customer: { name: 'Meera Nair', email: 'meera@example.com', phone: '+919800000000' },
  returnUrl: 'https://book.example.com/booking/token?paid=1',
  expiresAt: new Date(Date.now() + 10 * 60_000),
};

describe('Razorpay', () => {
  const config = { keyId: 'rzp_test_key', keySecret: 'key-secret', webhookSecret: 'hook-secret' };

  it('creates a payment link the guest pays on, without Razorpay messaging the guest itself', async () => {
    const { calls, fetchImpl } = scripted([
      { body: { id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' } },
    ]);
    const created = await new RazorpayGateway(config, fetchImpl).createOrder(order);
    expect(created).toEqual({ orderId: 'plink_1', checkoutUrl: 'https://rzp.io/i/abc' });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:key-secret').toString('base64')}`,
    );
    const sent = JSON.parse(call.body!);
    expect(sent).toMatchObject({
      amount: 945_000,
      currency: 'INR',
      accept_partial: false,
      reference_id: 'ABCD2345-XYZ789',
      customer: { name: 'Meera Nair', email: 'meera@example.com', contact: '+919800000000' },
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: order.returnUrl,
      callback_method: 'get',
    });
    // Razorpay refuses a link that expires in under 15 minutes; the hold is shorter, so it is stretched.
    expect(sent.expire_by * 1000).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it('reads the state of a link, and treats only a captured payment as paid', async () => {
    const { fetchImpl } = scripted([
      { body: { id: 'plink_1', status: 'created', amount_paid: 0, payments: null } },
      {
        body: {
          id: 'plink_1',
          status: 'paid',
          amount_paid: 945_000,
          payments: [{ payment_id: 'pay_9', amount: 945_000, method: 'upi', status: 'captured' }],
        },
      },
      { body: { id: 'plink_1', status: 'expired', amount_paid: 0, payments: null } },
      { body: { id: 'plink_1', status: 'partially_paid', amount_paid: 100, payments: [] } },
    ]);
    const gateway = new RazorpayGateway(config, fetchImpl);
    expect(await gateway.fetchOrder('plink_1')).toEqual({ status: 'open' });
    expect(await gateway.fetchOrder('plink_1')).toEqual({
      status: 'paid',
      paymentId: 'pay_9',
      amountPaid: 945_000,
      method: 'upi',
    });
    expect(await gateway.fetchOrder('plink_1')).toEqual({ status: 'expired' });
    expect(await gateway.fetchOrder('plink_1')).toEqual({ status: 'open' });
  });

  it('refunds against the payment, and reports a refusal without leaking the key', async () => {
    const { calls, fetchImpl } = scripted([
      { body: { id: 'rfnd_1', status: 'processed' } },
      {
        status: 400,
        body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Refund amount exceeds' } },
      },
    ]);
    const gateway = new RazorpayGateway(config, fetchImpl);
    const input = { paymentId: 'pay_9', amount: 414_000, currency: 'INR', reference: 'pay-r1' };
    expect(await gateway.refund(input)).toEqual({ refundId: 'rfnd_1', status: 'processed' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_9/refund');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount: 414_000, receipt: 'pay-r1' });
    const refused = await gateway.refund(input).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).code).toBe('upstream_failed');
    expect((refused as DomainError).message).toMatch(/Refund amount exceeds/);
    expect(JSON.stringify(refused)).not.toMatch(/key-secret/);
  });

  it('cancelling a link that is already closed is not an error', async () => {
    const { fetchImpl } = scripted([
      { status: 400, body: { error: { description: 'Payment link is already cancelled' } } },
      { status: 500, body: { error: { description: 'Server error' } } },
    ]);
    const gateway = new RazorpayGateway(config, fetchImpl);
    await expect(gateway.cancelOrder('plink_1')).resolves.toBeUndefined();
    await expect(gateway.cancelOrder('plink_1')).rejects.toMatchObject({ code: 'upstream_failed' });
  });

  it('accepts only webhooks signed with the webhook secret', () => {
    const gateway = new RazorpayGateway(config);
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'payment_link.paid',
        payload: { payment_link: { entity: { id: 'plink_1' } } },
      }),
    );
    const signature = createHmac('sha256', 'hook-secret').update(rawBody).digest('hex');
    expect(
      gateway.readWebhook({ headers: { 'x-razorpay-signature': signature }, rawBody }),
    ).toEqual({ ok: true, event: 'payment_link.paid', orderIds: ['plink_1'] });
    const forged = createHmac('sha256', 'guess').update(rawBody).digest('hex');
    expect(
      gateway.readWebhook({ headers: { 'x-razorpay-signature': forged }, rawBody }),
    ).toMatchObject({ ok: false });
    expect(gateway.readWebhook({ headers: {}, rawBody })).toMatchObject({ ok: false });
    // A body changed after signing no longer matches.
    expect(
      gateway.readWebhook({
        headers: { 'x-razorpay-signature': signature },
        rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
      }),
    ).toMatchObject({ ok: false });
    // Without a secret configured nothing is accepted.
    expect(
      new RazorpayGateway({ keyId: 'k', keySecret: 's' }).readWebhook({
        headers: { 'x-razorpay-signature': signature },
        rawBody,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('Stripe', () => {
  const config = { secretKey: 'sk_test_secret', webhookSecret: 'whsec_test' };

  it('creates a checkout session with the amount in the smallest unit', async () => {
    const { calls, fetchImpl } = scripted([
      { body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', status: 'open' } },
    ]);
    const created = await new StripeGateway(config, fetchImpl).createOrder(order);
    expect(created).toEqual({
      orderId: 'cs_1',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1',
    });
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.headers.authorization).toBe('Bearer sk_test_secret');
    expect(call.headers['idempotency-key']).toBe('order-ABCD2345-XYZ789');
    const form = new URLSearchParams(call.body);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('945000');
    expect(form.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(form.get('success_url')).toBe(order.returnUrl);
    expect(form.get('client_reference_id')).toBe('ABCD2345-XYZ789');
    // Stripe keeps a session open for at least 30 minutes.
    expect(Number(form.get('expires_at')) * 1000).toBeGreaterThan(Date.now() + 30 * 60_000);
  });

  it('reads the state of a session', async () => {
    const { fetchImpl } = scripted([
      { body: { id: 'cs_1', status: 'open', payment_status: 'unpaid', payment_intent: null } },
      {
        body: {
          id: 'cs_1',
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 945_000,
        },
      },
      { body: { id: 'cs_1', status: 'expired', payment_status: 'unpaid', payment_intent: null } },
      // Completed with a delayed method that has not settled: not paid yet.
      {
        body: { id: 'cs_1', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_2' },
      },
    ]);
    const gateway = new StripeGateway(config, fetchImpl);
    expect(await gateway.fetchOrder('cs_1')).toEqual({ status: 'open' });
    expect(await gateway.fetchOrder('cs_1')).toEqual({
      status: 'paid',
      paymentId: 'pi_1',
      amountPaid: 945_000,
      method: null,
    });
    expect(await gateway.fetchOrder('cs_1')).toEqual({ status: 'expired' });
    expect(await gateway.fetchOrder('cs_1')).toEqual({ status: 'open' });
  });

  it('refunds against the payment intent with a key that makes a retry harmless', async () => {
    const { calls, fetchImpl } = scripted([{ body: { id: 're_1', status: 'succeeded' } }]);
    const refund = await new StripeGateway(config, fetchImpl).refund({
      paymentId: 'pi_1',
      amount: 414_000,
      currency: 'INR',
      reference: 'pay-r1',
      reason: 'Booking cancelled by the guest',
    });
    expect(refund).toEqual({ refundId: 're_1', status: 'processed' });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('payment_intent')).toBe('pi_1');
    expect(form.get('amount')).toBe('414000');
    expect(calls[0]!.headers['idempotency-key']).toBe('refund-pay-r1');
  });

  it('accepts only recent webhooks signed with the endpoint secret', () => {
    const gateway = new StripeGateway(config);
    const now = new Date('2026-11-13T10:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const rawBody = Buffer.from(
      JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { object: 'checkout.session', id: 'cs_1' } },
      }),
    );
    const sign = (secret: string, t: number) =>
      createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
    const header = (t: number, ...signatures: string[]) => ({
      'stripe-signature': [`t=${t}`, ...signatures.map((s) => `v1=${s}`)].join(','),
    });

    expect(
      gateway.readWebhook(
        { headers: header(timestamp, sign('whsec_test', timestamp)), rawBody },
        now,
      ),
    ).toEqual({ ok: true, event: 'checkout.session.completed', orderIds: ['cs_1'] });
    // During a secret rotation Stripe sends two signatures; one matching is enough.
    expect(
      gateway.readWebhook(
        {
          headers: header(timestamp, sign('old', timestamp), sign('whsec_test', timestamp)),
          rawBody,
        },
        now,
      ),
    ).toMatchObject({ ok: true });
    expect(
      gateway.readWebhook({ headers: header(timestamp, sign('guess', timestamp)), rawBody }, now),
    ).toMatchObject({ ok: false, reason: 'The signature does not match' });
    // A captured delivery replayed ten minutes later is refused.
    const old = timestamp - 600;
    expect(
      gateway.readWebhook({ headers: header(old, sign('whsec_test', old)), rawBody }, now),
    ).toMatchObject({ ok: false });
    expect(gateway.readWebhook({ headers: {}, rawBody }, now)).toMatchObject({ ok: false });
    expect(
      gateway.readWebhook({ headers: { 'stripe-signature': 'nonsense' }, rawBody }, now),
    ).toMatchObject({ ok: false });
  });
});
