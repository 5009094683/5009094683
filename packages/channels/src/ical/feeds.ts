import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '@pms/config';
import { channelConnections, properties, units, type Database } from '@pms/db';
import {
  atomicUnitsOf,
  decryptJson,
  emit,
  encryptJson,
  todayIn,
  transact,
  uuidArray,
  validationError,
  writeAudit,
  type Actor,
} from '@pms/domain';
import { requireConnection, type ConnectionRow } from '../engine/connections';
import { feedsOf, type IcalFeedConfig, type IcalState } from './adapter';
import { formatCalendar, type OutgoingEvent } from './calendar';

export interface IcalFeedInput {
  /** Omit for a new calendar. */
  id?: string;
  unitId: string;
  importUrl?: string | null;
  label: string;
  channelCode?: string | null;
  treatAs?: IcalFeedConfig['treatAs'];
}

export interface IcalFeedView extends IcalFeedConfig {
  unitName: string;
  /** The address to give the channel so it reads the PMS's calendar for this unit. */
  exportUrl: string;
  /** When the channel's calendar was last read successfully. */
  lastReadAt: string | null;
  /** Why the last read failed, if it did. */
  error: string | null;
  /** Upcoming entries currently in the channel's calendar. */
  entries: number;
}

const KNOWN_CHANNELS: Record<string, string> = {
  airbnb: 'ABB',
  'booking.com': 'BDC',
  booking: 'BDC',
  vrbo: 'VRB',
  homeaway: 'VRB',
  expedia: 'EXP',
  agoda: 'AGO',
  makemytrip: 'MMT',
  tripadvisor: 'TRA',
  'trip.com': 'CTP',
};

function secretsOf(connection: ConnectionRow): Record<string, string> {
  return connection.secretsEnc ? decryptJson<Record<string, string>>(connection.secretsEnc) : {};
}

function tokenFor(secret: string, feedId: string): string {
  return createHmac('sha256', secret).update(`ical:${feedId}`).digest('base64url').slice(0, 32);
}

export function icalExportUrl(
  env: Pick<Env, 'API_PUBLIC_URL'>,
  feedId: string,
  secret: string,
): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/ical/${feedId}/${tokenFor(secret, feedId)}.ics`;
}

async function requireIcal(
  db: Database,
  orgId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const connection = await requireConnection(db, orgId, connectionId);
  if (connection.adapter !== 'ical') throw validationError('This is not a calendar connection');
  return connection;
}

/** The calendars of a connection, with the address to give each channel and how the last read went. */
export async function listIcalFeeds(
  db: Database,
  orgId: string,
  connectionId: string,
  env: Pick<Env, 'API_PUBLIC_URL'>,
): Promise<IcalFeedView[]> {
  const connection = await requireIcal(db, orgId, connectionId);
  const feeds = feedsOf(connection.config);
  if (feeds.length === 0) return [];
  const secret = secretsOf(connection).exportSecret ?? '';
  const state = (connection.state as IcalState).feeds ?? {};
  const names = await db
    .select({ id: units.id, name: units.name })
    .from(units)
    .where(
      inArray(
        units.id,
        feeds.map((f) => f.unitId),
      ),
    );
  return feeds.map((feed) => ({
    ...feed,
    unitName: names.find((u) => u.id === feed.unitId)?.name ?? 'Unit',
    exportUrl: icalExportUrl(env, feed.id, secret),
    lastReadAt: state[feed.id]?.fetchedAt ?? null,
    error: state[feed.id]?.error ?? null,
    entries: Object.keys(state[feed.id]?.events ?? {}).length,
  }));
}

/**
 * Replaces the calendars of a connection. A calendar that keeps its id keeps
 * what has been read from it; a removed one stops being read, and what it
 * brought in stays in the PMS for staff to deal with.
 */
export async function saveIcalFeeds(
  db: Database,
  actor: Actor,
  connectionId: string,
  inputs: IcalFeedInput[],
  env: Pick<Env, 'API_PUBLIC_URL' | 'isProduction'>,
): Promise<IcalFeedView[]> {
  if (inputs.length > 200) throw validationError('A connection may have at most 200 calendars');
  await transact(db, async (tx) => {
    const [connection] = await tx
      .select()
      .from(channelConnections)
      .where(
        and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, actor.orgId)),
      )
      .for('update');
    if (!connection || connection.adapter !== 'ical') {
      throw validationError('This is not a calendar connection');
    }
    const [property] = await tx
      .select()
      .from(properties)
      .where(eq(properties.id, connection.propertyId));
    const unitRows =
      inputs.length > 0
        ? await tx
            .select()
            .from(units)
            .where(
              and(
                eq(units.propertyId, connection.propertyId),
                inArray(
                  units.id,
                  inputs.map((f) => f.unitId),
                ),
              ),
            )
        : [];
    const known = new Set(feedsOf(connection.config).map((f) => f.id));
    const feeds: IcalFeedConfig[] = inputs.map((input) => {
      const unit = unitRows.find((u) => u.id === input.unitId);
      if (!unit)
        throw validationError('A calendar is for a unit that is not part of this property');
      const label = input.label.trim();
      if (!label) throw validationError('Each calendar needs the name of its channel');
      const importUrl = input.importUrl?.trim() || null;
      if (importUrl) {
        let url: URL;
        try {
          url = new URL(importUrl);
        } catch {
          throw validationError(`"${importUrl}" is not a web address`);
        }
        if (url.protocol !== 'https:' && (env.isProduction || url.protocol !== 'http:')) {
          throw validationError('Calendar addresses must start with https://');
        }
        if (url.username || url.password) {
          throw validationError('Calendar addresses with a user name or password are not accepted');
        }
      }
      return {
        // An id from the client is honoured only if it is one of this connection's own.
        id: input.id && known.has(input.id) ? input.id : randomUUID(),
        unitId: unit.id,
        roomTypeId: unit.roomTypeId,
        importUrl,
        label,
        channelCode:
          input.channelCode?.trim().toUpperCase() ||
          KNOWN_CHANNELS[label.toLowerCase().replace(/\s+/g, '')] ||
          null,
        treatAs: input.treatAs ?? 'auto',
      };
    });
    const addresses = feeds.map((f) => f.importUrl).filter((u): u is string => u !== null);
    if (new Set(addresses).size !== addresses.length) {
      throw validationError('The same calendar address is listed twice');
    }

    const secrets = secretsOf(connection);
    // Created once and kept: the addresses given to channels must stay valid.
    secrets.exportSecret ??= randomBytes(32).toString('hex');
    await tx
      .update(channelConnections)
      .set({
        config: { ...connection.config, feeds, timezone: property!.timezone },
        secretsEnc: encryptJson(secrets),
      })
      .where(eq(channelConnections.id, connectionId));
    await writeAudit(tx, actor, {
      action: 'channel.calendars_saved',
      entityType: 'channel_connection',
      entityId: connectionId,
      propertyId: connection.propertyId,
      summary: `Saved ${feeds.length} calendar(s) for ${connection.name}`,
      changes: { calendars: feeds.map((f) => ({ label: f.label, unitId: f.unitId })) },
    });
    await emit(tx, actor.orgId, [
      { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
    ]);
  });
  return listIcalFeeds(db, actor.orgId, connectionId, env);
}

export interface ExportedCalendar {
  body: string;
  /** Changes when the calendar's content does, for conditional requests. */
  etag: string;
}

/**
 * The calendar a channel subscribes to for one listing: every night the unit
 * is taken, by a reservation or a block, from any source except the channel's
 * own calendar (it already knows about those). No guest details are included:
 * the address is unguessable but not otherwise protected.
 *
 * Returns null when the address is not valid, so a wrong token and an unknown
 * calendar look the same from outside.
 */
export async function exportCalendar(
  db: Database,
  feedId: string,
  token: string,
  now: Date = new Date(),
): Promise<ExportedCalendar | null> {
  if (!/^[0-9a-f-]{36}$/i.test(feedId)) return null;
  const [connection] = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.adapter, 'ical'),
        sql`${channelConnections.config}->'feeds' @> ${JSON.stringify([{ id: feedId }])}::jsonb`,
      ),
    );
  if (!connection || connection.status === 'disabled') return null;
  const secret = secretsOf(connection).exportSecret;
  if (!secret) return null;
  const expected = Buffer.from(tokenFor(secret, feedId));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const feed = feedsOf(connection.config).find((f) => f.id === feedId)!;
  const [property] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, connection.propertyId));
  const [unit] = await db.select().from(units).where(eq(units.id, feed.unitId));
  if (!property || !unit) return null;

  const atomic = await atomicUnitsOf(db, unit.id);
  const today = todayIn(property.timezone, now);
  const own = `${feedId}:%`;
  const { rows } = await db.execute<{
    ref: string;
    start: string;
    end: string;
    is_block: boolean;
    modified: string;
  }>(sql`
    SELECT coalesce(o.reservation_room_id, o.block_id)::text AS ref,
           min(lower(o.stay))::text AS start, max(upper(o.stay))::text AS "end",
           o.block_id IS NOT NULL AS is_block,
           max(coalesce(rr.updated_at, b.updated_at))::text AS modified
    FROM unit_occupancy o
    LEFT JOIN reservation_rooms rr ON rr.id = o.reservation_room_id
    LEFT JOIN reservations r ON r.id = rr.reservation_id
    LEFT JOIN inventory_blocks b ON b.id = o.block_id
    WHERE o.unit_id = ANY(${uuidArray(atomic)})
      AND upper(o.stay) > ${today}::date
      AND NOT (r.connection_id IS NOT DISTINCT FROM ${connection.id}
               AND coalesce(r.external_id, '') LIKE ${own})
      AND NOT (b.connection_id IS NOT DISTINCT FROM ${connection.id}
               AND coalesce(b.external_ref, '') LIKE ${own})
    GROUP BY 1, o.block_id
    ORDER BY 2, 1
  `);
  const events: OutgoingEvent[] = rows.map((row) => ({
    uid: `${row.ref}@pms`,
    start: row.start,
    end: row.end,
    summary: row.is_block ? 'Not available' : 'Reserved',
    modifiedAt: new Date(row.modified),
  }));
  const etag = `"${createHmac('sha256', 'etag')
    .update(JSON.stringify(rows))
    .digest('base64url')
    .slice(0, 22)}"`;
  return { body: formatCalendar(`${property.name} - ${unit.name}`, events, now), etag };
}
