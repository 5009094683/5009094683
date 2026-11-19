# Deployment

The system is four programs and a database. `docker-compose.yml` runs all of
them on one machine, which is enough for a chain of this size; the notes at
the end say what to change to spread them over several.

| Program      | Image target  | What it needs                                           |
| ------------ | ------------- | ------------------------------------------------------- |
| API          | `api`         | The database, the settings below, the files volume      |
| Worker       | `worker`      | The same as the API. No port                            |
| Back office  | `web`         | To reach the API at the address given when it was built |
| Booking site | `booking`     | The same                                                |
| Database     | `postgres:16` | A disk that is backed up                                |

## One machine, with Docker

You need Docker with the compose plugin, and two host names pointing at the
machine: one for the back office, one for the booking site.

```bash
git clone <this repository> pms && cd pms
cp .env.example .env
```

Edit `.env`. These must be set:

```bash
POSTGRES_PASSWORD=<a long random value>
APP_ENCRYPTION_KEY=<output of: openssl rand -base64 32>

WEB_URL=https://pms.example.com            # the back office, as staff type it
BOOKING_URL=https://book.example.com       # the booking site, as guests type it
API_PUBLIC_URL=https://pms.example.com/api # how the outside world reaches the API

PMS_DOMAIN=pms.example.com                 # for the TLS proxy
BOOKING_DOMAIN=book.example.com
```

and one of these, or the API and worker will refuse to start (so that a live
site never falls back to a payment page that approves everything):

```bash
RAZORPAY_KEY_ID=...  RAZORPAY_KEY_SECRET=...  RAZORPAY_WEBHOOK_SECRET=...
# or
STRIPE_SECRET_KEY=...  STRIPE_WEBHOOK_SECRET=...
# or, for a trial with no real payments:
PAYMENT_PROVIDER=mock
```

Then the rest as they apply; each is explained in `.env.example`:

- **Booking sites**: `CHANNEX_API_KEY`, `CHANNEX_BASE_URL`,
  `CHANNEX_WEBHOOK_SECRET`. See [Connecting the booking sites](channels.md).
  In production there is no stand-in: without a key nothing is synced.
- **Email**: `SMTP_URL`, `MAIL_FROM`. Without it invitations, confirmations,
  alerts and scheduled reports are not sent (the logs say so).
- **WhatsApp**: `WHATSAPP_*`.
- **AI**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. See [AI features](ai.md).
- **Monitoring**: `METRICS_TOKEN`.

Start it:

```bash
docker compose --profile proxy --profile backup up -d --build
docker compose ps          # everything should be "healthy" within a minute
docker compose logs api    # a wrong setting is reported here, in one line
```

- `--profile proxy` adds Caddy, which gets TLS certificates for the two host
  names by itself and renews them. Leave it out if you have your own proxy;
  then send `PMS_DOMAIN` to port 3000 and `BOOKING_DOMAIN` to port 3001, and
  do not buffer responses on `/api/live` (it is a long-lived stream).
- `--profile backup` adds the nightly backup described below.

Open the back office. The first visit asks for the organisation's name and
the first administrator; after that the page is gone. Sign in, then:

1. Settings, Security: turn on two-step sign-in for yourself, and under
   Organisation require it for everyone.
2. Settings, Organisation: currency, time zone, who is emailed about alerts,
   how long guest data is kept.
3. Settings, Properties: properties, room types, rooms, rate plans, tax rules.
4. Settings, Users: invite staff with the role each needs, per property.
5. Channels: connect the booking sites.

### Payment gateway webhooks

So that a payment is recorded even when the guest closes the page before
returning, point the gateway's webhook at the API:

- Razorpay: event `payment_link.paid` to `<API_PUBLIC_URL>/webhooks/payments/razorpay`
- Stripe: events `checkout.session.completed` and
  `checkout.session.async_payment_succeeded` to `<API_PUBLIC_URL>/webhooks/payments/stripe`

The worker also asks the gateway about unpaid orders by itself, so a missed
webhook delays a confirmation by a minute or two rather than losing it.

## Upgrading

```bash
git pull
docker compose --profile proxy --profile backup up -d --build
```

The API and the worker apply database changes when they start, one at a time
under a lock, so starting several at once is safe. Take a backup first
(`docker compose --profile backup run --rm --entrypoint /usr/local/bin/pms-backup backup`).
To go back to the previous release, restore that backup and start the previous
images.

## Backups

What has to be backed up:

1. **The database.** Everything is in it.
2. **The files volume** (`STORAGE_DIR`): guests' identity documents and message
   attachments. They are encrypted before they are written.
3. **`APP_ENCRYPTION_KEY`**, kept somewhere other than with the backups. It
   decrypts the files and the secrets in the database (identity numbers,
   mailbox passwords, webhook secrets, two-step sign-in seeds). Without it they
   cannot be read; whoever has it and a backup can read them.

`scripts/backup.sh` writes a compressed dump of the database and an archive of
the files to `BACKUP_DIR`, checks that the dump can be read, and removes
copies older than `BACKUP_KEEP_DAYS` (14). The `backup` service runs it once a
day into the `backups` volume. **Copy that volume off the machine** (object
storage, another site) with whatever you already use; a backup on the disk it
protects is not a backup.

To restore, stop the API and the worker, then:

```bash
docker compose --profile backup run --rm \
  -v ./scripts/restore.sh:/usr/local/bin/pms-restore:ro \
  --entrypoint /bin/sh backup -c 'pms-restore /backups/pms-<stamp>.dump --yes'
# the files, if the volume was lost too:
docker compose --profile backup run --rm --entrypoint /bin/sh \
  -v pms_files:/restore backup -c 'tar -xzf /backups/pms-files-<stamp>.tar.gz -C /restore'
docker compose up -d
```

Practise this once before you need it. After a restore, open Channels and
choose "Send everything again" and "Fetch bookings now" on each connection:
the booking sites carried on while the database went back in time, and this
brings the two back in step. Bookings made on the sites in between are
fetched; bookings taken by phone in between have to be re-entered.

For less to lose, add PostgreSQL's own continuous archiving (WAL archiving, or
a managed PostgreSQL with point-in-time recovery) under the nightly dump.

## Monitoring

- **Is it up**: `GET /health` (the process answers) and `GET /ready` (it can
  reach the database) on the API. The images have these as health checks.
- **Is it keeping up**: `GET /metrics` on the API, in the Prometheus text
  format, for a caller sending `Authorization: Bearer <METRICS_TOKEN>`. The
  ones to alert on:

  | Metric                                     | Alert when             | Meaning                                  |
  | ------------------------------------------ | ---------------------- | ---------------------------------------- |
  | `pms_workers_alive`                        | 0 for 2 minutes        | No worker: nothing is synced             |
  | `pms_sync_queue_oldest_seconds`            | above 600              | Changes are not reaching the sites       |
  | `pms_outbox_oldest_seconds`                | above 120              | The worker is not picking changes up     |
  | `pms_booking_revisions_waiting`            | above 0 for 15 minutes | A booking from a site is not applied     |
  | `pms_alerts_open{severity="critical"}`     | above 0                | Something the system itself calls urgent |
  | `pms_jobs_overdue_seconds`                 | above 900              | Background work is stuck                 |
  | `pms_webhook_deliveries{status="pending"}` | growing                | A receiver of yours is down              |

- **What the system tells people itself**: alerts appear under the bell in the
  back office, and urgent ones and warnings are emailed to the addresses under
  Settings, Organisation. It raises them for an overbooking, a site that has
  fallen behind or disconnected, a booking it could not place, a failed night
  audit, a payment that could not be matched, a failed message, and no worker
  running.
- **Logs** are JSON lines on standard output. Session cookies, authorisation
  headers, guest links and secrets in query strings are left out of them.

## Settings that matter in production

| Setting                        | Why                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENCRYPTION_KEY`           | Required. See Backups. To change it, set the new key here and the old one in `APP_ENCRYPTION_KEY_PREVIOUS`; old data stays readable and is re-encrypted as it is next saved                                                                                                                                                                                        |
| `TRUST_PROXY=true`             | The default. The API reads the visitor's address from the proxy's `X-Forwarded-For` header, and limits requests by it. The proxy in front must set that header itself, replacing whatever a visitor sent (the bundled Caddy does); one that only adds to it lets a visitor fake their address. Set it to `false` only if the API is exposed with no proxy in front |
| `API_DOCS=false`               | The default in production: the interactive API description is not served                                                                                                                                                                                                                                                                                           |
| `WEBHOOKS_ALLOW_PRIVATE_HOSTS` | Leave unset: outbound webhooks then cannot be pointed at your internal network                                                                                                                                                                                                                                                                                     |
| `SESSION_TTL_HOURS`            | How long a sign-in lasts (12)                                                                                                                                                                                                                                                                                                                                      |
| `DATABASE_POOL_MAX`            | Connections each API or worker process may open (10)                                                                                                                                                                                                                                                                                                               |
| `WORKER_CONCURRENCY`           | Background jobs one worker runs at a time (4)                                                                                                                                                                                                                                                                                                                      |

## More than one machine

- **API**: run as many as you like behind a load balancer. They hold no state.
  Live updates work across them, since each listens to the database.
- **Worker**: run two for cover. They share the work; each piece is taken
  under a lock. More than two rarely helps: the pace of sync is set by the
  channel manager's request limits, not by the worker.
- **Web apps**: stateless; run as many as you like. The address of the API
  inside your network is fixed when the images are built
  (`--build-arg API_INTERNAL_URL=...`), because it becomes part of their routing.
- **Files**: every API and worker must see the same `STORAGE_DIR` (a shared
  volume or network file system).
- **Database**: one primary. Size its connection limit for
  `DATABASE_POOL_MAX` times the number of API and worker processes, plus two
  listening connections for each.
