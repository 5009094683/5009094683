# API keys and webhooks

Two ways for another system to work with the PMS: it **asks** (the API, with a
key), or it **is told** (a webhook, when something changes). They are meant to
be used together: a webhook says "reservation X changed", and the receiver
reads reservation X through the API.

Both are managed under **Settings, Integrations**, by organisation
administrators.

## The API

Everything the back office does, it does through this API, so anything a
person can do there a key can do too, within its role.

- **Address**: the API as you deploy it, for example
  `https://pms.example.com/api`.
- **Description**: `GET /docs` serves an interactive description of every
  route (OpenAPI) when `API_DOCS=true`; it is on by default outside production.
- **Format**: JSON in and out. Money is in minor units (paise): `450000` is
  ₹4,500.00. Dates are `YYYY-MM-DD`; a stay's `checkOut` is the day of departure.

### Keys

A key is created with a name and one or more roles, each for one property or
for all:

| Role            | A key with it can                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Read only       | Read reservations, rates, guests, bills, messages and reports                                                                              |
| Front desk      | Read, and: make and change reservations and blocks, check guests in and out, post charges and payments, update housekeeping, answer guests |
| Revenue manager | Read, and: change rates and restrictions, make and change reservations and blocks, manage channel connections, approve rate suggestions    |
| Accountant      | Read, and: post charges, payments and refunds, issue invoices, manage tax rules, companies and owners, run the night audit                 |
| Housekeeping    | The housekeeping board and its tasks                                                                                                       |
| Maintenance     | Maintenance issues                                                                                                                         |
| General manager | Everything above, for its properties                                                                                                       |

No key can manage users, sign-in, keys or webhooks: that stays with people.

The key is shown **once**, when it is created; only a fingerprint of it is
stored. Send it with every request:

```bash
curl https://pms.example.com/api/reservations?from=2026-12-01&to=2026-12-08 \
  -H "Authorization: Bearer pms_..."
```

- A key can be given an expiry date, and can be revoked at any time; it then
  stops working at once.
- Each key may make `API_KEY_RATE_LIMIT_PER_MINUTE` requests a minute (600).
  Beyond that the answer is `429` with a `Retry-After` header.
- Everything a key changes is in the audit trail under the key's name.

### Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "no_availability",
    "message": "No availability on 2026-12-12",
    "requestId": "req-1a2b"
  }
}
```

| Status   | Codes                                                                                                    | Meaning                                                           |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 400      | `validation`                                                                                             | The request is malformed or breaks a rule; the message says which |
| 401      | `unauthenticated`                                                                                        | No key, or one that is unknown, revoked or expired                |
| 403      | `forbidden`                                                                                              | The key's role does not allow this, or not for this property      |
| 404      | `not_found`                                                                                              | No such thing, or it belongs to another organisation              |
| 409      | `no_availability`, `unit_occupied`, `restriction_violated`, `stale_version`, `invalid_state`, `conflict` | The request is well formed but cannot be done as things stand     |
| 429      | `rate_limited`                                                                                           | Too many requests; wait as long as `Retry-After` says             |
| 502, 503 | `upstream_failed`, `not_configured`                                                                      | Something this depends on failed, or is not set up                |

`message` is written to be shown to a person. `code` is for programs.

### Common tasks

```bash
# What is free, and at what price
GET  /properties/{propertyId}/availability?from=2026-12-12&to=2026-12-15
GET  /properties/{propertyId}/rates?from=2026-12-12&to=2026-12-15

# Make, change and cancel a reservation
POST /reservations            { propertyId, source, guest: {...}, rooms: [{ roomTypeId, ratePlanId, checkIn, checkOut, adults }] }
PATCH /reservations/{id}      { ... }
POST /reservations/{id}/cancel { reason }

# Close dates on a room
POST /blocks                  { propertyId, unitId, kind: "maintenance", startDate, endDate, reason }

# Change rates and restrictions (they go to the booking sites like any change)
POST /properties/{propertyId}/rates   { ratePlanId, from, to, change: { rate, minStayArrival, stopSell } }

# Figures
GET  /reports/performance?from=2026-11-01&to=2026-12-01&groupBy=day
GET  /reports/channel-mix?from=2026-11-01&to=2026-12-01&format=csv

# For the authorities
GET  /reports/tax-register?from=2026-11-01&to=2026-12-01&format=csv
GET  /properties/{propertyId}/guest-register?from=2026-11-01&to=2026-12-01&foreignOnly=true&format=csv
```

A booking made through the API is checked exactly like one made at the front
desk: the same availability rules, the same database guarantees. If the room
has just been sold, the answer is `409 no_availability`, never a double booking.

## Webhooks

An endpoint is an HTTPS address of yours and a list of events. When one of
those events happens, the PMS sends a `POST` there within a few seconds.

### Events

| Event                                              | When                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `reservation.created`                              | A reservation is made, by anyone: staff, the website, a booking site |
| `reservation.updated`                              | Its dates, rooms, guest or status change; a guest checks in or out   |
| `reservation.cancelled`                            | It is cancelled                                                      |
| `block.created`, `block.updated`, `block.released` | Dates are closed, changed or reopened                                |
| `rates.updated`                                    | Rates or restrictions change for a rate plan and date range          |
| `message.received`                                 | A guest writes (not when staff read or reply)                        |
| `folio.updated`                                    | A charge, payment or refund is posted to a bill                      |
| `alert.raised`                                     | The system raises an alert (overbooking, sync failure, ...)          |

Subscribe to exact names, to a family (`reservation.*`), or to everything
(`*`). An endpoint can be limited to some properties.

### What arrives

```http
POST /your/endpoint
Content-Type: application/json
X-PMS-Event: reservation.created
X-PMS-Delivery: 5f0c2c1e-7a8e-4f0b-9c64-0d2f1c9b7e11
X-PMS-Timestamp: 1794600000
X-PMS-Signature: v1=4f2a...c9

{
  "id": "5f0c2c1e-7a8e-4f0b-9c64-0d2f1c9b7e11",
  "type": "reservation.created",
  "createdAt": "2026-11-13T19:20:00.123Z",
  "propertyId": "0b6f...",
  "data": { "reservationId": "9d1e...", "code": "K7M2QX4P", "from": "2026-12-12", "to": "2026-12-15" }
}
```

The body says **what changed and how to look it up**. It never carries a
guest's name, contact details or payment details. Read the current state with
your API key (`GET /reservations/{reservationId}`); that is also what makes
late or repeated deliveries harmless.

### Check the signature

Each endpoint has a secret (`whsec_...`), shown once when the endpoint is
created and again only when you replace it. The signature is the HMAC-SHA256
of `<timestamp>.<body>` with that secret, in hex, after `v1=`. Check it, and
refuse a timestamp more than five minutes old so that a captured request
cannot be replayed later. Use the body exactly as it arrived, before parsing.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromPms(secret, headers, rawBody) {
  const timestamp = Number(headers['x-pms-timestamp']);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected =
    'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const given = String(headers['x-pms-signature'] ?? '');
  return (
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}
```

### Answering, and what happens when you do not

- Answer with any `2xx` within ten seconds. Do the work afterwards; a slow
  answer counts as a failure.
- Redirects are not followed.
- A delivery that fails is sent again after 30 seconds, then 2, 10 and 30
  minutes, then 2, 6 and 12 hours: eight attempts over about a day. Every
  attempt carries the same `id`, so remember the ids you have handled and
  ignore repeats.
- Deliveries can arrive out of order when one of them was retried. Treat each
  as "look this up again", not as a step in a sequence.
- After thirty failures in a row with nothing getting through, the endpoint is
  switched off and an alert is raised. Nothing more is sent, and what was
  waiting is dropped, until someone switches it back on. Then use the API to
  catch up on what was missed.
- Settings, Integrations shows the last deliveries to each endpoint with the
  answer received, lets you send a `ping` to try an endpoint, and lets you
  send a failed delivery again.

In production an endpoint must be an `https://` address on the public
internet. Addresses on private networks are refused when saved and again
every time something is sent, so a webhook cannot be used to reach your
internal services.
