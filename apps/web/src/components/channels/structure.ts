'use client';

import useSWR from 'swr';
import type { ChannelManagerStructure, Connection } from './types';

/** These answers come from the channel manager itself, which limits how often it may be asked. */
export const ASK_ONCE = { revalidateOnFocus: false };

/**
 * The rooms and rates the channel manager holds for a connection's property. Asked for only on
 * behalf of people who can change the set-up, and only once a property is linked.
 */
export function useChannelManagerStructure(connection: Connection | undefined, canManage: boolean) {
  return useSWR<ChannelManagerStructure>(
    canManage && connection?.adapter === 'channex' && connection.config.externalPropertyId
      ? `/channels/connections/${connection.id}/channex/structure`
      : null,
    ASK_ONCE,
  );
}

/** Titles of the channel manager's rooms by id, to name a room where the server gives only an id. */
export function roomNamesOf(
  structure: ChannelManagerStructure | undefined,
): ReadonlyMap<string, string> {
  return new Map(structure?.roomTypes.map((room) => [room.id, room.title]));
}
