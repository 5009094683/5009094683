# Runbooks

What to do when something goes wrong. Each entry starts with what you see,
then what it means, then what to do, in order.

The system tells you about most of these itself: an alert under the bell in
the back office, by email to the addresses under Settings, Organisation, and
in the metrics ([Deployment](deployment.md#monitoring)). An alert clears by
itself when its cause is gone; "Acknowledge" only says someone has seen it.

## Booking sites

### "Overbooking: ... on ..."

**Means** a booking was recorded although nothing was free: two sites sold the
last room within seconds of each other, or a site sold a room that had just
been blocked. The guest holds a confirmation from the site.

1. Open the reservation from the alert. It is marked Overbooked.
2. Look for a free room of another type on those nights (the calendar shows
   them) and move the stay there: an upgrade costs less than a walk.
3. If the house is full, decide which booking to relocate, and call that guest
   today. The earlier you call, the more options they have.
4. Cancel or move the stay in the PMS. The alert clears when every stay fits.
5. If it keeps happening on the same dates, hold a room back there: block one
   room of the type for the busiest dates, or set stop sell on the site that
   sells last.

### "... updates are not reaching the booking channels"

**Means** pushes to the channel manager have failed several times in a row.
The sites still show the last values that got through, so a room sold in the
PMS since then is still on sale there.

1. Channels, open the connection, read the newest "Sent" rows in Activity.
   The error is the channel manager's own answer.
2. **"401" or "403"**: the API key is wrong, expired or lacks access to this
   property. Fix `CHANNEX_API_KEY` and restart the API and worker.
3. **"429"**: too many requests. The system is already waiting as long as it
   was told. If it recurs, raise `CHANNEX_MIN_PUSH_INTERVAL_MS`.
4. **"5xx", timeouts**: the channel manager is down. Nothing is lost: changes
   stay queued and the latest values go out the moment it answers. Check its
   status page. If it lasts, consider a stop sell directly in the busiest
   sites' extranets for tonight.
5. **A validation error naming a room or rate**: the mapping points at
   something that no longer exists in the channel manager. Open "Rooms and
   rates" on the connection, fix the mapping, then "Send everything again".
6. When it recovers the alert clears by itself. To be sure, choose "Compare
   with the channels".

### "... changes are slow to reach the booking channels"

**Means** a change has been waiting more than ten minutes although pushes are
not failing. Usually a large backlog after a bulk rate change, working its way
out at the allowed pace; sometimes a worker that is stuck.

1. Channels: is the number waiting going down? Then wait.
2. If it is not: restart the worker (`docker compose restart worker`). Work in
   progress is picked up again; nothing is sent twice.

### "Channel sync has stopped: the sync worker is not running"

**Means** no worker has reported in for a minute and a half. Bookings from the
sites are not being fetched and nothing is being sent.

1. `docker compose ps worker` and `docker compose logs --tail 100 worker`.
2. A line reading "[worker] Cannot start." names a wrong setting. Fix it.
3. Otherwise `docker compose up -d worker`. On starting it fetches what was
   missed and sends what was queued.

### "... a booking arrived for a room that is not mapped"

**Means** a site sold a room or rate that is not mapped to anything in the
PMS. The booking is held, not lost, but **the room is not yet taken off sale
anywhere**.

1. Channels, the connection, "Rooms and rates": map the room or rate named in
   the alert (or create the missing room type first).
2. Under "Bookings received", choose "Apply again" on the held booking.
3. Check the reservation that appears.

### "... a booking from ... could not be recorded" / "bookings cannot be fetched"

**Means** a booking arrived that the system could not apply, or the feed could
not be read. The message says why.

1. Read the message. Typical causes: dates that make no sense, a property that
   was removed, the channel manager not answering.
2. Fix the cause, then "Apply again" on the booking, or "Fetch bookings now".
3. If you cannot fix it at once, enter the booking by hand from the site's
   extranet so the room is closed, and note the site's booking number on it.

### "... is no longer connected"

**Means** a site dropped its connection to the channel manager: a password
changed on the extranet, a contract lapsed, the listing was deactivated.
Nothing reaches that site until it is reconnected.

1. Channels, the connection, "Connect booking sites": reconnect the site in
   the channel manager's screen.
2. Then "Send everything again".

### "... value(s) on the channels did not match the PMS"

**Means** the daily comparison found values in the channel manager that
differ from the PMS, and put them right. Someone changed a rate or closed
dates directly on a site or in the channel manager.

1. Nothing to repair: it is done. The alert lists what differed.
2. Find out who changes things outside the PMS, and stop it: the PMS is the
   one place to change rates and availability, or the two will keep fighting.

### "... a calendar could not be read"

**Means** a site's calendar address did not answer, or did not return a
calendar. Stays on that site are not being picked up.

1. Open the address from the connection in a browser. If the site has given
   the listing a new address, replace it.
2. The alert clears on the next successful reading (every five minutes).

### A booking is in the site's extranet but not in the PMS

1. Channels, the connection, "Fetch bookings now". Wait ten seconds.
2. Look under "Bookings received": if it is there with a reason, follow that.
3. If it is not there at all, the site has not passed it to the channel
   manager. Check the booking in the channel manager's own screen. Enter the
   booking by hand meanwhile.

## Front desk and accounts

### "... the night audit for ... failed" or "needs a look"

**Means** the hotel day was not closed, or was closed with things left over:
guests still checked in past their departure, arrivals who never came.

1. Accounts, Night audit shows the day in progress and what is outstanding.
2. Check out or extend the overdue departures. Mark the no-shows, or check
   them in if they are simply late.
3. "Run night audit now". It charges each occupied room for the night exactly
   once however often it is run.

### "A website booking was paid after its rooms were released"

**Means** a guest paid after the hold on their rooms had run out and the rooms
had been sold to someone else. The payment was refunded automatically if the
alert says so; if it says the refund FAILED, refund it from the gateway's
dashboard today.

1. Call the guest and offer other dates.

### "Refund owed on cancelled booking ..."

**Means** a guest cancelled online within the free period and the money could
not be sent back automatically.

1. Open the reservation, Bill, the payment's menu, "Refund". For an online
   payment also send the money back in the gateway's dashboard: recording a
   refund here does not move money.

### "A message to ... could not be sent"

1. Inbox, open the conversation: the failed message says why (no WhatsApp
   template approved, the site's message box is not switched on, the mail
   server refused it). Fix that, then "Retry" on the message.

### The assistant or the suggestions say the AI service did not answer

Nothing stops: every AI feature falls back to its built-in version and says
so under the result.

1. Check the key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) and, if set,
   `AI_MODEL`: a model name the service does not know is the usual cause after
   a change. Restart the API and the worker after correcting it.
2. `GET /ai/usage` as an administrator shows how many calls failed, by
   feature. The service's own error message for each failed call is in the
   `ai_runs` table (`error`).
3. If the service itself is down, there is nothing to do but wait.

## The system itself

### The API or worker will not start

`docker compose logs api` (or `worker`). The last line starting "Cannot
start." names the setting. The usual three: `APP_ENCRYPTION_KEY` missing or
not 32 bytes in base64; no payment gateway configured; the database
unreachable (then the line is a connection error instead).

### Restoring from a backup

See [Deployment, Backups](deployment.md#backups). Afterwards, on every
connection: "Fetch bookings now", then "Send everything again".

### The encryption key may have leaked

1. Make a new key: `openssl rand -base64 32`.
2. Set it as `APP_ENCRYPTION_KEY` and move the old one to
   `APP_ENCRYPTION_KEY_PREVIOUS`. Restart the API and the worker. Everything
   stays readable; what is saved from now on uses the new key, and guest links
   already sent keep working.
3. Replace the secrets that were encrypted under the old key and are used
   outside: mailbox passwords, single sign-on client secrets, webhook signing
   secrets (Settings, Integrations, "Replace secret").
4. Once nothing old is left to read, remove `APP_ENCRYPTION_KEY_PREVIOUS`.

### An API key may have leaked

Settings, Integrations: revoke it (it stops working at once) and create
another. The audit trail (Settings, Audit) shows everything the old key did,
under the key's name.

### A member of staff leaves

Settings, Users: disable the account. Their sessions end at once. If they had
access to a shared mailbox or an extranet, change those passwords too.

### A guest asks for their data, or to be forgotten

- **A copy**: `GET /guests/<id>/export`, as someone who may see identity
  details (front desk, a manager) and whose role covers every property. It
  returns everything held about them and records that it was taken.
- **Erasure**: `POST /guests/<id>/erase`. Their name, contact details, identity
  details, documents and conversations are removed; their past stays remain,
  without a name, because the books need them. It is refused while they have a
  stay under way or to come. Tax invoices already issued are kept as issued:
  the law that requires them to be kept comes first. It cannot be undone.

## Before calling for help

Have these ready: the time it happened, the property, the reservation code
or the site's booking number, the "Channel manager reference" from the
Activity row if it concerns sync, and the request id shown with any error
message in the back office.
