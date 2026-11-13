import { outbox, type DbOrTx } from '@pms/db';
import type { DateRange } from './dates';

/** Events that tell the sync worker which values to re-send to channels. */
export type AriEvent =
  | { kind: 'ari.availability'; propertyId: string; roomTypeId: string; range: DateRange }
  | {
      kind: 'ari.restrictions';
      propertyId: string;
      ratePlanId: string;
      roomTypeId: string;
      range: DateRange;
    };

/** Events that keep open screens live and feed outbound webhooks. */
export type EntityEvent = {
  kind:
    | 'reservation.created'
    | 'reservation.updated'
    | 'reservation.cancelled'
    | 'block.created'
    | 'block.updated'
    | 'block.released'
    | 'unit.updated'
    | 'rates.updated'
    | 'alert.raised'
    | 'alert.updated'
    | 'sync.updated'
    | 'message.received'
    | 'folio.updated'
    | 'task.updated'
    | 'review.updated';
  propertyId: string | null;
  payload: Record<string, unknown>;
};

export type OutboxEvent = AriEvent | EntityEvent;

/**
 * Records events in the same transaction as the change. Because the rows
 * commit atomically with the data, a change can never be saved without its
 * channel update being queued, and a rolled-back change queues nothing.
 */
export async function emit(tx: DbOrTx, orgId: string, events: OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(outbox).values(
    events.map((e) => {
      if (e.kind === 'ari.availability') {
        return {
          kind: e.kind,
          orgId,
          propertyId: e.propertyId,
          payload: { roomTypeId: e.roomTypeId, from: e.range.from, to: e.range.to },
        };
      }
      if (e.kind === 'ari.restrictions') {
        return {
          kind: e.kind,
          orgId,
          propertyId: e.propertyId,
          payload: {
            roomTypeId: e.roomTypeId,
            ratePlanId: e.ratePlanId,
            from: e.range.from,
            to: e.range.to,
          },
        };
      }
      return { kind: e.kind, orgId, propertyId: e.propertyId, payload: e.payload };
    }),
  );
}
