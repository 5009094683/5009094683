import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getEnv } from '@pms/config';
import {
  channelConnections,
  channelRateMappings,
  channelRoomMappings,
  properties,
  ratePlans,
  roomTypes,
  syncLog,
  type ChannelAdapterKind,
  type ConnectionConfig,
  type ConnectionStatus,
  type DbOrTx,
} from '@pms/db';
import {
  conflict,
  decryptJson,
  emit,
  encryptJson,
  notFound,
  parsePgTimestamp,
  requireProperty,
  resolveAlert,
  transact,
  validationError,
  writeAudit,
  type Actor,
} from '@pms/domain';
import { createAdapter, type AdapterContext, type ChannelAdapter } from '../adapter';

export type ConnectionRow = typeof channelConnections.$inferSelect;

export const ADAPTER_LABELS: Record<ChannelAdapterKind, string> = {
  channex: 'Channel manager',
  ical: 'Calendar feeds',
  email: 'Reservations mailbox',
};

export function adapterContext(connection: ConnectionRow): AdapterContext {
  return {
    connectionId: connection.id,
    orgId: connection.orgId,
    propertyId: connection.propertyId,
    config: connection.config,
    secrets: connection.secretsEnc
      ? decryptJson<Record<string, string>>(connection.secretsEnc)
      : {},
    state: structuredClone(connection.state),
    env: getEnv(),
  };
}

export function adapterFor(connection: ConnectionRow): ChannelAdapter {
  return createAdapter(connection.adapter, adapterContext(connection));
}

export async function requireConnection(
  db: DbOrTx,
  orgId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, orgId)));
  if (!row) throw notFound('Connection', connectionId);
  return row;
}

export interface CreateConnectionInput {
  propertyId: string;
  adapter: ChannelAdapterKind;
  name?: string;
  config?: ConnectionConfig;
  secrets?: Record<string, string>;
}

export async function createConnection(
  db: DbOrTx,
  actor: Actor,
  input: CreateConnectionInput,
): Promise<ConnectionRow> {
  return transact(db, async (tx) => {
    const property = await requireProperty(tx, actor.orgId, input.propertyId);
    const [existing] = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.propertyId, property.id),
          eq(channelConnections.adapter, input.adapter),
        ),
      );
    if (existing)
      throw conflict(
        `${property.name} already has a ${ADAPTER_LABELS[input.adapter].toLowerCase()} connection`,
      );
    const [row] = await tx
      .insert(channelConnections)
      .values({
        orgId: actor.orgId,
        propertyId: property.id,
        adapter: input.adapter,
        name: input.name?.trim() || ADAPTER_LABELS[input.adapter],
        // Calendar feeds and the mailbox have nothing to map, so they start working at once.
        status: input.adapter === 'channex' ? 'pending' : 'active',
        config: input.config ?? {},
        secretsEnc:
          input.secrets && Object.keys(input.secrets).length > 0
            ? encryptJson(input.secrets)
            : null,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'channel.connection_created',
      entityType: 'channel_connection',
      entityId: row!.id,
      propertyId: property.id,
      summary: `Added ${ADAPTER_LABELS[input.adapter].toLowerCase()} connection for ${property.name}`,
    });
    await emit(tx, actor.orgId, [
      { kind: 'sync.updated', propertyId: property.id, payload: { connectionId: row!.id } },
    ]);
    return row!;
  });
}

export interface UpdateConnectionInput {
  name?: string;
  /** `active` starts or resumes syncing; `paused` stops it and keeps the setup. */
  status?: Extract<ConnectionStatus, 'active' | 'paused' | 'disabled'>;
  config?: ConnectionConfig;
  secrets?: Record<string, string>;
}

export async function updateConnection(
  db: DbOrTx,
  actor: Actor,
  connectionId: string,
  input: UpdateConnectionInput,
): Promise<ConnectionRow> {
  return transact(db, async (tx) => {
    const [before] = await tx
      .select()
      .from(channelConnections)
      .where(
        and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, actor.orgId)),
      )
      .for('update');
    if (!before) throw notFound('Connection', connectionId);

    const set: Partial<typeof channelConnections.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name.trim() || before.name;
    if (input.config !== undefined) set.config = { ...before.config, ...input.config };
    if (input.secrets !== undefined) {
      const merged = {
        ...(before.secretsEnc ? decryptJson<Record<string, string>>(before.secretsEnc) : {}),
        ...input.secrets,
      };
      set.secretsEnc = Object.keys(merged).length > 0 ? encryptJson(merged) : null;
    }
    if (input.status !== undefined && input.status !== before.status) {
      if (input.status === 'active') {
        const adapter = adapterFor({ ...before, ...set } as ConnectionRow);
        if (adapter.capabilities.ari) {
          const [mapped] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(channelRoomMappings)
            .where(eq(channelRoomMappings.connectionId, connectionId));
          if ((mapped?.n ?? 0) === 0) {
            throw validationError('Map at least one room type before turning this connection on');
          }
        }
        // Whatever changed while the connection was off was not queued, so
        // (re)starting always restates the whole horizon.
        set.fullSyncRequestedAt = new Date();
        set.consecutiveFailures = 0;
        set.nextAttemptAt = null;
        set.lastError = null;
        await tx.execute(sql`DELETE FROM sync_queue WHERE connection_id = ${connectionId}`);
        await resolveAlert(tx, actor.orgId, `sync_failure:${connectionId}`);
      }
      set.status = input.status;
    }
    if (Object.keys(set).length === 0) return before;
    const [after] = await tx
      .update(channelConnections)
      .set(set)
      .where(eq(channelConnections.id, connectionId))
      .returning();
    await writeAudit(tx, actor, {
      action: 'channel.connection_updated',
      entityType: 'channel_connection',
      entityId: connectionId,
      propertyId: before.propertyId,
      summary:
        input.status && input.status !== before.status
          ? `Set ${before.name} to ${input.status}`
          : `Updated connection ${before.name}`,
      changes: {
        status: input.status,
        name: input.name,
        secretsChanged: input.secrets !== undefined,
      },
    });
    await emit(tx, actor.orgId, [
      { kind: 'sync.updated', propertyId: before.propertyId, payload: { connectionId } },
    ]);
    return after!;
  });
}

/** Asks for the whole horizon to be re-sent on the next dispatch. */
export async function requestFullSync(
  db: DbOrTx,
  actor: Actor,
  connectionId: string,
): Promise<void> {
  const connection = await requireConnection(db, actor.orgId, connectionId);
  await db
    .update(channelConnections)
    .set({ fullSyncRequestedAt: new Date(), nextAttemptAt: null })
    .where(eq(channelConnections.id, connectionId));
  await writeAudit(db, actor, {
    action: 'channel.full_sync_requested',
    entityType: 'channel_connection',
    entityId: connectionId,
    propertyId: connection.propertyId,
    summary: `Requested a full sync for ${connection.name}`,
  });
  // Wakes the worker; the event carries nothing to route.
  await emit(db, actor.orgId, [
    { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
  ]);
}

export interface MappingInput {
  roomTypes?: { roomTypeId: string; externalId: string; externalName?: string | null }[];
  ratePlans?: { ratePlanId: string; externalId: string; externalName?: string | null }[];
}

/**
 * Replaces the connection's mappings with the given ones. A changed mapping
 * means the channel may hold values for the wrong room, so a full sync follows.
 */
export async function saveMappings(
  db: DbOrTx,
  actor: Actor,
  connectionId: string,
  input: MappingInput,
): Promise<void> {
  await transact(db, async (tx) => {
    const connection = await requireConnection(tx, actor.orgId, connectionId);
    if (input.roomTypes) {
      const ids = input.roomTypes.map((m) => m.roomTypeId);
      if (new Set(ids).size !== ids.length)
        throw validationError('A room type can be mapped only once');
      // A mailbox knows rooms by the words the channel uses, compared without case or spacing.
      const clean = (id: string): string =>
        connection.adapter === 'email' ? id.toLowerCase().replace(/\s+/g, ' ').trim() : id.trim();
      const externals = input.roomTypes.map((m) => clean(m.externalId));
      if (externals.some((e) => !e))
        throw validationError('Every mapped room type needs the channel\u2019s room id');
      if (new Set(externals).size !== externals.length) {
        throw validationError('Two room types cannot be mapped to the same channel room');
      }
      if (ids.length > 0) {
        const valid = await tx
          .select({ id: roomTypes.id })
          .from(roomTypes)
          .where(and(inArray(roomTypes.id, ids), eq(roomTypes.propertyId, connection.propertyId)));
        if (valid.length !== ids.length)
          throw validationError('A mapped room type does not belong to this property');
      }
      await tx
        .delete(channelRoomMappings)
        .where(eq(channelRoomMappings.connectionId, connectionId));
      if (input.roomTypes.length > 0) {
        await tx.insert(channelRoomMappings).values(
          input.roomTypes.map((m) => ({
            connectionId,
            roomTypeId: m.roomTypeId,
            externalRoomTypeId: clean(m.externalId),
            externalName: m.externalName ?? null,
          })),
        );
      }
    }
    if (input.ratePlans) {
      const ids = input.ratePlans.map((m) => m.ratePlanId);
      if (new Set(ids).size !== ids.length)
        throw validationError('A rate plan can be mapped only once');
      const externals = input.ratePlans.map((m) => m.externalId.trim());
      if (externals.some((e) => !e))
        throw validationError('Every mapped rate plan needs the channel\u2019s rate id');
      if (new Set(externals).size !== externals.length) {
        throw validationError('Two rate plans cannot be mapped to the same channel rate');
      }
      if (ids.length > 0) {
        const valid = await tx
          .select({ id: ratePlans.id })
          .from(ratePlans)
          .where(and(inArray(ratePlans.id, ids), eq(ratePlans.propertyId, connection.propertyId)));
        if (valid.length !== ids.length)
          throw validationError('A mapped rate plan does not belong to this property');
      }
      await tx
        .delete(channelRateMappings)
        .where(eq(channelRateMappings.connectionId, connectionId));
      if (input.ratePlans.length > 0) {
        await tx.insert(channelRateMappings).values(
          input.ratePlans.map((m) => ({
            connectionId,
            ratePlanId: m.ratePlanId,
            externalRatePlanId: m.externalId.trim(),
            externalName: m.externalName ?? null,
          })),
        );
      }
    }
    if (connection.status === 'active' || connection.status === 'error') {
      await tx
        .update(channelConnections)
        .set({ fullSyncRequestedAt: new Date(), nextAttemptAt: null })
        .where(eq(channelConnections.id, connectionId));
    }
    await writeAudit(tx, actor, {
      action: 'channel.mappings_saved',
      entityType: 'channel_connection',
      entityId: connectionId,
      propertyId: connection.propertyId,
      summary: `Saved channel mappings for ${connection.name}`,
      changes: { roomTypes: input.roomTypes?.length, ratePlans: input.ratePlans?.length },
    });
    await emit(tx, actor.orgId, [
      { kind: 'sync.updated', propertyId: connection.propertyId, payload: { connectionId } },
    ]);
  });
}

export async function getMappings(db: DbOrTx, connectionId: string) {
  // One after the other: inside a transaction both run on one connection, which takes one query at a time.
  const rooms = await db
    .select()
    .from(channelRoomMappings)
    .where(eq(channelRoomMappings.connectionId, connectionId));
  const rates = await db
    .select()
    .from(channelRateMappings)
    .where(eq(channelRateMappings.connectionId, connectionId));
  return {
    roomTypes: rooms.map((m) => ({
      roomTypeId: m.roomTypeId,
      externalId: m.externalRoomTypeId,
      externalName: m.externalName,
    })),
    ratePlans: rates.map((m) => ({
      ratePlanId: m.ratePlanId,
      externalId: m.externalRatePlanId,
      externalName: m.externalName,
    })),
  };
}

export interface ConnectionSummary {
  id: string;
  propertyId: string;
  propertyName: string;
  adapter: ChannelAdapterKind;
  name: string;
  status: ConnectionStatus;
  config: ConnectionConfig;
  capabilities: ChannelAdapter['capabilities'];
  /** Date ranges changed in the PMS and not yet accepted by the channel. */
  pendingChanges: number;
  /** When the oldest of those changes was made; the gap to now is the sync lag. */
  oldestPendingAt: Date | null;
  mappedRoomTypes: number;
  mappedRatePlans: number;
  lastPushAt: Date | null;
  lastPullAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
  fullSyncRequestedAt: Date | null;
  lastFullSyncAt: Date | null;
  lastDriftCheckAt: Date | null;
  lastDriftCount: number | null;
}

export async function listConnections(
  db: DbOrTx,
  orgId: string,
  propertyIds: string[] | 'all',
  connectionId?: string,
): Promise<ConnectionSummary[]> {
  if (propertyIds !== 'all' && propertyIds.length === 0) return [];
  // The summary is put together from several tables. Read at one instant, it cannot
  // show a state that never existed (a push noted as failed beside an empty work list).
  if (typeof (db as { rollback?: unknown }).rollback !== 'function') {
    return db.transaction((tx) => listConnections(tx, orgId, propertyIds, connectionId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  const rows = await db
    .select({ connection: channelConnections, propertyName: properties.name })
    .from(channelConnections)
    .innerJoin(properties, eq(properties.id, channelConnections.propertyId))
    .where(
      and(
        eq(channelConnections.orgId, orgId),
        propertyIds === 'all' ? undefined : inArray(channelConnections.propertyId, propertyIds),
        connectionId ? eq(channelConnections.id, connectionId) : undefined,
      ),
    )
    .orderBy(asc(properties.name), asc(channelConnections.adapter));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.connection.id);
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  // One after the other: they share the snapshot's single connection, which takes one query at a time.
  const { rows: queue } = await db.execute<{
    connection_id: string;
    n: number;
    oldest: string | null;
  }>(
    sql`SELECT connection_id, count(*)::int AS n, min(changed_at)::text AS oldest FROM sync_queue WHERE connection_id IN (${idList}) GROUP BY 1`,
  );
  // Changes committed but not yet handed to any connection's work list (the worker does that within moments).
  const { rows: unrouted } = await db.execute<{
    property_id: string;
    n: number;
    oldest: string | null;
  }>(
    sql`SELECT property_id, count(*)::int AS n, min(created_at)::text AS oldest FROM outbox
          WHERE org_id = ${orgId} AND kind IN ('ari.availability', 'ari.restrictions') GROUP BY 1`,
  );
  const { rows: rooms } = await db.execute<{ connection_id: string; n: number }>(
    sql`SELECT connection_id, count(*)::int AS n FROM channel_room_mappings WHERE connection_id IN (${idList}) GROUP BY 1`,
  );
  const { rows: rates } = await db.execute<{ connection_id: string; n: number }>(
    sql`SELECT connection_id, count(*)::int AS n FROM channel_rate_mappings WHERE connection_id IN (${idList}) GROUP BY 1`,
  );
  return rows.map(({ connection: c, propertyName }) => {
    const capabilities = adapterFor(c).capabilities;
    const listening = capabilities.ari && (c.status === 'active' || c.status === 'error');
    const queued = queue.find((q) => q.connection_id === c.id);
    const waiting = listening ? unrouted.find((u) => u.property_id === c.propertyId) : undefined;
    const oldest = [queued?.oldest, waiting?.oldest]
      .map((v) => parsePgTimestamp(v ?? null))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      id: c.id,
      propertyId: c.propertyId,
      propertyName,
      adapter: c.adapter,
      name: c.name,
      status: c.status,
      config: c.config,
      capabilities,
      pendingChanges: (queued?.n ?? 0) + (waiting?.n ?? 0),
      oldestPendingAt: oldest ?? null,
      mappedRoomTypes: rooms.find((r) => r.connection_id === c.id)?.n ?? 0,
      mappedRatePlans: rates.find((r) => r.connection_id === c.id)?.n ?? 0,
      lastPushAt: c.lastPushAt,
      lastPullAt: c.lastPullAt,
      lastSuccessAt: c.lastSuccessAt,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt,
      consecutiveFailures: c.consecutiveFailures,
      nextAttemptAt: c.nextAttemptAt,
      fullSyncRequestedAt: c.fullSyncRequestedAt,
      lastFullSyncAt: c.lastFullSyncAt,
      lastDriftCheckAt: c.lastDriftCheckAt,
      lastDriftCount: c.lastDriftCount,
    };
  });
}

/** One connection as the monitor shows it. Never includes its secrets. */
export async function getConnectionSummary(
  db: DbOrTx,
  orgId: string,
  connectionId: string,
): Promise<ConnectionSummary> {
  const [summary] = await listConnections(db, orgId, 'all', connectionId);
  if (!summary) throw notFound('Connection', connectionId);
  return summary;
}

export async function connectionLog(db: DbOrTx, connectionId: string, limit = 100) {
  return db
    .select()
    .from(syncLog)
    .where(eq(syncLog.connectionId, connectionId))
    .orderBy(desc(syncLog.id))
    .limit(Math.min(limit, 500));
}

export interface SyncLogEntry {
  connectionId: string;
  propertyId: string;
  direction: 'out' | 'in';
  operation: string;
  status: 'ok' | 'error' | 'retry';
  itemCount?: number;
  durationMs?: number;
  lagMs?: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export async function writeSyncLog(db: DbOrTx, entry: SyncLogEntry): Promise<void> {
  await db.insert(syncLog).values({
    connectionId: entry.connectionId,
    propertyId: entry.propertyId,
    direction: entry.direction,
    operation: entry.operation,
    status: entry.status,
    itemCount: entry.itemCount ?? 0,
    durationMs: entry.durationMs ?? null,
    lagMs: entry.lagMs ?? null,
    error: entry.error?.slice(0, 2000) ?? null,
    detail: entry.detail ?? null,
  });
}
