# Load testing

A load run that starts the real API, the real worker and the booking-site
simulator on local ports, with a database of its own, and drives them over
HTTP. It measures the paths that carry the load in practice and checks the
one thing that must hold under any load: the last room is sold once.

## Running it

```bash
pnpm test:load                 # the standard run, about a minute
LOAD_SCALE=3 pnpm test:load    # three times the requests
```

It needs PostgreSQL reachable at `DATABASE_URL` with the right to create a
database (it makes `pms_load` and drops it at the end). It touches nothing
else: not the development database, not any real booking site.

The run prints a table and exits with an error when a limit is missed, so it
can be used as a gate before a release.

## What it does

The property under test is a hotel with 50 rooms of two types, selling on its
own website and, through the channel manager route, on five simulated booking
sites. The pause the channel manager asks for between pushes is switched off
for the run, so that what is measured is this system and not the wait.

| Step                        | What happens                                                                                                     | Limit                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Website search              | 3,000 guests ask for prices and availability for different dates, 50 at a time                                   | 95 in 100 answered within 400 ms                  |
| Calendar                    | 600 requests for a month of every room, 20 at a time                                                             | 95 in 100 within 600 ms                           |
| Bookings from booking sites | 300 bookings arrive from the five sites in a stream; each must be recorded and the room closed on the other four | All done within 60 s; none recorded as overbooked |
| Rate changes                | 200 rate changes by staff, 10 at a time, each going out to every site                                            | 95 in 100 within 600 ms; all sent within 90 s     |
| The last room               | Nine of ten rooms are sold; 60 guests try to book the tenth at the same instant                                  | Exactly 1 succeeds, 59 are refused                |
| After the rush              | The sold-out night shows as closed on every site                                                                 | Within 30 s                                       |
| Overall                     | Requests that failed for any reason other than "no availability"                                                 | Fewer than 1 in 1,000                             |

## A recorded run

On the development machine (8 cores; PostgreSQL, the API, the worker and the
simulator all on it), 13 November 2026:

| Step                             | Result                                                |
| -------------------------------- | ----------------------------------------------------- |
| Website search, 3,000 requests   | 318 a second; 95 in 100 within 201 ms                 |
| Calendar, 600 requests           | 95 in 100 within 100 ms                               |
| 300 bookings from booking sites  | All recorded and every other site closed in 7 seconds |
| 200 rate changes                 | 95 in 100 within 32 ms                                |
| The last room, 60 guests at once | Sold once, refused 59 times, closed on every site     |
| Failed requests                  | None                                                  |

These are figures for one machine doing everything. They say that the design
has room to spare for a chain of this kind, not what a particular production
setup will do: run it there to know.

## Reading the result

- **Searches slow**: this is the path guests feel. It is reads only; more API
  processes behind the proxy raise it nearly in step, until the database is
  the limit.
- **Bookings slow to drain**: look at Channels, Activity during the run. The
  worker handles each connection's work in order and different connections
  side by side. In real use, if the queue grows while the worker is idle, the
  pause between pushes that the channel manager asks for is the cause
  (`CHANNEX_MIN_PUSH_INTERVAL_MS`). That is theirs to set, not ours to beat:
  changes are merged while they wait, so what is sent is always the latest
  state.
- **The last room sold twice**: must never happen; the database refuses it
  whatever the application does. If the run ever reports it, stop and treat it
  as a defect.

## What it does not cover

- The real booking sites' own delays. The simulator answers at once; a real
  site takes from a few seconds to a few minutes to show a change.
- The AI service, the payment gateway, email and WhatsApp: none is called.
- Long runs. This is a burst of about a minute. For a soak test, raise
  `LOAD_SCALE` and watch memory and the queue depth on `/metrics`.
