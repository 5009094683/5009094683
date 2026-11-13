import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  properties,
  webhookDeliveries,
  webhookEndpoints,
  type DbOrTx,
  type Transaction,
  type WebhookDeliveryStatus,
} from '@pms/db';
import { raiseAlert, resolveAlert } from './alerts';
import { diff, writeAudit } from './audit';
import type { Actor } from './context';
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken, safeEqual } from './crypto';
import { invalidState, notFound, validationError } from './errors';
import { parsePgTimestamp, transact } from './sqlx';

/**
 * Outbound webhooks: other systems are told when something changes here.
 *
 * An event says what changed and carries the ids to look it up with, never a
 * guest's details: the receiver reads the current state through the API with
 * its own key. Every delivery is signed with the endpoint's secret and is
 * repeated, with growing pauses, until the receiver answers 2xx or a day and
 * a half has gone by.
 */

type EndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** The events an endpoint can ask for. */
export const WEBHOOK_EVENTS = [
  'reservation.created',
  'reservation.updated',
  'reservation.cancelled',
  'block.created',
  'block.updated',
  'block.released',
  'rates.updated',
  'message.received',
  'folio.updated',
  'alert.raised',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Pauses before the second and later attempts. After the last one a delivery is given up. */
const RETRY_AFTER_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
export const WEBHOOK_MAX_ATTEMPTS = RETRY_AFTER_MS.length + 1;
/** An endpoint that fails this many times in a row, with nothing getting through, is switched off. */
const DISABLE_AFTER_FAILURES = 30;
const SEND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Where a webhook may go

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 127],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  privateRanges.addSubnet(network, prefix, 'ipv6');
}

/**
 * Loopback, private, link-local and other addresses that are not on the
 * public internet. An IPv4 address written as IPv6 (`::ffff:10.0.0.1`) is
 * judged as the IPv4 address it is.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return privateRanges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Checks an address when it is saved. Names are checked again, by what they
 * resolve to, every time something is sent: a name can be pointed elsewhere
 * after it was saved.
 */
export function assertWebhookUrl(raw: string, options: { allowPrivate: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw validationError('Enter the full address, starting with https://');
  }
  if (url.username || url.password) {
    throw validationError('The address must not contain a user name or password');
  }
  if (raw.length > 2000) throw validationError('The address is too long');
  if (options.allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw validationError('The address must start with https:// or http://');
    }
    return url;
  }
  if (url.protocol !== 'https:') throw validationError('The address must start with https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isIP(host) !== 0 && isPrivateAddress(host))
  ) {
    throw validationError('The address must be reachable on the public internet');
  }
  return url;
}

export interface WebhookRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** Sends one delivery and says how the receiver answered. Replaced in tests. */
export type WebhookSender = (request: WebhookRequest) => Promise<{ status: number }>;

/**
 * Posts over HTTP(S) without following redirects. Unless private hosts are
 * allowed, the address the name resolves to is checked at the moment of
 * connecting, so a name cannot be used to reach an internal service.
 */
export function httpWebhookSender(options: { allowPrivate: boolean }): WebhookSender {
  const guardedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    dnsLookup(hostname, lookupOptions, (err, address, family) => {
      if (!err && !options.allowPrivate) {
        const found = Array.isArray(address) ? address.map((a) => a.address) : [address];
        if (found.some((a) => isPrivateAddress(a))) {
          callback(
            new Error(`${hostname} is not an address on the public internet`),
            address as never,
            family,
          );
          return;
        }
      }
      callback(err, address as never, family);
    });
  };
  return (request) =>
    new Promise((resolve, reject) => {
      const url = new URL(request.url);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!options.allowPrivate && isIP(host) !== 0 && isPrivateAddress(host)) {
        reject(new Error(`${host} is not an address on the public internet`));
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: 'POST',
          headers: { ...request.headers, 'content-length': Buffer.byteLength(request.body) },
          lookup: guardedLookup,
          timeout: SEND_TIMEOUT_MS,
        },
        (res) => {
          // The answer's body is of no interest: read it away so the connection can close.
          res.on('data', () => {});
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('The receiver took longer than 10 seconds')));
      req.on('error', reject);
      req.end(request.body);
    });
}

// ---------------------------------------------------------------------------
// Signing

/** `v1=<hex>`: HMAC-SHA256 of `<timestamp>.<body>` with the endpoint's secret. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

/**
 * What a receiver does with a delivery: checks the signature, and that the
 * timestamp is recent so a captured request cannot be replayed later.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: { signature: string | undefined; timestamp: string | undefined },
  body: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!headers.signature || !Number.isInteger(timestamp)) return false;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  return safeEqual(headers.signature, signWebhook(secret, timestamp, body));
}

// ---------------------------------------------------------------------------
// Endpoints

export interface WebhookEndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  propertyIds: string[] | null;
  active: boolean;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledReason: string | null;
  createdAt: Date;
}

const view = (row: EndpointRow): WebhookEndpointView => ({
  id: row.id,
  url: row.url,
  description: row.description,
  events: row.events,
  propertyIds: row.propertyIds,
  active: row.active,
  consecutiveFailures: row.consecutiveFailures,
  lastSuccessAt: row.lastSuccessAt,
  lastFailureAt: row.lastFailureAt,
  disabledReason: row.disabledReason,
  createdAt: row.createdAt,
});

export interface WebhookEndpointInput {
  url: string;
  description?: string | null;
  /** Event kinds, `reservation.*` for a whole family, or `*` for everything. */
  events: string[];
  propertyIds?: string[] | null;
  active?: boolean;
}

function cleanEvents(events: string[]): string[] {
  const out = [...new Set(events.map((e) => e.trim()))].filter(Boolean);
  if (out.length === 0) throw validationError('Choose at least one event');
  const families = new Set(WEBHOOK_EVENTS.map((e) => `${e.split('.')[0]}.*`));
  for (const event of out) {
    if (
      event !== '*' &&
      !families.has(event) &&
      !(WEBHOOK_EVENTS as readonly string[]).includes(event)
    ) {
      throw validationError(`There is no event called "${event}"`);
    }
  }
  return out;
}

async function cleanProperties(
  tx: DbOrTx,
  orgId: string,
  propertyIds: string[] | null | undefined,
): Promise<string[] | null> {
  if (!propertyIds || propertyIds.length === 0) return null;
  const own = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.orgId, orgId));
  const known = new Set(own.map((p) => p.id));
  const unknown = propertyIds.find((id) => !known.has(id));
  if (unknown) throw notFound('Property', unknown);
  return [...new Set(propertyIds)];
}

const newSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomToken(32)}`;

/** Adds an endpoint. The signing secret is returned here and nowhere else. */
export async function createWebhookEndpoint(
  db: DbOrTx,
  actor: Actor,
  input: WebhookEndpointInput,
  options: { allowPrivate: boolean },
): Promise<{ endpoint: WebhookEndpointView; secret: string }> {
  const url = assertWebhookUrl(input.url, options);
  const events = cleanEvents(input.events);
  return transact(db, async (tx) => {
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.orgId, actor.orgId));
    if (count >= 20) throw validationError('An organisation can have at most 20 webhook endpoints');
    const secret = newSecret();
    const [row] = await tx
      .insert(webhookEndpoints)
      .values({
        orgId: actor.orgId,
        url: url.toString(),
        description: input.description?.trim().slice(0, 200) || null,
        secretEnc: encryptSecret(secret),
        events,
        propertyIds: await cleanProperties(tx, actor.orgId, input.propertyIds),
        active: input.active ?? true,
        createdBy: actor.userId ?? null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'webhook.created',
      entityType: 'webhook_endpoint',
      entityId: row!.id,
      summary: `Added a webhook to ${url.host}`,
      changes: { url: row!.url, events },
    });
    return { endpoint: view(row!), secret };
  });
}

async function requireEndpoint(
  tx: DbOrTx,
  orgId: string,
  endpointId: string,
): Promise<EndpointRow> {
  const [row] = await tx
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.orgId, orgId)));
  if (!row) throw notFound('Webhook', endpointId);
  return row;
}

export async function updateWebhookEndpoint(
  db: DbOrTx,
  actor: Actor,
  endpointId: string,
  patch: Partial<WebhookEndpointInput>,
  options: { allowPrivate: boolean },
): Promise<WebhookEndpointView> {
  return transact(db, async (tx) => {
    const before = await requireEndpoint(tx, actor.orgId, endpointId);
    const values: Partial<typeof webhookEndpoints.$inferInsert> = {};
    if (patch.url !== undefined) values.url = assertWebhookUrl(patch.url, options).toString();
    if (patch.description !== undefined) {
      values.description = patch.description?.trim().slice(0, 200) || null;
    }
    if (patch.events !== undefined) values.events = cleanEvents(patch.events);
    if (patch.propertyIds !== undefined) {
      values.propertyIds = await cleanProperties(tx, actor.orgId, patch.propertyIds);
    }
    if (patch.active !== undefined) {
      values.active = patch.active;
      // Switching an endpoint back on gives it a clean start.
      if (patch.active && !before.active) {
        values.consecutiveFailures = 0;
        values.disabledReason = null;
      }
    }
    if (Object.keys(values).length === 0) return view(before);
    const [row] = await tx
      .update(webhookEndpoints)
      .set(values)
      .where(eq(webhookEndpoints.id, endpointId))
      .returning();
    if (row!.active) await resolveAlert(tx, actor.orgId, `webhook_failing:${endpointId}`);
    else await dropPending(tx, endpointId);
    await writeAudit(tx, actor, {
      action: 'webhook.updated',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      summary: `Changed the webhook to ${new URL(row!.url).host}`,
      changes: diff(before, values),
    });
    return view(row!);
  });
}

/** Replaces the signing secret. The old one stops working at once. */
export async function rotateWebhookSecret(
  db: DbOrTx,
  actor: Actor,
  endpointId: string,
): Promise<{ secret: string }> {
  return transact(db, async (tx) => {
    const endpoint = await requireEndpoint(tx, actor.orgId, endpointId);
    const secret = newSecret();
    await tx
      .update(webhookEndpoints)
      .set({ secretEnc: encryptSecret(secret) })
      .where(eq(webhookEndpoints.id, endpointId));
    await writeAudit(tx, actor, {
      action: 'webhook.secret_rotated',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      summary: `Replaced the signing secret of the webhook to ${new URL(endpoint.url).host}`,
    });
    return { secret };
  });
}

export async function deleteWebhookEndpoint(
  db: DbOrTx,
  actor: Actor,
  endpointId: string,
): Promise<void> {
  await transact(db, async (tx) => {
    const endpoint = await requireEndpoint(tx, actor.orgId, endpointId);
    await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, endpointId));
    await resolveAlert(tx, actor.orgId, `webhook_failing:${endpointId}`);
    await writeAudit(tx, actor, {
      action: 'webhook.deleted',
      entityType: 'webhook_endpoint',
      entityId: endpointId,
      summary: `Removed the webhook to ${new URL(endpoint.url).host}`,
    });
  });
}

export async function listWebhookEndpoints(
  db: DbOrTx,
  orgId: string,
): Promise<WebhookEndpointView[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.orgId, orgId))
    .orderBy(webhookEndpoints.createdAt);
  return rows.map(view);
}

export interface WebhookDeliveryView {
  id: number;
  eventId: string;
  eventKind: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export async function listWebhookDeliveries(
  db: DbOrTx,
  orgId: string,
  endpointId: string,
  options: { status?: WebhookDeliveryStatus; limit?: number } = {},
): Promise<WebhookDeliveryView[]> {
  await requireEndpoint(db, orgId, endpointId);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        options.status ? eq(webhookDeliveries.status, options.status) : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.id))
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map((d) => ({
    id: d.id,
    eventId: d.eventId,
    eventKind: d.eventKind,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    createdAt: d.createdAt,
    deliveredAt: d.deliveredAt,
  }));
}

// ---------------------------------------------------------------------------
// Queueing

export interface WebhookSourceEvent {
  kind: string;
  orgId: string;
  propertyId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** An inbox event is told to other systems only when a guest wrote, not when staff read or replied. */
function isPublic(event: WebhookSourceEvent): boolean {
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(event.kind)) return false;
  if (event.kind === 'message.received') {
    const p = event.payload;
    return !('read' in p || 'updated' in p || 'sent' in p || 'failed' in p || 'direction' in p);
  }
  // A folio event with nothing to look up (the night audit's "everything may have changed") is of no use.
  if (event.kind === 'folio.updated') return Object.keys(event.payload).length > 0;
  return true;
}

const wants = (endpoint: EndpointRow, event: WebhookSourceEvent): boolean =>
  (endpoint.propertyIds === null ||
    (event.propertyId !== null && endpoint.propertyIds.includes(event.propertyId))) &&
  endpoint.events.some(
    (e) => e === '*' || e === event.kind || e === `${event.kind.split('.')[0]}.*`,
  );

/**
 * Turns committed changes into deliveries for every endpoint that asked for
 * them. Called inside the transaction that takes the changes off the outbox,
 * so a change is never lost between the two.
 */
export async function queueWebhookDeliveries(
  tx: Transaction,
  events: WebhookSourceEvent[],
): Promise<number> {
  const relevant = events.filter(isPublic);
  if (relevant.length === 0) return 0;
  const endpoints = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        inArray(webhookEndpoints.orgId, [...new Set(relevant.map((e) => e.orgId))]),
        eq(webhookEndpoints.active, true),
      ),
    );
  if (endpoints.length === 0) return 0;
  const rows = relevant.flatMap((event) =>
    endpoints
      .filter((endpoint) => endpoint.orgId === event.orgId && wants(endpoint, event))
      .map((endpoint) => ({
        endpointId: endpoint.id,
        orgId: event.orgId,
        eventKind: event.kind,
        payload: {
          type: event.kind,
          createdAt: (parsePgTimestamp(event.createdAt) ?? new Date()).toISOString(),
          propertyId: event.propertyId,
          data: event.payload,
        },
      })),
  );
  if (rows.length === 0) return 0;
  await tx.insert(webhookDeliveries).values(rows);
  return rows.length;
}

/** Sends a `ping` to an endpoint, to try it out. */
export async function queueWebhookTest(
  db: DbOrTx,
  actor: Actor,
  endpointId: string,
): Promise<WebhookDeliveryView> {
  const endpoint = await requireEndpoint(db, actor.orgId, endpointId);
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      orgId: actor.orgId,
      eventKind: 'ping',
      payload: {
        type: 'ping',
        createdAt: new Date().toISOString(),
        propertyId: null,
        data: { message: 'This is a test from the property management system.' },
      },
    })
    .returning();
  return (await listWebhookDeliveries(db, actor.orgId, endpointId, { limit: 200 })).find(
    (d) => d.id === row!.id,
  )!;
}

/** Puts a delivery that was given up back in the queue, to be tried now. */
export async function retryWebhookDelivery(
  db: DbOrTx,
  actor: Actor,
  deliveryId: number,
): Promise<void> {
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.orgId, actor.orgId)));
  if (!delivery) throw notFound('Delivery', String(deliveryId));
  if (delivery.status === 'delivered') throw invalidState('This delivery already got through');
  await db
    .update(webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(eq(webhookDeliveries.id, deliveryId));
}

// ---------------------------------------------------------------------------
// Sending

export interface WebhookRun {
  delivered: number;
  /** Failed this time and waiting to be tried again. */
  retrying: number;
  /** Given up after the last attempt. */
  failed: number;
}

interface Claimed {
  id: number;
  attempts: number;
  eventId: string;
  eventKind: string;
  payload: Record<string, unknown>;
  endpointId: string;
  orgId: string;
  url: string;
  secretEnc: string;
}

/**
 * Sends the deliveries that are due. Each is first claimed in a short
 * transaction that also sets when it would next be tried, so a worker that
 * dies mid-send loses nothing and no lock is held while waiting on a
 * receiver. Several workers can run this at once.
 */
export async function deliverDueWebhooks(
  db: DbOrTx,
  send: WebhookSender,
  options: { now?: Date; limit?: number } = {},
): Promise<WebhookRun> {
  const now = options.now ?? new Date();
  const run: WebhookRun = { delivered: 0, retrying: 0, failed: 0 };
  const { rows: claimed } = await db.execute<{
    id: string;
    attempts: number;
    event_id: string;
    event_kind: string;
    payload: Record<string, unknown>;
    endpoint_id: string;
    org_id: string;
    url: string;
    secret_enc: string;
  }>(sql`
    WITH due AS (
      SELECT d.id FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ${now.toISOString()}::timestamptz AND e.active
      ORDER BY d.next_attempt_at
      LIMIT ${options.limit ?? 50}
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE webhook_deliveries d
    SET attempts = d.attempts + 1,
        -- Should this worker die before recording the outcome, the delivery is tried again then.
        next_attempt_at = ${now.toISOString()}::timestamptz + interval '2 minutes'
    FROM due, webhook_endpoints e
    WHERE d.id = due.id AND e.id = d.endpoint_id
    RETURNING d.id, d.attempts, d.event_id, d.event_kind, d.payload, d.endpoint_id, d.org_id, e.url, e.secret_enc
  `);
  const jobs: Claimed[] = claimed.map((c) => ({
    id: Number(c.id),
    attempts: c.attempts,
    eventId: c.event_id,
    eventKind: c.event_kind,
    payload: c.payload,
    endpointId: c.endpoint_id,
    orgId: c.org_id,
    url: c.url,
    secretEnc: c.secret_enc,
  }));

  await Promise.all(
    jobs.map(async (job) => {
      const body = JSON.stringify({ id: job.eventId, ...job.payload });
      const timestamp = Math.floor(now.getTime() / 1000);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const answer = await send({
          url: job.url,
          body,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'pms-webhooks/1',
            'x-pms-event': job.eventKind,
            'x-pms-delivery': job.eventId,
            'x-pms-timestamp': String(timestamp),
            'x-pms-signature': signWebhook(decryptSecret(job.secretEnc), timestamp, body),
          },
        });
        status = answer.status;
        if (status < 200 || status >= 300) error = `The receiver answered ${status}`;
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      }

      if (error === null) {
        run.delivered++;
        await db
          .update(webhookDeliveries)
          .set({ status: 'delivered', deliveredAt: now, lastStatusCode: status, lastError: null })
          .where(eq(webhookDeliveries.id, job.id));
        await db
          .update(webhookEndpoints)
          .set({
            consecutiveFailures: 0,
            lastSuccessAt: now,
            updatedAt: sql`${webhookEndpoints.updatedAt}`,
          })
          .where(eq(webhookEndpoints.id, job.endpointId));
        await resolveAlert(db, job.orgId, `webhook_failing:${job.endpointId}`);
        return;
      }

      const givenUp = job.attempts >= WEBHOOK_MAX_ATTEMPTS;
      if (givenUp) run.failed++;
      else run.retrying++;
      await db
        .update(webhookDeliveries)
        .set({
          status: givenUp ? 'failed' : 'pending',
          lastStatusCode: status,
          lastError: error,
          nextAttemptAt: new Date(now.getTime() + (RETRY_AFTER_MS[job.attempts - 1] ?? 0)),
        })
        .where(eq(webhookDeliveries.id, job.id));
      const [endpoint] = await db
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
          lastFailureAt: now,
          updatedAt: sql`${webhookEndpoints.updatedAt}`,
        })
        .where(eq(webhookEndpoints.id, job.endpointId))
        .returning();
      if (endpoint && endpoint.active && endpoint.consecutiveFailures >= DISABLE_AFTER_FAILURES) {
        const reason = `Switched off after ${endpoint.consecutiveFailures} deliveries in a row failed. The last answer: ${error}`;
        await db
          .update(webhookEndpoints)
          .set({ active: false, disabledReason: reason })
          .where(eq(webhookEndpoints.id, endpoint.id));
        await dropPending(db, endpoint.id);
        await raiseAlert(db, {
          orgId: job.orgId,
          kind: 'webhook_failing',
          severity: 'warning',
          title: `The webhook to ${new URL(endpoint.url).host} has been switched off`,
          body: `${reason}. Nothing more is sent to it until it is switched back on under Settings, Integrations.`,
          entityType: 'webhook_endpoint',
          entityId: endpoint.id,
          dedupeKey: `webhook_failing:${endpoint.id}`,
        });
      }
    }),
  );
  return run;
}

/**
 * Gives up what was waiting for an endpoint that is switched off, so that
 * switching it on again later does not release a flood of old news.
 */
async function dropPending(db: DbOrTx, endpointId: string): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status: 'failed', lastError: 'The webhook was switched off before this was sent' })
    .where(
      and(eq(webhookDeliveries.endpointId, endpointId), eq(webhookDeliveries.status, 'pending')),
    );
}

/** Forgets deliveries that got through two weeks ago and ones given up two months ago. */
export async function pruneWebhookDeliveries(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM webhook_deliveries
    WHERE (status = 'delivered' AND created_at < ${now.toISOString()}::timestamptz - interval '14 days')
       OR (status = 'failed' AND created_at < ${now.toISOString()}::timestamptz - interval '60 days')
  `);
  return result.rowCount ?? 0;
}
