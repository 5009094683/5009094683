import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, apiKeys, webhookDeliveries, webhookEndpoints } from '@pms/db';
import { createTestDatabase, type TestDatabase } from '@pms/db/testing';
import { createApiKey, listApiKeys, resolveApiKey, revokeApiKey } from './api-keys';
import { sha256Hex } from './crypto';
import { createTestHotel, createTestOrg, type TestHotel, type TestOrg } from './testing';
import {
  assertWebhookUrl,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  deliverDueWebhooks,
  httpWebhookSender,
  isPrivateAddress,
  listWebhookDeliveries,
  listWebhookEndpoints,
  pruneWebhookDeliveries,
  queueWebhookDeliveries,
  queueWebhookTest,
  retryWebhookDelivery,
  rotateWebhookSecret,
  updateWebhookEndpoint,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookRequest,
  type WebhookSourceEvent,
} from './webhooks';

let t: TestDatabase;
let org: TestOrg;
let hotel: TestHotel;
let other: TestHotel;

beforeAll(async () => {
  t = await createTestDatabase();
  org = await createTestOrg(t.db);
  hotel = await createTestHotel(t.db, org);
  other = await createTestHotel(t.db, org);
});
afterAll(async () => {
  await t.drop();
});

describe('API keys', () => {
  it('are shown once and kept only as a hash', async () => {
    const { key, apiKey } = await createApiKey(t.db, org.admin, {
      name: ' Revenue tool ',
      grants: [{ role: 'revenue_manager', propertyId: hotel.property.id }],
    });
    expect(key).toMatch(/^pms_[\w-]{40,}$/);
    expect(apiKey).toMatchObject({
      name: 'Revenue tool',
      prefix: key.slice(0, 10),
      grants: [{ role: 'revenue_manager', propertyId: hotel.property.id }],
      lastUsedAt: null,
      revokedAt: null,
    });
    const [stored] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id));
    expect(stored!.keyHash).toBe(sha256Hex(key));
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(JSON.stringify(await listApiKeys(t.db, org.orgId))).not.toContain(key.slice(12));
  });

  it('carry roles like a person\u2019s, but never the right to manage users or keys', async () => {
    await expect(
      createApiKey(t.db, org.admin, {
        name: 'Too much',
        grants: [{ role: 'org_admin', propertyId: null }],
      }),
    ).rejects.toThrow(/stays with people/);
    await expect(
      createApiKey(t.db, org.admin, {
        name: 'Owner',
        grants: [{ role: 'villa_owner', propertyId: null }],
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      createApiKey(t.db, org.admin, { name: 'Nothing', grants: [] }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      createApiKey(t.db, org.admin, {
        name: '',
        grants: [{ role: 'read_only', propertyId: null }],
      }),
    ).rejects.toMatchObject({ code: 'validation' });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      createApiKey(t.db, rival.admin, {
        name: 'Elsewhere',
        grants: [{ role: 'read_only', propertyId: hotel.property.id }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createApiKey(t.db, org.admin, {
        name: 'Past',
        grants: [{ role: 'read_only', propertyId: null }],
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(/in the future/);
  });

  it('work until they are revoked or expire', async () => {
    const now = new Date('2027-01-10T10:00:00Z');
    const { key, apiKey } = await createApiKey(
      t.db,
      org.admin,
      {
        name: 'Accounts export',
        grants: [{ role: 'accountant', propertyId: null }],
        expiresAt: new Date('2027-02-01T00:00:00Z'),
      },
      now,
    );
    expect(await resolveApiKey(t.db, key, now)).toEqual({
      id: apiKey.id,
      orgId: org.orgId,
      name: 'Accounts export',
      grants: [{ role: 'accountant', propertyId: null }],
    });
    // When it was last used is noted, at most once a minute.
    const used = async () =>
      (await t.db.select().from(apiKeys).where(eq(apiKeys.id, apiKey.id)))[0]!.lastUsedAt;
    expect(await used()).toEqual(now);
    await resolveApiKey(t.db, key, new Date(now.getTime() + 30_000));
    expect(await used()).toEqual(now);
    await resolveApiKey(t.db, key, new Date(now.getTime() + 90_000));
    expect(await used()).toEqual(new Date(now.getTime() + 90_000));

    expect(await resolveApiKey(t.db, `${key}x`, now)).toBeNull();
    expect(await resolveApiKey(t.db, 'not-a-key', now)).toBeNull();
    expect(await resolveApiKey(t.db, key, new Date('2027-02-01T00:00:00Z'))).toBeNull();
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(revokeApiKey(t.db, rival.admin, apiKey.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const revoked = await revokeApiKey(t.db, org.admin, apiKey.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(await resolveApiKey(t.db, key, now)).toBeNull();
    // Still listed, so the audit trail keeps making sense.
    expect((await listApiKeys(t.db, org.orgId)).map((k) => k.id)).toContain(apiKey.id);
  });
});

describe('where a webhook may go', () => {
  it('knows the addresses that are not on the public internet', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'not an address',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '203.0.114.7', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses addresses that could reach inside the network', () => {
    const strict = { allowPrivate: false };
    expect(assertWebhookUrl(' https://hooks.example.com/pms ', strict).toString()).toBe(
      'https://hooks.example.com/pms',
    );
    for (const url of [
      'http://hooks.example.com/pms',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://10.0.0.5:8443/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://db.internal/hook',
      'https://printer.local/hook',
      'https://user:secret@hooks.example.com/pms',
      'ftp://hooks.example.com',
      'hooks.example.com',
      '',
    ]) {
      expect(() => assertWebhookUrl(url, strict), url).toThrow();
    }
    // For trying a receiver out on the same machine, where that is allowed.
    expect(assertWebhookUrl('http://127.0.0.1:9000/hook', { allowPrivate: true }).port).toBe(
      '9000',
    );
    expect(() => assertWebhookUrl('file:///etc/passwd', { allowPrivate: true })).toThrow();
  });
});

describe('webhooks', () => {
  const sent: WebhookRequest[] = [];
  let answer: number | Error = 200;
  const send = async (request: WebhookRequest) => {
    sent.push(request);
    if (answer instanceof Error) throw answer;
    return { status: answer };
  };
  const open = { allowPrivate: true };
  const event = (overrides: Partial<WebhookSourceEvent> = {}): WebhookSourceEvent => ({
    kind: 'reservation.created',
    orgId: org.orgId,
    propertyId: hotel.property.id,
    payload: { reservationId: 'r-1', code: 'ABC123' },
    createdAt: '2027-01-10 10:00:00.123456+00',
    ...overrides,
  });
  const queue = (events: WebhookSourceEvent[]) =>
    t.db.transaction((tx) => queueWebhookDeliveries(tx, events));

  beforeEach(async () => {
    sent.length = 0;
    answer = 200;
    await t.db.delete(webhookEndpoints);
    await t.db.delete(alerts);
  });

  it('gives the signing secret once, and checks what it is asked to send', async () => {
    const { endpoint, secret } = await createWebhookEndpoint(
      t.db,
      org.admin,
      { url: 'https://hooks.example.com/pms', events: ['reservation.*', 'rates.updated'] },
      { allowPrivate: false },
    );
    expect(secret).toMatch(/^whsec_[\w-]{40,}$/);
    expect(endpoint).toMatchObject({
      url: 'https://hooks.example.com/pms',
      events: ['reservation.*', 'rates.updated'],
      propertyIds: null,
      active: true,
    });
    const [stored] = await t.db.select().from(webhookEndpoints);
    expect(stored!.secretEnc).not.toContain(secret);
    expect(JSON.stringify(await listWebhookEndpoints(t.db, org.orgId))).not.toContain('whsec_');

    await expect(
      createWebhookEndpoint(
        t.db,
        org.admin,
        { url: 'https://hooks.example.com', events: ['reservation.exploded'] },
        open,
      ),
    ).rejects.toThrow(/no event called "reservation.exploded"/);
    await expect(
      createWebhookEndpoint(
        t.db,
        org.admin,
        { url: 'https://hooks.example.com', events: [] },
        open,
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      createWebhookEndpoint(
        t.db,
        org.admin,
        { url: 'http://127.0.0.1/hook', events: ['*'] },
        { allowPrivate: false },
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    const rival = await createTestOrg(t.db, 'Rival');
    await expect(
      createWebhookEndpoint(
        t.db,
        rival.admin,
        { url: 'https://hooks.example.com', events: ['*'], propertyIds: [hotel.property.id] },
        open,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      updateWebhookEndpoint(t.db, rival.admin, endpoint.id, { active: false }, open),
    ).rejects.toMatchObject({ code: 'not_found' });

    const rotated = await rotateWebhookSecret(t.db, org.admin, endpoint.id);
    expect(rotated.secret).not.toBe(secret);
    await deleteWebhookEndpoint(t.db, org.admin, endpoint.id);
    expect(await listWebhookEndpoints(t.db, org.orgId)).toEqual([]);
  });

  it('tells each endpoint what it asked for, signed, with ids to look things up by', async () => {
    const all = await createWebhookEndpoint(
      t.db,
      org.admin,
      { url: 'https://all.example.com/hook', events: ['*'] },
      open,
    );
    await createWebhookEndpoint(
      t.db,
      org.admin,
      {
        url: 'https://rates.example.com/hook',
        events: ['rates.updated'],
        propertyIds: [other.property.id],
      },
      open,
    );
    const rival = await createTestOrg(t.db, 'Rival');
    await createWebhookEndpoint(
      t.db,
      rival.admin,
      { url: 'https://rival.example.com/hook', events: ['*'] },
      open,
    );

    const queued = await queue([
      event(),
      event({ kind: 'rates.updated', payload: { ratePlanId: 'p-1' } }),
      event({
        kind: 'rates.updated',
        propertyId: other.property.id,
        payload: { ratePlanId: 'p-2' },
      }),
      // A guest wrote: of interest. Staff read it or replied: not.
      event({
        kind: 'message.received',
        payload: { conversationId: 'c-1', channel: 'email', direction: 'in' },
      }),
      event({ kind: 'message.received', payload: { conversationId: 'c-1', receipt: 'read' } }),
      event({ kind: 'message.received', payload: { conversationId: 'c-1', read: true } }),
      event({ kind: 'message.received', payload: { conversationId: 'c-1', direction: 'out' } }),
      // Kinds that only matter to open screens are not sent out.
      event({ kind: 'sync.updated', payload: { connectionId: 'x' } }),
      event({ kind: 'task.updated', payload: {} }),
      event({ kind: 'folio.updated', payload: {} }),
    ]);
    // Four to the endpoint that takes everything, one to the one that takes the other property's rates.
    expect(queued).toBe(5);

    const now = new Date('2027-01-10T10:00:05Z');
    expect(await deliverDueWebhooks(t.db, send, { now })).toEqual({
      delivered: 5,
      retrying: 0,
      failed: 0,
    });
    expect(sent.map((s) => new URL(s.url).host).sort()).toEqual([
      'all.example.com',
      'all.example.com',
      'all.example.com',
      'all.example.com',
      'rates.example.com',
    ]);
    const first = sent.find((s) => s.headers['x-pms-event'] === 'reservation.created')!;
    const body = JSON.parse(first.body) as Record<string, unknown>;
    expect(body).toEqual({
      id: first.headers['x-pms-delivery'],
      type: 'reservation.created',
      createdAt: '2027-01-10T10:00:00.123Z',
      propertyId: hotel.property.id,
      data: { reservationId: 'r-1', code: 'ABC123' },
    });
    expect(first.headers).toMatchObject({
      'content-type': 'application/json',
      'x-pms-timestamp': String(Math.floor(now.getTime() / 1000)),
    });
    // The receiver can tell it came from here, and that it is fresh.
    const check = (secret: string, at: Date, text = first.body) =>
      verifyWebhookSignature(
        secret,
        {
          signature: first.headers['x-pms-signature'],
          timestamp: first.headers['x-pms-timestamp'],
        },
        text,
        { now: at },
      );
    expect(check(all.secret, now)).toBe(true);
    expect(check('whsec_wrong', now)).toBe(false);
    expect(check(all.secret, now, first.body.replace('ABC123', 'XYZ999'))).toBe(false);
    expect(check(all.secret, new Date(now.getTime() + 10 * 60_000))).toBe(false);

    // Sent once: a second pass has nothing to do.
    expect((await deliverDueWebhooks(t.db, send, { now })).delivered).toBe(0);
    const log = await listWebhookDeliveries(t.db, org.orgId, all.endpoint.id);
    expect(log).toHaveLength(4);
    expect(log.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
    await expect(listWebhookDeliveries(t.db, rival.orgId, all.endpoint.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps trying with growing pauses, then gives up and says so', async () => {
    const { endpoint } = await createWebhookEndpoint(
      t.db,
      org.admin,
      { url: 'https://down.example.com/hook', events: ['reservation.*'] },
      open,
    );
    await queue([event()]);
    answer = 503;
    let now = new Date('2027-01-10T10:00:00Z');
    expect(await deliverDueWebhooks(t.db, send, { now })).toEqual({
      delivered: 0,
      retrying: 1,
      failed: 0,
    });
    let [delivery] = await listWebhookDeliveries(t.db, org.orgId, endpoint.id);
    expect(delivery).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastStatusCode: 503,
      lastError: 'The receiver answered 503',
      nextAttemptAt: new Date('2027-01-10T10:00:30Z'),
    });
    // Not before its time.
    expect(await deliverDueWebhooks(t.db, send, { now: new Date('2027-01-10T10:00:20Z') })).toEqual(
      { delivered: 0, retrying: 0, failed: 0 },
    );

    answer = new Error('connect ECONNREFUSED');
    const gaps: number[] = [];
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      now = delivery!.nextAttemptAt!;
      const run = await deliverDueWebhooks(t.db, send, { now });
      [delivery] = await listWebhookDeliveries(t.db, org.orgId, endpoint.id);
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        expect(run).toEqual({ delivered: 0, retrying: 1, failed: 0 });
        gaps.push((delivery!.nextAttemptAt!.getTime() - now.getTime()) / 1000);
      } else {
        expect(run).toEqual({ delivered: 0, retrying: 0, failed: 1 });
      }
    }
    expect(gaps).toEqual([120, 600, 1800, 7200, 21_600, 43_200]);
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: WEBHOOK_MAX_ATTEMPTS,
      lastStatusCode: null,
      lastError: 'connect ECONNREFUSED',
      nextAttemptAt: null,
    });
    expect(sent).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    // The receiver sees the same delivery id every time, so it can recognise a repeat.
    expect(new Set(sent.map((s) => s.headers['x-pms-delivery'])).size).toBe(1);
    expect((await listWebhookEndpoints(t.db, org.orgId))[0]).toMatchObject({
      active: true,
      consecutiveFailures: WEBHOOK_MAX_ATTEMPTS,
    });

    // Someone fixes the receiver and sends it again by hand.
    answer = 204;
    await retryWebhookDelivery(t.db, org.admin, delivery!.id);
    expect((await deliverDueWebhooks(t.db, send)).delivered).toBe(1);
    expect((await listWebhookEndpoints(t.db, org.orgId))[0]).toMatchObject({
      consecutiveFailures: 0,
    });
    await expect(retryWebhookDelivery(t.db, org.admin, delivery!.id)).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('switches off an endpoint that only ever fails, tells staff, and starts clean when switched on', async () => {
    const { endpoint } = await createWebhookEndpoint(
      t.db,
      org.admin,
      { url: 'https://gone.example.com/hook', events: ['*'] },
      open,
    );
    await queue(
      Array.from({ length: 31 }, (_, i) => event({ payload: { reservationId: `r-${i}` } })),
    );
    answer = 500;
    const now = new Date('2027-01-10T10:00:00Z');
    await deliverDueWebhooks(t.db, send, { now, limit: 30 });
    const [after] = await listWebhookEndpoints(t.db, org.orgId);
    expect(after).toMatchObject({ active: false, consecutiveFailures: 30 });
    expect(after!.disabledReason).toMatch(/^Switched off after 30 deliveries in a row failed/);
    const [alert] = await t.db.select().from(alerts);
    expect(alert).toMatchObject({
      kind: 'webhook_failing',
      severity: 'warning',
      title: 'The webhook to gone.example.com has been switched off',
      entityId: endpoint.id,
    });
    // Nothing is left waiting, and nothing new is queued for it.
    expect(
      await listWebhookDeliveries(t.db, org.orgId, endpoint.id, { status: 'pending' }),
    ).toEqual([]);
    expect(await queue([event()])).toBe(0);
    const before = sent.length;
    await deliverDueWebhooks(t.db, send, { now: new Date('2027-01-12T10:00:00Z') });
    expect(sent).toHaveLength(before);

    const back = await updateWebhookEndpoint(t.db, org.admin, endpoint.id, { active: true }, open);
    expect(back).toMatchObject({ active: true, consecutiveFailures: 0, disabledReason: null });
    expect((await t.db.select().from(alerts))[0]!.status).toBe('resolved');
    answer = 200;
    const ping = await queueWebhookTest(t.db, org.admin, endpoint.id);
    expect(ping).toMatchObject({ eventKind: 'ping', status: 'pending' });
    expect((await deliverDueWebhooks(t.db, send)).delivered).toBe(1);
    expect(JSON.parse(sent[sent.length - 1]!.body)).toMatchObject({ type: 'ping' });
  });

  it('forgets old deliveries', async () => {
    const { endpoint } = await createWebhookEndpoint(
      t.db,
      org.admin,
      { url: 'https://old.example.com/hook', events: ['*'] },
      open,
    );
    await queue([event(), event()]);
    await deliverDueWebhooks(t.db, send);
    await t.db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 20 * 86_400_000) })
      .where(
        eq(
          webhookDeliveries.id,
          (await listWebhookDeliveries(t.db, org.orgId, endpoint.id))[0]!.id,
        ),
      );
    expect(await pruneWebhookDeliveries(t.db)).toBe(1);
    expect(await listWebhookDeliveries(t.db, org.orgId, endpoint.id)).toHaveLength(1);
  });
});

describe('sending over the network', () => {
  it('posts the body with its headers and does not follow a redirect', async () => {
    const received: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body, url: req.url ?? '' });
        if (req.url === '/moved') {
          res.writeHead(302, { location: '/hook' }).end();
        } else {
          res.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const send = httpWebhookSender({ allowPrivate: true });
      const request = {
        url: `http://127.0.0.1:${port}/hook`,
        body: '{"type":"ping"}',
        headers: { 'content-type': 'application/json', 'x-pms-event': 'ping' },
      };
      expect(await send(request)).toEqual({ status: 204 });
      expect(received[0]).toMatchObject({
        url: '/hook',
        body: '{"type":"ping"}',
        headers: { 'content-type': 'application/json', 'x-pms-event': 'ping' },
      });
      expect(await send({ ...request, url: `http://127.0.0.1:${port}/moved` })).toEqual({
        status: 302,
      });
      expect(received).toHaveLength(2);

      // The same receiver is out of reach when private addresses are not allowed,
      // by its number and by a name that resolves to it.
      const strict = httpWebhookSender({ allowPrivate: false });
      await expect(strict(request)).rejects.toThrow(/not an address on the public internet/);
      await expect(strict({ ...request, url: `http://localhost:${port}/hook` })).rejects.toThrow(
        /not an address on the public internet/,
      );
      expect(received).toHaveLength(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
