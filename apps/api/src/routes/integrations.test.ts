import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, webhookDeliveries } from '@pms/db';
import { addDays, todayIn } from '@pms/domain';
import {
  createTestHotel,
  createTestOrg,
  createTestUser,
  type TestHotel,
} from '@pms/domain/testing';
import { createTestApp, type TestApp, type TestClient } from '../testing';

let ctx: TestApp;
let hotel: TestHotel;
let other: TestHotel;
let admin: TestClient;
let manager: TestClient;
let rival: TestClient;

const today = todayIn('Asia/Kolkata');
const day = (n: number) => addDays(today, n);

/** Calls the API the way another system does: with a key, and no cookie. */
const withKey = (key: string) => ({
  get: (url: string) =>
    ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } }),
  post: (url: string, payload: object = {}) =>
    ctx.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${key}` } }),
  delete: (url: string) =>
    ctx.app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${key}` } }),
});

beforeAll(async () => {
  ctx = await createTestApp({ WEBHOOKS_ALLOW_PRIVATE_HOSTS: 'false' });
  hotel = await createTestHotel(ctx.t.db, ctx.org);
  other = await createTestHotel(ctx.t.db, ctx.org);
  admin = await ctx.admin();
  manager = await ctx.login(
    (await createTestUser(ctx.t.db, ctx.org.orgId, { role: 'general_manager' })).email,
  );
  const elsewhere = await createTestOrg(ctx.t.db, 'Rival Hotels');
  rival = await ctx.login(
    (await createTestUser(ctx.t.db, elsewhere.orgId, { role: 'org_admin' })).email,
  );
});
afterAll(async () => {
  await ctx.close();
});

const booking = (propertyId = hotel.property.id, from = 10) => ({
  propertyId,
  source: 'website',
  guest: { firstName: 'Asha', lastName: 'Rao' },
  rooms: [
    {
      roomTypeId: (propertyId === hotel.property.id ? hotel : other).standard.roomType.id,
      ratePlanId: (propertyId === hotel.property.id ? hotel : other).standard.ratePlan.id,
      checkIn: day(from),
      checkOut: day(from + 2),
      adults: 2,
    },
  ],
});

describe('API keys', () => {
  it('are made and revoked by those who manage the organisation', async () => {
    const body = {
      name: 'Website',
      grants: [{ role: 'front_desk', propertyId: hotel.property.id }],
    };
    expect((await manager.post('/api-keys', body)).statusCode).toBe(403);
    expect((await manager.get('/api-keys')).statusCode).toBe(403);
    const created = await admin.post('/api-keys', body);
    expect(created.statusCode, created.body).toBe(201);
    const { key, apiKey } = created.json();
    expect(key).toMatch(/^pms_/);
    const listed = (await admin.get('/api-keys')).json();
    expect(listed.keys).toMatchObject([
      { id: apiKey.id, name: 'Website', prefix: key.slice(0, 10) },
    ]);
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(listed.roles.map((r: { role: string }) => r.role)).not.toContain('org_admin');
    expect((await rival.get('/api-keys')).json().keys).toEqual([]);
    expect((await rival.delete(`/api-keys/${apiKey.id}`)).statusCode).toBe(404);
    expect(
      (
        await admin.post('/api-keys', {
          name: 'Too much',
          grants: [{ role: 'org_admin', propertyId: null }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('let another system do what the key\u2019s role allows, where it allows it', async () => {
    const { key } = (
      await admin.post('/api-keys', {
        name: 'Booking widget',
        grants: [{ role: 'front_desk', propertyId: hotel.property.id }],
      })
    ).json();
    const api = withKey(key);
    const made = await api.post('/reservations', booking());
    expect(made.statusCode, made.body).toBe(201);
    const reservation = made.json();
    expect((await api.get(`/reservations/${reservation.id}`)).json().code).toBe(reservation.code);
    // What the key did is on record as the key's doing.
    const [entry] = await ctx.t.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'reservation.created'), eq(auditLog.entityId, reservation.id)),
      );
    expect(entry).toMatchObject({
      actorType: 'api_key',
      actorUserId: null,
      actorLabel: 'api-key:Booking widget',
    });

    // Its role is for one property, and does not stretch to rates or accounts.
    expect((await api.post('/reservations', booking(other.property.id))).statusCode).toBe(403);
    expect(
      (await api.get(`/reports/performance?from=${day(1)}&to=${day(3)}`)).json().total,
    ).toMatchObject({ available: 10 });
    expect(
      (
        await api.get(
          `/reports/performance?from=${day(1)}&to=${day(3)}&propertyIds=${other.property.id}`,
        )
      ).statusCode,
    ).toBe(403);
    expect((await api.post(`/properties/${hotel.property.id}/pricing/refresh`)).statusCode).toBe(
      403,
    );
    // Users, keys, webhooks and a person's own session are never a key's business.
    for (const path of ['/users', '/api-keys', '/outbound-webhooks', '/audit']) {
      expect((await api.get(path)).statusCode, path).toBe(403);
    }
    expect((await api.get('/auth/me')).statusCode).toBe(401);
    expect(
      (await api.post('/ai/copilot', { messages: [{ role: 'user', content: 'help' }] })).statusCode,
    ).toBe(403);
  });

  it('stop working when revoked, and a wrong key gets nothing', async () => {
    const { key, apiKey } = (
      await admin.post('/api-keys', {
        name: 'Short-lived',
        grants: [{ role: 'read_only', propertyId: null }],
      })
    ).json();
    const api = withKey(key);
    expect((await api.get('/reservations')).statusCode).toBe(200);
    expect((await api.post('/reservations', booking(hotel.property.id, 20))).statusCode).toBe(403);
    expect((await admin.delete(`/api-keys/${apiKey.id}`)).json().revokedAt).toBeTruthy();
    const refused = await api.get('/reservations');
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.message).toBe('This API key is not valid, or no longer valid');
    expect((await withKey('pms_not-a-real-key').get('/reservations')).statusCode).toBe(401);
    // A key never rides along with someone's session.
    const both = await ctx.app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: 'Bearer pms_not-a-real-key', cookie: admin.cookie! },
    });
    expect(both.statusCode).toBe(401);
  });

  it('are held to a number of requests a minute', async () => {
    const small = await createTestApp({ API_KEY_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const boss = await small.admin();
      const { key } = (
        await boss.post('/api-keys', {
          name: 'Busy',
          grants: [{ role: 'read_only', propertyId: null }],
        })
      ).json();
      const call = () =>
        small.app.inject({
          method: 'GET',
          url: '/properties',
          headers: { authorization: `Bearer ${key}` },
        });
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push(await call());
      expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200, 429]);
      expect(Number(answers[3]!.headers['retry-after'])).toBeGreaterThan(0);
      expect(answers[3]!.json().error.code).toBe('rate_limited');
      // People signed in are not counted against the key.
      expect((await boss.get('/properties')).statusCode).toBe(200);
    } finally {
      await small.close();
    }
  });
});

describe('outbound webhooks', () => {
  it('are set up by those who manage the organisation, and only to public addresses', async () => {
    const body = { url: 'https://hooks.example.com/pms', events: ['reservation.*'] };
    expect((await manager.post('/outbound-webhooks', body)).statusCode).toBe(403);
    expect((await manager.get('/outbound-webhooks')).statusCode).toBe(403);
    for (const url of [
      'http://hooks.example.com/pms',
      'https://127.0.0.1/hook',
      'https://localhost/x',
    ]) {
      const refused = await admin.post('/outbound-webhooks', { ...body, url });
      expect(refused.statusCode, url).toBe(400);
    }
    const created = await admin.post('/outbound-webhooks', body);
    expect(created.statusCode, created.body).toBe(201);
    const { endpoint, secret } = created.json();
    expect(secret).toMatch(/^whsec_/);

    const listed = (await admin.get('/outbound-webhooks')).json();
    expect(listed.endpoints).toMatchObject([
      { id: endpoint.id, url: 'https://hooks.example.com/pms', active: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain('whsec_');
    expect(listed.events).toContain('reservation.created');
    expect((await rival.get('/outbound-webhooks')).json().endpoints).toEqual([]);
    for (const call of [
      () => rival.patch(`/outbound-webhooks/${endpoint.id}`, { active: false }),
      () => rival.post(`/outbound-webhooks/${endpoint.id}/rotate-secret`),
      () => rival.post(`/outbound-webhooks/${endpoint.id}/test`),
      () => rival.get(`/outbound-webhooks/${endpoint.id}/deliveries`),
      () => rival.delete(`/outbound-webhooks/${endpoint.id}`),
    ]) {
      expect((await call()).statusCode).toBe(404);
    }

    const changed = await admin.patch(`/outbound-webhooks/${endpoint.id}`, {
      events: ['reservation.created', 'rates.updated'],
      propertyIds: [hotel.property.id],
    });
    expect(changed.json()).toMatchObject({
      events: ['reservation.created', 'rates.updated'],
      propertyIds: [hotel.property.id],
    });
    expect(
      (await admin.patch(`/outbound-webhooks/${endpoint.id}`, { events: ['nonsense'] })).statusCode,
    ).toBe(400);
    const rotated = (await admin.post(`/outbound-webhooks/${endpoint.id}/rotate-secret`)).json();
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(secret);

    const ping = await admin.post(`/outbound-webhooks/${endpoint.id}/test`);
    expect(ping.statusCode).toBe(202);
    expect(ping.json()).toMatchObject({ eventKind: 'ping', status: 'pending', attempts: 0 });
    const log = (await admin.get(`/outbound-webhooks/${endpoint.id}/deliveries`)).json();
    expect(log.deliveries).toHaveLength(1);
    // Only one that was given up can be sent again by hand; another organisation's cannot at all.
    await ctx.t.db
      .update(webhookDeliveries)
      .set({ status: 'failed', attempts: 8 })
      .where(eq(webhookDeliveries.id, log.deliveries[0].id));
    expect(
      (await rival.post(`/outbound-webhooks/deliveries/${log.deliveries[0].id}/retry`)).statusCode,
    ).toBe(404);
    expect(
      (await admin.post(`/outbound-webhooks/deliveries/${log.deliveries[0].id}/retry`)).statusCode,
    ).toBe(202);
    expect(
      (await admin.get(`/outbound-webhooks/${endpoint.id}/deliveries?status=pending`)).json()
        .deliveries,
    ).toMatchObject([{ status: 'pending', attempts: 0 }]);

    expect((await admin.delete(`/outbound-webhooks/${endpoint.id}`)).statusCode).toBe(204);
    expect((await admin.get('/outbound-webhooks')).json().endpoints).toEqual([]);
  });
});
