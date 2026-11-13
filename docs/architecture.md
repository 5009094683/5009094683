# Architecture

## The parts

```
 guests ──▶ booking site (Next.js) ──┐
 staff  ──▶ back office  (Next.js) ──┼──▶ API (Fastify) ──▶ PostgreSQL ◀── worker
 other systems ── API keys ──────────┘         ▲                             │
                                               │ webhooks, feeds, mail       │ pushes, polls
                                               └──── channel manager, calendar feeds, mailbox,
                                                     payment gateway, WhatsApp, AI service
```

- **PostgreSQL** holds everything and is also the message bus: work to be done
  is rows in tables, and `LISTEN/NOTIFY` wakes whoever has to do it. There is
  no separate queue or cache to run.
- **The API** answers the back office, the booking site and other systems. It
  does not talk to the booking sites itself.
- **The worker** does everything that happens without a person asking: sending
  changes to the booking sites, fetching bookings, the night audit, messages,
  reports, retention. Any number of workers can run side by side; every piece
  of work is taken under a lock or a unique key, so they share it rather than
  repeat it.
- **The two web apps** are thin: they render what the API returns. The back
  office proxies `/api` to the API so the session cookie stays on one origin;
  the booking site proxies only the API's `/public` routes, so it can never
  carry a staff session.

Code is laid out the same way: `packages/domain` holds the rules and knows
nothing about HTTP; `apps/api` checks who is asking and calls it;
`packages/channels` is the sync engine and the routes to the booking sites.

## Why two bookings cannot have the same room

Two things are guaranteed by the database itself, not by application code
remembering to check:

1. **A room is never in two places on one night.** Every stay in a named room,
   and every block on one, is a row in `unit_occupancy` with a date range. An
   exclusion constraint refuses a second row for the same room whose range
   overlaps. A villa and its bedrooms are linked: occupying either side writes
   rows for the rooms it shares.
2. **A room type is never sold beyond the rooms it has.** `inventory_days`
   holds, for each room type and night, the rooms that exist and those sold,
   blocked, out of order, and taken by the other side of a linked villa. A
   check constraint keeps the sum within the total.

Changes that touch the same nights also take an advisory lock on the room type
first, so two requests wait for each other instead of one of them failing. The
tests book the last room from many connections at once and from the website
and a booking site at the same moment; exactly one wins every time.

Rooms held for a group are counted as blocked, less the rooms the group has
booked on that night. The count is derived, not adjusted by hand: a booking
made for the group takes one room out of the hold and into "sold" in the same
rebuild, so what everyone else can book does not move and nothing is sent to
the booking sites; cancelling it puts the room back in the hold. Once the
cut-off day is over the hold is released and whatever was not booked is on sale
again.

There is one deliberate exception. A booking a site has already confirmed to
a guest is recorded even when nothing is free (two sites can sell the last room
within the same second, before either hears of the other). It is recorded as
**overbooked**, counted separately, and raises an urgent alert, because
refusing it would only hide a guest who is going to arrive.

## How a change reaches the booking sites

```
 change committed ─▶ outbox row (same transaction)
                      │  NOTIFY
                      ▼
            worker: router ─▶ sync_queue (one work list per connection)
                      │
                      ▼
            worker: dispatcher ─▶ reads the CURRENT values for the queued dates
                                  ─▶ pushes them ─▶ removes the queue rows
```

- **Nothing is lost between saving and sending.** The event is written in the
  same transaction as the change. If the change commits, the event exists; if
  it rolls back, it does not.
- **What is sent is the state, not the event.** The queue says "these dates of
  this room type changed"; the dispatcher reads what the values are now and
  sends those. Ten changes to one night become one push, a retry can never
  resend something stale, and the order of events does not matter.
- **Limits are respected.** The channel manager allows a number of requests a
  minute for each property. Pushes for a property are spaced accordingly
  (`CHANNEX_MIN_PUSH_INTERVAL_MS`), a burst of changes travels as one request,
  and a "too many requests" answer is obeyed for as long as it says.
- **Failures are retried with growing pauses** and shown in the monitor. After
  repeated failures an urgent alert is raised; when a push finally succeeds the
  alert clears by itself.
- **Safety nets under the per-change pushes.** Once a night the whole horizon
  is sent again (`SYNC_NIGHTLY_FULL`). Once a day the values the channel
  manager holds are read back and compared with the PMS; differences are
  corrected and reported (`SYNC_DRIFT_CHECK_DAYS`).

## How a booking from a site comes in

```
 site ─▶ channel manager ─▶ webhook "something happened" ─▶ API ─▶ job
                                                                   │
            worker: fetch the booking revisions ◀──────────────────┘
                   ─▶ store each as received (raw)
                   ─▶ apply once: create, change or cancel the reservation
                   ─▶ acknowledge to the channel manager
                   ─▶ inventory changed ─▶ outbox ─▶ every other site is closed
```

- **The webhook is only a nudge.** Nothing in its body is trusted or used. The
  booking is fetched from the channel manager's feed, which is the record. A
  webhook that never arrives costs nothing: the feed is also polled every
  fifteen minutes, and "Fetch now" does it on demand.
- **Each revision is applied once.** A revision is stored under its own id
  before it is applied; delivered twice, it is recognised. Revisions of one
  booking are applied in the order they happened; one that is older than what
  has been applied is kept but ignored.
- **It is acknowledged only after it is safely recorded.** If the worker stops
  in between, the channel manager offers the revision again.
- **A booking that cannot be placed is not dropped.** If its room or rate is
  not mapped, it is held, an alert says so, and it is applied as soon as the
  mapping is fixed ("Apply again").

The same pipeline takes bookings found in a calendar feed and bookings read
from email; only the first step differs.

## Live screens

The API keeps one `LISTEN` connection and passes each committed change to the
browsers that may see that property, over server-sent events. Screens refetch
what the event touched. A change made at the front desk, by the worker, or by a
booking site appears on every open calendar within about a second, without
anyone reloading.

## Background work

- **Jobs** (`jobs` table): claimed with `FOR UPDATE SKIP LOCKED`, retried with
  backoff, and deduplicated by a unique key so that ten workers scheduling the
  same recurring job produce one.
- **Schedules**: the worker's schedule loop queues what is due: polls, drift
  checks, the night audit at each property's own hour, automatic messages,
  rate suggestions, review fetches, reports, retention, owner statements, and
  the release of group rooms nobody booked by the cut-off.
- **Health**: each worker writes a heartbeat. The API notices when none has
  been heard from and raises an urgent alert, since it is the part still up to
  say so.

## Conventions worth knowing

- **Money** is whole numbers of minor units (paise) everywhere; never floats.
- **Stay dates** are calendar dates in the property's own time zone, carried as
  `YYYY-MM-DD` text from the database to the screen. `checkOut` is the day of
  departure, the first night not included.
- **The hotel day** is not the calendar day: it moves on when the night audit
  closes it. Charges belong to the hotel day they were posted in.
- **Every row belongs to an organisation**, and every query is scoped by it.
  Roles are granted per property (or for all properties); the API checks the
  permission against the property the request touches.
- **Every change is audited**: who, what, when, from where. The audit trail
  cannot be edited or deleted by the application.

## The AI layer

`packages/ai` puts one small interface in front of two providers (Anthropic
and OpenAI) and a third, scripted one for tests. Each feature has a rule-based
form that needs no provider at all, so nothing in the product stops working
when no key is set or the service is down.

The assistant can only do what the person using it may do: it is given only
the tools their role allows, and each tool checks again. Tools that change
something do not change it; they record a proposal that the same person must
confirm within fifteen minutes, and the change is then made with that person's
permissions and audited as theirs. Text that came from guests (names, notes,
messages, reviews) is passed to the model as data with an explicit instruction
that it is never a command.

What is sent to the AI service is kept to what the task needs:
[AI features](ai.md) lists it feature by feature.
