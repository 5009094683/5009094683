import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@pms/domain';
import type { TestHotel } from '@pms/domain/testing';
import {
  day,
  guestBooks,
  liveHotel,
  reservationFor,
  startStack,
  waitFor,
  type ConnectedProperty,
  type Stack,
} from './harness';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  event: { id: string; type: string; propertyId: string | null; data: Record<string, unknown> };
}

let stack: Stack;
let hotel: TestHotel;
let live: ConnectedProperty;
let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
/** What the receiving system answers. */
let answer = 200;

beforeAll(async () => {
  stack = await startStack();
  ({ hotel, live } = await liveHotel(stack, { standardRooms: 2, deluxeRooms: 1 }));
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (answer === 200) {
        received.push({ headers: req.headers, body, event: JSON.parse(body) as Received['event'] });
      }
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/pms-events`;
});
afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await stack.stop();
});

const eventOf = (type: string, reservationId?: string) =>
  received.find(
    (r) =>
      r.event.type === type && (!reservationId || r.event.data.reservationId === reservationId),
  );

describe('telling other systems what changed', () => {
  it('sends a signed event within moments, and the receiver reads the rest with its own key', async () => {
    const created = await stack.admin.post('/outbound-webhooks', {
      url: receiverUrl,
      events: ['reservation.*'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { endpoint, secret } = created.json();
    const { key } = (
      await stack.admin.post('/api-keys', {
        name: 'Revenue tool',
        grants: [{ role: 'read_only', propertyId: hotel.property.id }],
      })
    ).json();

    // A guest books on Booking.com.
    const ota = guestBooks(stack, live, 'BDC', {
      roomTypeId: hotel.standard.roomType.id,
      ratePlanId: hotel.standard.ratePlan.id,
      checkIn: day(10),
      checkOut: day(12),
    });
    const reservation = await waitFor('the booking to arrive', () =>
      reservationFor(stack, ota.code),
    );
    const told = await waitFor('the other system to be told', () =>
      eventOf('reservation.created', reservation.id),
    );
    expect(told.event).toMatchObject({
      type: 'reservation.created',
      propertyId: hotel.property.id,
      data: { reservationId: reservation.id, code: reservation.code },
    });
    // Nothing about the guest travels in the event itself.
    expect(told.body).not.toMatch(/guest|email|phone/i);
    expect(told.headers['x-pms-event']).toBe('reservation.created');
    expect(told.headers['x-pms-delivery']).toBe(told.event.id);
    expect(
      verifyWebhookSignature(
        secret,
        {
          signature: String(told.headers['x-pms-signature']),
          timestamp: String(told.headers['x-pms-timestamp']),
        },
        told.body,
      ),
    ).toBe(true);

    // The receiver looks the booking up over the API, as itself.
    const looked = await fetch(`${stack.apiUrl}/reservations/${reservation.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(looked.status).toBe(200);
    expect(await looked.json()).toMatchObject({
      code: reservation.code,
      channelCode: 'BDC',
      channelReservationCode: ota.code,
    });

    // A cancellation is told too.
    const cancelled = await stack.admin.post(`/reservations/${reservation.id}/cancel`, {
      reason: 'Guest asked',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await waitFor('the cancellation to be told', () =>
      eventOf('reservation.cancelled', reservation.id),
    );

    // Things the endpoint did not ask for are not sent: rates, for one.
    const rates = await stack.admin.post(`/properties/${hotel.property.id}/rates`, {
      ratePlanId: hotel.standard.ratePlan.id,
      from: day(20),
      to: day(22),
      change: { rate: 500_000 },
    });
    expect(rates.statusCode, rates.body).toBe(200);
    const log = (await stack.admin.get(`/outbound-webhooks/${endpoint.id}/deliveries`)).json()
      .deliveries as { eventKind: string; status: string }[];
    expect(log.every((d) => d.eventKind.startsWith('reservation.'))).toBe(true);
    expect(log.filter((d) => d.status === 'delivered').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps an event for later when the receiver is down', async () => {
    const [endpoint] = (await stack.admin.get('/outbound-webhooks')).json().endpoints as {
      id: string;
    }[];
    answer = 503;
    const ota = guestBooks(stack, live, 'ABB', {
      roomTypeId: hotel.deluxe.roomType.id,
      ratePlanId: hotel.deluxe.ratePlan.id,
      checkIn: day(30),
      checkOut: day(31),
    });
    const reservation = await waitFor('the booking to arrive', () =>
      reservationFor(stack, ota.code),
    );
    const waiting = await waitFor('the failed attempt to be recorded', async () => {
      const { deliveries } = (
        await stack.admin.get(`/outbound-webhooks/${endpoint!.id}/deliveries?status=pending`)
      ).json() as {
        deliveries: { id: number; attempts: number; lastStatusCode: number | null }[];
      };
      // The attempt is counted when it starts; its outcome is written when the receiver has answered.
      return deliveries.find((d) => d.attempts >= 1 && d.lastStatusCode !== null);
    });
    expect(waiting.lastStatusCode).toBe(503);
    expect(eventOf('reservation.created', reservation.id)).toBeUndefined();

    // The receiver comes back; the event goes out again without anyone re-entering anything.
    answer = 200;
    const retried = await stack.admin.post(`/outbound-webhooks/deliveries/${waiting.id}/retry`);
    expect(retried.statusCode).toBe(202);
    await waitFor('the event to get through', () => eventOf('reservation.created', reservation.id));
  });
});
