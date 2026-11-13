# Getting started

How to run the whole system on one machine, with made-up data and stand-ins
for the booking sites and the payment page, so that everything can be tried
without accounts anywhere.

## What you need

- Node.js 22 and pnpm 10 (`corepack enable` gives you pnpm).
- PostgreSQL 16 on `localhost:5432`, with a role `pms` (password `pms`) that
  may create databases, and a database `pms`. On Debian or Ubuntu,
  `scripts/cloud-agent-install.sh` installs PostgreSQL and creates both.

## Run it

```bash
pnpm install
pnpm db:migrate        # creates the tables
pnpm db:seed           # an example chain: one hotel, two villas, five weeks of history
pnpm dev               # starts everything below
```

| What                  | Where                 | Notes                                                 |
| --------------------- | --------------------- | ----------------------------------------------------- |
| Back office           | http://localhost:3000 | Sign in as `admin@example.com` / `demo-password-1`    |
| Guest booking site    | http://localhost:3001 | Books against the same rooms and rates                |
| API                   | http://localhost:4000 | Interactive description at http://localhost:4000/docs |
| Booking-site stand-in | http://localhost:4100 | Shows what each site would offer for sale             |
| Worker                | no port               | Sync with the sites, night audit, messages, reports   |

No `.env` file is needed for this. `.env.example` lists every setting with
what it is for; copy it to `.env` to change one.

## What the example data holds

`pnpm db:seed` makes "Sea Breeze Hotels & Villas": a hotel of twelve rooms in
Candolim, a three-bedroom villa sold whole or by the bedroom, and a cottage.
It then lives through the last five weeks one hotel day at a time, with the
same code the application runs: guests arrive, eat, pay and leave, rooms are
cleaned, each night is closed. So on the first look there are guests in
house, arrivals expected and departures due today, bills with charges and
payments, invoices, rooms to clean, repairs waiting, messages from guests,
reviews, rate suggestions, a month of figures in the reports, and last
month's statements for the two villa owners.

Everyone's password is `demo-password-1`:

| Sign in as                 | To see the system as                               |
| -------------------------- | -------------------------------------------------- |
| `admin@example.com`        | The administrator: everything                      |
| `manager@example.com`      | A general manager                                  |
| `frontdesk@example.com`    | The front desk of the hotel                        |
| `revenue@example.com`      | The revenue manager                                |
| `accounts@example.com`     | The accountant                                     |
| `housekeeping@example.com` | A housekeeper: the cleaning board and nothing else |
| `maintenance@example.com`  | The engineer: repairs                              |

To see the owner's side, open Villa owners, choose Kavita Menon and invite
her to the owner portal: the link it gives sets her password.

## Things to try

1. **The calendar.** Drag across empty dates to book, drag a stay to move it,
   choose "Block dates" to take a room off sale. Open the calendar in a second
   window: changes appear there by themselves.
2. **Sync with the booking sites.** Open Channels and set a property up
   ("Set up automatically" does it against the stand-in). Then open
   http://localhost:4100: book a room there as a guest on one site and watch
   the reservation appear in the back office and the room close on the other
   sites. Block dates in the back office and watch them close there.
3. **Your own website.** On http://localhost:3001 search for dates, book and
   pay on the stand-in payment page. The room is held while the guest pays and
   closes on the booking sites straight away.
4. **Front desk.** Check a guest in, add charges, take a payment, check them
   out, issue the invoice. Run the night audit under Accounts.
5. **The assistant.** Click Assistant in the top bar and type
   `block Villa Azure from 12 Dec to 15 Dec for maintenance`. It prepares the
   change; nothing happens until you confirm.

## Checks

```bash
pnpm lint            # ESLint
pnpm typecheck       # TypeScript, every package
pnpm format:check    # Prettier
pnpm test            # unit and integration tests (needs PostgreSQL)
pnpm test:e2e        # browser tests (needs Google Chrome)
pnpm test:load       # a load run; see load-testing.md
pnpm build           # production builds
```

The tests create and drop their own databases (`pms_test_*`, `pms_e2e`,
`pms_load`) beside `pms`. They never touch `pms` itself.

## Where things are

```
apps/api        the HTTP API (Fastify)
apps/worker     background work: channel sync, jobs, schedules
apps/web        the back office (Next.js)
apps/booking    the guest booking site (Next.js)
apps/ota-sim    stand-in for the channel manager and the booking sites
packages/db       tables and migrations (Drizzle)
packages/domain   the rules: reservations, inventory, rates, bills, guests, reports
packages/channels sync engine and the routes to the booking sites
packages/ai       assistant, rate suggestions, replies, reviews, insights
packages/config   settings read from the environment
tests/integration API, worker and stand-in together over real HTTP
tests/e2e         browser tests
tests/load        the load run
docs              this documentation
```

To start again with an empty database: `pnpm db:reset`, then `pnpm db:seed`.
