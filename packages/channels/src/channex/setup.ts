import { and, asc, eq, sql } from 'drizzle-orm';
import type { Env } from '@pms/config';
import { channelConnections, properties, ratePlans, roomTypes, type Database } from '@pms/db';
import { DomainError, minorToDecimal, validationError, writeAudit, type Actor } from '@pms/domain';
import { ChannelError } from '../adapter';
import {
  adapterContext,
  getMappings,
  requireConnection,
  saveMappings,
  type ConnectionRow,
} from '../engine/connections';
import { channexClientFor } from './adapter';
import type { ChannexClient, ChannexRatePlanSummary } from './client';

/** Events the PMS asks Channex to announce. `ari` is left out: it would echo every push back. */
export const CHANNEX_WEBHOOK_EVENTS = [
  'booking',
  'booking_unmapped_room',
  'booking_unmapped_rate',
  'non_acked_booking',
  'message',
  'inquiry',
  'reservation_request',
  'alteration_request',
  'review',
  'updated_review',
  'sync_error',
  'sync_warning',
  'rate_error',
  'disconnect_channel',
  'disconnect_listing',
  'activate_channel',
  'deactivate_channel',
  'channel_removal_warning',
  'property_removal_warning',
] as const;

export const CHANNEX_WEBHOOK_PATH = '/webhooks/channex';

export interface ChannexStatus {
  /** An API key is set, so the PMS can talk to Channex at all. */
  configured: boolean;
  environment: 'production' | 'staging' | 'simulator' | 'other';
  baseUrl: string;
  /** A webhook secret is set, so incoming webhook calls can be verified. */
  webhookSecured: boolean;
  webhookUrl: string;
  /** Who the API key belongs to, when Channex could be asked. */
  account: { email: string | null; name: string | null } | null;
  /** Why Channex could not be reached with this key, if it could not. */
  error: string | null;
}

function environmentOf(baseUrl: string, env: Env): ChannexStatus['environment'] {
  if (
    baseUrl.startsWith('https://app.channex.io') ||
    baseUrl.startsWith('https://secure.channex.io')
  ) {
    return 'production';
  }
  if (baseUrl.includes('staging.channex.io')) return 'staging';
  if (env.usingChannelSimulator) return 'simulator';
  return 'other';
}

function accountClient(env: Env): ChannexClient {
  try {
    return channexClientFor({ config: {}, secrets: {}, env });
  } catch (err) {
    throw new DomainError('not_configured', err instanceof Error ? err.message : String(err));
  }
}

/** Converts channel failures into errors the API reports properly instead of as a crash. */
async function upstream<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ChannelError) {
      throw new DomainError(
        err.status === undefined && !err.retryable ? 'not_configured' : 'upstream_failed',
        err.message,
      );
    }
    throw err;
  }
}

/** What the environment says about the channel manager, without calling it. */
export function channexConfig(
  env: Env,
): Pick<ChannexStatus, 'configured' | 'environment' | 'webhookSecured'> {
  return {
    configured: Boolean(env.CHANNEX_API_KEY),
    environment: environmentOf(env.CHANNEX_BASE_URL, env),
    webhookSecured: Boolean(env.CHANNEX_WEBHOOK_SECRET || env.CHANNEX_WEBHOOK_SIGNING_SECRET),
  };
}

/** Whether the channel manager is set up and reachable. Never throws. */
export async function channexStatus(env: Env): Promise<ChannexStatus> {
  const status: ChannexStatus = {
    ...channexConfig(env),
    baseUrl: env.CHANNEX_BASE_URL,
    webhookUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${CHANNEX_WEBHOOK_PATH}`,
    account: null,
    error: null,
  };
  if (!status.configured) return status;
  try {
    const me = await accountClient(env).whoami();
    status.account = { email: me.email, name: me.name };
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  }
  return status;
}

/** Properties the API key can see at Channex, for choosing which one a PMS property corresponds to. */
export async function listChannexProperties(
  env: Env,
): Promise<{ id: string; title: string; currency: string | null }[]> {
  return upstream(() => accountClient(env).listProperties());
}

export interface ChannexStructure {
  property: { id: string; title: string; currency: string | null } | null;
  roomTypes: { id: string; title: string; countOfRooms: number }[];
  ratePlans: { id: string; title: string; roomTypeId: string }[];
}

/** The room types and rate plans that exist at Channex for a connection's property: the choices for mapping. */
export async function channexStructure(
  db: Database,
  orgId: string,
  connectionId: string,
): Promise<ChannexStructure> {
  const connection = await requireChannex(db, orgId, connectionId);
  const externalId = connection.config.externalPropertyId;
  if (!externalId) return { property: null, roomTypes: [], ratePlans: [] };
  const client = clientFor(connection);
  return upstream(async () => {
    const [property, rooms, rates] = await Promise.all([
      client.getProperty(externalId),
      client.listRoomTypes(externalId),
      client.listRatePlans(externalId),
    ]);
    return {
      property: property
        ? { id: property.id, title: property.title, currency: property.currency }
        : null,
      roomTypes: rooms,
      ratePlans: rates.map((r) => ({ id: r.id, title: r.title, roomTypeId: r.roomTypeId })),
    };
  });
}

async function requireChannex(
  db: Database,
  orgId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const connection = await requireConnection(db, orgId, connectionId);
  if (connection.adapter !== 'channex')
    throw validationError('This is not a channel manager connection');
  return connection;
}

function clientFor(connection: ConnectionRow): ChannexClient {
  try {
    return channexClientFor(adapterContext(connection));
  } catch (err) {
    throw new DomainError('not_configured', err instanceof Error ? err.message : String(err));
  }
}

export interface ProvisionResult {
  externalPropertyId: string;
  propertyCreated: boolean;
  roomTypesCreated: number;
  ratePlansCreated: number;
  /** Room types and rate plans now mapped. */
  mappedRoomTypes: number;
  mappedRatePlans: number;
}

/**
 * Sets a property up at Channex from what the PMS already knows: creates the
 * property there (unless one is already chosen), a room type for each PMS
 * room type and a rate plan for each PMS rate plan, and maps them.
 *
 * Anything already mapped is left alone, and anything at Channex with the
 * same name is reused rather than duplicated, so running it again after
 * adding a room type only adds that room type.
 */
export async function provisionChannex(
  db: Database,
  actor: Actor,
  connectionId: string,
): Promise<ProvisionResult> {
  const connection = await requireChannex(db, actor.orgId, connectionId);
  const client = clientFor(connection);
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  const typeRows = await db
    .select()
    .from(roomTypes)
    .where(and(eq(roomTypes.propertyId, connection.propertyId), eq(roomTypes.active, true)))
    .orderBy(asc(roomTypes.sortOrder), asc(roomTypes.name));
  const { rows: unitCounts } = await db.execute<{ room_type_id: string; n: number }>(sql`
    SELECT room_type_id, count(*)::int AS n FROM units
    WHERE property_id = ${connection.propertyId} AND active
    GROUP BY room_type_id
  `);
  const types = typeRows.map((type) => ({
    type,
    units: unitCounts.find((u) => u.room_type_id === type.id)?.n ?? 0,
  }));
  const plans = await db
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.propertyId, connection.propertyId), eq(ratePlans.active, true)))
    .orderBy(asc(ratePlans.name));
  if (types.length === 0)
    throw validationError('Add at least one room type before setting up the channel manager');

  return upstream(async () => {
    let externalPropertyId = connection.config.externalPropertyId;
    let propertyCreated = false;
    if (!externalPropertyId) {
      const created = await client.createProperty({
        title: property!.name,
        currency: property!.currency,
        timezone: property!.timezone,
        country: property!.country,
        city: property!.city,
        address: property!.addressLine1,
        zip_code: property!.postalCode,
        email: property!.email,
        phone: property!.phone,
        // Channex bills by this: hotels per property, holiday homes per unit.
        property_type: property!.kind === 'hotel' ? 'hotel' : 'apartment',
        settings: {
          // The PMS sends both kinds of minimum stay, and is the one source of availability.
          min_stay_type: 'both',
          allow_availability_autoupdate_on_cancellation: false,
          allow_availability_autoupdate_on_modification: false,
        },
      });
      externalPropertyId = created.id;
      propertyCreated = true;
      await db
        .update(channelConnections)
        .set({ config: { ...connection.config, externalPropertyId } })
        .where(eq(channelConnections.id, connection.id));
    }

    const existing = await getMappings(db, connection.id);
    const roomMap = new Map(existing.roomTypes.map((m) => [m.roomTypeId, m]));
    const rateMap = new Map(existing.ratePlans.map((m) => [m.ratePlanId, m]));
    const remoteRooms = await client.listRoomTypes(externalPropertyId);
    const remoteRates = await client.listRatePlans(externalPropertyId);
    const takenRooms = new Set(existing.roomTypes.map((m) => m.externalId));
    const takenRates = new Set(existing.ratePlans.map((m) => m.externalId));
    let roomTypesCreated = 0;
    let ratePlansCreated = 0;

    for (const { type, units } of types) {
      if (roomMap.has(type.id)) continue;
      const adults = Math.max(1, type.maxAdults);
      let remote = remoteRooms.find((r) => !takenRooms.has(r.id) && sameName(r.title, type.name));
      if (!remote) {
        remote = {
          ...(await client.createRoomType({
            property_id: externalPropertyId,
            title: type.name,
            count_of_rooms: Math.max(1, units),
            occ_adults: adults,
            occ_children: Math.max(0, type.maxChildren),
            occ_infants: 0,
            default_occupancy: Math.min(adults, Math.max(1, type.baseOccupancy)),
          })),
          countOfRooms: Math.max(1, units),
        };
        roomTypesCreated++;
      }
      takenRooms.add(remote.id);
      roomMap.set(type.id, {
        roomTypeId: type.id,
        externalId: remote.id,
        externalName: remote.title,
      });
    }

    for (const plan of plans) {
      if (rateMap.has(plan.id)) continue;
      const room = roomMap.get(plan.roomTypeId);
      if (!room) continue;
      const type = types.find((t) => t.type.id === plan.roomTypeId)!.type;
      let remote: Pick<ChannexRatePlanSummary, 'id' | 'title'> | undefined = remoteRates.find(
        (r) =>
          !takenRates.has(r.id) && r.roomTypeId === room.externalId && sameName(r.title, plan.name),
      );
      if (!remote) {
        remote = await client.createRatePlan({
          property_id: externalPropertyId,
          room_type_id: room.externalId,
          title: plan.name,
          currency: plan.currency,
          sell_mode: 'per_room',
          // Every plan is priced by the PMS, including ones the PMS derives from another plan.
          rate_mode: 'manual',
          options: [
            {
              occupancy: Math.min(Math.max(1, type.maxAdults), Math.max(1, type.baseOccupancy)),
              is_primary: true,
              ...(plan.baseRate > 0 ? { rate: minorToDecimal(plan.baseRate, plan.currency) } : {}),
            },
          ],
        });
        ratePlansCreated++;
      }
      takenRates.add(remote.id);
      rateMap.set(plan.id, {
        ratePlanId: plan.id,
        externalId: remote.id,
        externalName: remote.title,
      });
    }

    await saveMappings(db, actor, connection.id, {
      roomTypes: [...roomMap.values()],
      ratePlans: [...rateMap.values()],
    });
    await writeAudit(db, actor, {
      action: 'channel.provisioned',
      entityType: 'channel_connection',
      entityId: connection.id,
      propertyId: connection.propertyId,
      summary: `Set up ${property!.name} in the channel manager`,
      changes: { propertyCreated, roomTypesCreated, ratePlansCreated },
    });
    return {
      externalPropertyId,
      propertyCreated,
      roomTypesCreated,
      ratePlansCreated,
      mappedRoomTypes: roomMap.size,
      mappedRatePlans: rateMap.size,
    };
  });
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * A link that opens Channex's own channel screen for the connection's
 * property, already signed in, where staff connect an OTA and map its rooms
 * and rates. The link works once and must be opened within 15 minutes.
 */
export async function channexChannelScreenUrl(
  db: Database,
  actor: Actor,
  connectionId: string,
  options: { channels?: string[]; language?: string } = {},
): Promise<string> {
  const connection = await requireChannex(db, actor.orgId, connectionId);
  const propertyId = connection.config.externalPropertyId;
  if (!propertyId) throw validationError('Choose or create the channel manager property first');
  const client = clientFor(connection);
  const token = await upstream(() => client.oneTimeToken(propertyId, actor.label));
  const origin = client.baseUrl.replace(/\/api\/v1$/, '');
  const url = new URL(`${origin}/auth/exchange`);
  url.searchParams.set('oauth_session_key', token);
  url.searchParams.set('app_mode', 'headless');
  url.searchParams.set('redirect_to', '/channels');
  url.searchParams.set('property_id', propertyId);
  if (options.channels?.length) url.searchParams.set('channels', options.channels.join(','));
  if (options.language) url.searchParams.set('lng', options.language);
  return url.toString();
}

export interface WebhookRegistration {
  id: string;
  callbackUrl: string;
  created: boolean;
}

export interface WebhookState {
  /** Where the channel manager is expected to announce bookings. */
  callbackUrl: string;
  /** Whether a webhook pointing there exists and is switched on. Null when the channel manager could not be asked. */
  registered: boolean | null;
  /** Events the PMS relies on that the registered webhook does not send. */
  missingEvents: string[];
  error: string | null;
}

/** Whether Channex is set to announce bookings to this PMS. Read-only. */
export async function channexWebhookState(env: Env): Promise<WebhookState> {
  const callbackUrl = `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${CHANNEX_WEBHOOK_PATH}`;
  if (!env.CHANNEX_API_KEY) {
    return { callbackUrl, registered: null, missingEvents: [], error: 'No API key is set' };
  }
  try {
    const hooks = await accountClient(env).listWebhooks();
    const hook = hooks.find((w) => w.callback_url === callbackUrl);
    if (!hook || hook.is_active === false) {
      return { callbackUrl, registered: false, missingEvents: [], error: null };
    }
    const mask = (hook.event_mask ?? '').split(';').map((e) => e.trim());
    const missingEvents = mask.includes('*')
      ? []
      : CHANNEX_WEBHOOK_EVENTS.filter((e) => !mask.includes(e));
    return { callbackUrl, registered: true, missingEvents, error: null };
  } catch (err) {
    return {
      callbackUrl,
      registered: null,
      missingEvents: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Makes sure Channex has one account-wide webhook pointing at this PMS, with
 * the shared secret it must send back. Safe to run again: it updates the
 * existing webhook rather than adding another.
 */
export async function ensureChannexWebhook(env: Env): Promise<WebhookRegistration> {
  // The bundled simulator needs no secret; anything real does.
  if (!env.CHANNEX_WEBHOOK_SECRET && !env.usingChannelSimulator) {
    throw new DomainError(
      'not_configured',
      'Set CHANNEX_WEBHOOK_SECRET (a long random value) first: the channel manager sends it back with every webhook call so the PMS can tell the call is genuine.',
    );
  }
  const callbackUrl = `${env.API_PUBLIC_URL.replace(/\/+$/, '')}${CHANNEX_WEBHOOK_PATH}`;
  if (env.isProduction && !callbackUrl.startsWith('https://')) {
    throw new DomainError(
      'not_configured',
      'API_PUBLIC_URL must be an https address the channel manager can reach',
    );
  }
  const client = accountClient(env);
  const settings = {
    callback_url: callbackUrl,
    event_mask: CHANNEX_WEBHOOK_EVENTS.join(';'),
    is_global: true,
    property_id: null,
    is_active: true,
    send_data: true,
    headers: (env.CHANNEX_WEBHOOK_SECRET
      ? { 'x-channex-webhook-secret': env.CHANNEX_WEBHOOK_SECRET }
      : {}) as unknown as Record<string, never>,
  };
  return upstream(async () => {
    const existing = (await client.listWebhooks()).find((w) => w.callback_url === callbackUrl);
    if (existing) {
      await client.updateWebhook(existing.id, settings);
      return { id: existing.id, callbackUrl, created: false };
    }
    const created = await client.createWebhook(settings);
    return { id: created.id, callbackUrl, created: true };
  });
}
