import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@pms/config';
import { webhookEvents, type Database } from '@pms/db';
import { enqueueJob, raiseAlert, resolveAlert } from '@pms/domain';
import { queueThreadPull } from '../engine/messages';
import { CHANNEL_JOBS } from '../jobs';

export interface IncomingWebhook {
  headers: Record<string, string | string[] | undefined>;
  /** The request body exactly as received. Signatures are computed over these bytes. */
  rawBody: Buffer;
}

/** Channex signs with the time of sending; anything older than this is treated as a replay. */
const MAX_SKEW_SECONDS = 300;

function header(headers: IncomingWebhook['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decides whether a call to the webhook endpoint really came from Channex.
 *
 * Two mechanisms are supported, matching what Channex offers. Each one that
 * is configured must pass:
 * - HMAC signing (`CHANNEX_WEBHOOK_SIGNING_SECRET`): the signature over
 *   `<timestamp>.<raw body>` must match, and the timestamp must be recent.
 * - A shared secret header (`CHANNEX_WEBHOOK_SECRET`), sent by Channex as
 *   `x-channex-webhook-secret`.
 *
 * With neither configured the call is refused in production. Elsewhere it is
 * let through so a local simulator works without setup.
 */
export function verifyChannexWebhook(
  env: Pick<Env, 'CHANNEX_WEBHOOK_SECRET' | 'CHANNEX_WEBHOOK_SIGNING_SECRET' | 'isProduction'>,
  request: IncomingWebhook,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const signingSecret = env.CHANNEX_WEBHOOK_SIGNING_SECRET;
  const sharedSecret = env.CHANNEX_WEBHOOK_SECRET;
  if (!signingSecret && !sharedSecret) {
    return env.isProduction
      ? { ok: false, reason: 'No webhook secret is configured' }
      : { ok: true };
  }
  if (signingSecret) {
    const timestamp = header(request.headers, 'x-hmac-timestamp');
    const signatures = header(request.headers, 'x-hmac-signature-256');
    if (!timestamp || !signatures) return { ok: false, reason: 'The request is not signed' };
    if (
      !/^\d+$/.test(timestamp) ||
      Math.abs(now.getTime() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS
    ) {
      return { ok: false, reason: 'The signature timestamp is too old or too new' };
    }
    const expected = createHmac('sha256', signingSecret)
      .update(`${timestamp}.`)
      .update(request.rawBody)
      .digest('hex');
    // Two signatures are sent while a key is being rotated; either may match the secret held here.
    const matches = signatures.split(',').some((s) => safeEqual(s.trim().toLowerCase(), expected));
    if (!matches) return { ok: false, reason: 'The signature does not match' };
  }
  if (sharedSecret) {
    const sent = header(request.headers, 'x-channex-webhook-secret');
    if (!sent || !safeEqual(sent, sharedSecret))
      return { ok: false, reason: 'The shared secret does not match' };
  }
  return { ok: true };
}

export interface ChannexWebhookBody {
  event?: string;
  property_id?: string | null;
  user_id?: string | null;
  timestamp?: string;
  payload?: Record<string, unknown> | unknown[];
}

export interface WebhookOutcome {
  event: string;
  connectionId: string | null;
  /** What was done about it. */
  action:
    | 'pull_queued'
    | 'messages_queued'
    | 'alert_raised'
    | 'alert_resolved'
    | 'stored'
    | 'unknown_property';
}

const BOOKING_EVENTS = new Set([
  'booking',
  'booking_new',
  'booking_modification',
  'booking_cancellation',
  'non_acked_booking',
  'booking_unmapped_room',
  'booking_unmapped_rate',
]);

/**
 * Acts on one webhook delivery from Channex.
 *
 * A webhook is treated as a nudge, never as data: a booking event queues a
 * fetch of the revision feed, and the booking itself is read from the API
 * with our own key. So a forged or replayed delivery can cause an extra
 * fetch, and nothing more.
 */
export async function handleChannexWebhook(
  db: Database,
  body: ChannexWebhookBody,
): Promise<WebhookOutcome> {
  const event = typeof body.event === 'string' ? body.event : 'unknown';
  const payload = (body.payload && !Array.isArray(body.payload) ? body.payload : {}) as Record<
    string,
    unknown
  >;
  const propertyId =
    body.property_id ?? (typeof payload.property_id === 'string' ? payload.property_id : null);

  const { rows } = propertyId
    ? await db.execute<{
        id: string;
        org_id: string;
        property_id: string;
        name: string;
        property_name: string;
      }>(sql`
        SELECT c.id, c.org_id, c.property_id, c.name, p.name AS property_name
        FROM channel_connections c JOIN properties p ON p.id = c.property_id
        WHERE c.adapter = 'channex' AND c.config->>'externalPropertyId' = ${propertyId}
        LIMIT 1
      `)
    : { rows: [] };
  const connection = rows[0];

  const [stored] = await db
    .insert(webhookEvents)
    .values({
      source: 'channex',
      eventType: event,
      connectionId: connection?.id ?? null,
      // Guest messages and reviews are kept for the inbox; booking payloads carry only ids.
      payload: body as Record<string, unknown>,
      error: connection ? null : 'No connection uses this channel manager property',
    })
    .returning({ id: webhookEvents.id });
  if (!connection) return { event, connectionId: null, action: 'unknown_property' };

  const done = async (action: WebhookOutcome['action']): Promise<WebhookOutcome> => {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(sql`${webhookEvents.id} = ${stored!.id}`);
    return { event, connectionId: connection.id, action };
  };
  const alertBase = {
    orgId: connection.org_id,
    propertyId: connection.property_id,
    entityType: 'channel_connection',
    entityId: connection.id,
  };
  const channel = String(
    payload.channel_name ?? payload.channel ?? payload.title ?? payload.ota_name ?? 'a channel',
  );
  const channelKey = String(payload.channel_id ?? channel);

  if (BOOKING_EVENTS.has(event)) {
    const revisionId = payload.revision_id ?? payload.booking_revision_id;
    await enqueueJob(
      db,
      CHANNEL_JOBS.pull,
      { connectionId: connection.id, via: 'webhook', revisionId: revisionId ?? null },
      // One job per announced revision: a fetch already running may have read the feed before this revision existed.
      {
        uniqueKey: `${CHANNEL_JOBS.pull}:${connection.id}:${String(revisionId ?? stored!.id)}`,
        maxAttempts: 6,
      },
    );
    if (event === 'booking_unmapped_room' || event === 'booking_unmapped_rate') {
      const room = event === 'booking_unmapped_room';
      await raiseAlert(db, {
        ...alertBase,
        kind: 'unmapped_booking',
        severity: room ? 'critical' : 'warning',
        title: `${connection.property_name}: a booking arrived for a ${room ? 'room' : 'rate'} that is not mapped in the channel manager`,
        body: room
          ? 'A channel sent a booking for a room the channel manager cannot match to a room type, so availability was not reduced for it. Fix the channel mapping under Channels now: until then this room can be sold twice.'
          : 'A channel sent a booking on a rate the channel manager cannot match to a rate plan. The room is held; check the price on the reservation and fix the channel mapping under Channels.',
        dedupeKey: `channex_unmapped:${connection.id}:${room ? 'room' : 'rate'}`,
        metadata: { bookingId: payload.booking_id, revisionId },
      });
    }
    return done('pull_queued');
  }

  switch (event) {
    case 'message':
    case 'message_thread_booking_assigned': {
      // The message itself is read from the channel manager, not from this call.
      const threadId = payload.message_thread_id;
      if (typeof threadId !== 'string' || !threadId) return done('stored');
      await queueThreadPull(db, connection.id, threadId);
      return done('messages_queued');
    }
    case 'sync_error':
    case 'sync_warning':
    case 'rate_error': {
      const critical = event === 'sync_error';
      await raiseAlert(db, {
        ...alertBase,
        kind: 'sync_failure',
        severity: critical ? 'critical' : 'warning',
        title: `${connection.property_name}: ${channel} ${critical ? 'did not accept an update' : 'reported a problem with an update'}`,
        body:
          `The channel manager reports ${String(payload.error_type ?? event).replace(/_/g, ' ')} for ${channel}. ` +
          (critical
            ? 'Availability or rates on that channel may be out of date. Open the channel under Channels to see the details and reconnect if needed.'
            : 'Open the channel under Channels to see which values were affected.'),
        dedupeKey: `channex_${event}:${connection.id}:${channelKey}`,
        metadata: payload,
      });
      return done('alert_raised');
    }
    case 'disconnect_channel':
    case 'deactivate_channel':
    case 'disconnect_listing':
      await raiseAlert(db, {
        ...alertBase,
        kind: 'channel_disconnected',
        severity: 'critical',
        title: `${connection.property_name}: ${channel} is no longer connected`,
        body: `${channel} was disconnected or switched off in the channel manager. It no longer receives availability and rates, and its bookings no longer arrive here. Reconnect it under Channels, or close the listing on the channel itself.`,
        dedupeKey: `channex_disconnected:${connection.id}:${channelKey}`,
        metadata: payload,
      });
      return done('alert_raised');
    case 'activate_channel':
      await resolveAlert(
        db,
        connection.org_id,
        `channex_disconnected:${connection.id}:${channelKey}`,
      );
      return done('alert_resolved');
    case 'channel_removal_warning':
    case 'property_removal_warning':
      await raiseAlert(db, {
        ...alertBase,
        kind: 'channel_disconnected',
        severity: 'warning',
        title: `${connection.property_name}: the channel manager will remove ${event === 'channel_removal_warning' ? channel : 'this property'} in ${String(payload.days_left ?? 'a few')} day(s)`,
        body: `It has had no active channel for some time and is scheduled for removal on ${String(payload.removal_date ?? 'a date soon')}. Activate a channel to keep it.`,
        dedupeKey: `channex_${event}:${connection.id}:${channelKey}`,
        metadata: payload,
      });
      return done('alert_raised');
    default:
      // Reviews, Airbnb requests and anything new: kept as received for the features that read them.
      return { event, connectionId: connection.id, action: 'stored' };
  }
}
