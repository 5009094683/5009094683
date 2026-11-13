# Connecting the booking sites

This page is for whoever takes the system live with the booking sites: what
the options are, what each needs from you, and the steps in order.

## The three routes, and when each is used

| Route                         | What it carries                                                                                           | How fast                                                            | Use it for                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Channel manager (Channex)** | Availability, rates and restrictions out; bookings, changes, cancellations, guest messages and reviews in | Seconds, both ways                                                  | Every site Channex connects to: Booking.com, Airbnb, Agoda, Expedia, MakeMyTrip, Goibibo, Trip.com, Vrbo, Google and many more |
| **Calendar feeds (iCal)**     | Which nights are taken, both ways. No guest, no price                                                     | We read the site every 5 minutes; the site reads us every few hours | A single villa or room listed on a site that is not connected through the channel manager                                      |
| **Reservations mailbox**      | Booking emails the sites send you, read into reservations                                                 | About a minute after the email arrives                              | A second way in for bookings, and for sites with no other route                                                                |

They are used together. A property normally has the channel manager for its
main sites; a villa that is also on a small local site gets a calendar
connection for that one; the mailbox catches whatever arrives by email.

### Why not sign in to each site's extranet and drive it automatically?

Because it would put your listings at risk and still not be dependable.
Airbnb's terms forbid "bots, crawlers, scrapers, or other automated means";
Booking.com's forbid circumventing its processes; both suspend accounts for
it. Sign-in needs a one-time code, bot detection interrupts sessions, and a
redesign of a page breaks everything until someone rewrites it. A room sold
twice because a script was logged out at the wrong moment costs more than the
channel manager does in a year.

The channel manager does the same job through connections the sites
themselves have approved. That is the route this system is built around. A
session-driven connector for one named site can be added later if you have a
site with no other way in and accept those limits; it is not included.

## What "real time" means here

- **A change in the PMS** (a booking, a block, a rate) is sent to the channel
  manager within a few seconds. Changes for one property are grouped and spaced
  about 6.5 seconds apart, because the channel manager allows ten requests a
  minute for each property. The channel manager passes them on to each site
  straight away; the site applies them within seconds to a couple of minutes,
  depending on the site.
- **A booking on a site** reaches the PMS within seconds of the site telling
  the channel manager, and the room is then closed on every other site by the
  path above.
- **Two guests booking the last room on two sites within that window** can
  both succeed. No system can prevent this; the sites confirm to the guest
  before telling anyone. When it happens both bookings are recorded, the
  second is marked overbooked, and an urgent alert is raised at once so that
  someone can move or call the guest. Keeping one room back on the busiest
  sites for the busiest dates is the usual protection.
- **Calendar feeds are not real time** and cannot be made so: the site decides
  how often it reads your calendar (Airbnb about every 3 hours, Booking.com
  about every 2). For those hours a night sold in the PMS can still be sold on
  that site. This is why calendars are for single listings on minor sites only.

## Going live with the channel manager

### What you need to arrange

1. **A Channex account.** Start with a free one on the test system at
   <https://staging.channex.io>. Production access (`app.channex.io`) follows
   their review of this PMS, described under "Certification" below.
2. **An API key** from that account (in Channex, under your profile).
3. **Someone with administrator access to each site's extranet**, to approve
   the connection from inside the site when the time comes.

### Settings

Put these in the environment of the API and the worker (`.env`, or your
secrets store):

```bash
CHANNEX_API_KEY=...                       # from your Channex account
CHANNEX_BASE_URL=https://staging.channex.io/api/v1   # production: https://app.channex.io/api/v1
CHANNEX_WEBHOOK_SECRET=...                # make one up: openssl rand -hex 32
```

`CHANNEX_WEBHOOK_SECRET` is how the PMS knows a "new booking" call really came
from Channex: the PMS asks Channex to send it back with every call, and
refuses calls without it. If your Channex account signs webhooks with a
signing key instead, set `CHANNEX_WEBHOOK_SIGNING_SECRET` as well or instead.
In production the PMS refuses unsigned calls outright.

The API must be reachable from the internet at the address in
`API_PUBLIC_URL`, over HTTPS. The address Channex calls is
`<API_PUBLIC_URL>/webhooks/channex`; with the bundled set-up that is
`https://<your back office>/api/webhooks/channex`.

### Steps, for each property

Open **Channels** in the back office. The banner at the top says whether the
channel manager is configured and which system (test or production) it is.

1. **Connect.** Choose the property and "Connect".
2. **Channel manager property.** Either "Set up automatically", which creates
   the property in Channex with a room for each room type and a rate for each
   rate plan and maps them, or "Use an existing property" if it is already
   there.
3. **Rooms and rates.** Check the mapping: each room type and rate plan here
   against its counterpart in Channex. "Add anything missing" creates what
   Channex lacks. Only mapped room types and rate plans are synced.
4. **Booking announcements.** "Register" tells Channex to call this PMS when
   something happens. Once for the whole account.
5. **Go live.** "Switch on". The whole horizon (about 500 days) of
   availability, rates and restrictions is sent, in two requests. From then on
   every change goes out by itself.
6. **Booking sites.** "Connect booking sites" opens Channex's own screen
   inside the back office. There you add each site (Booking.com, Airbnb,
   Agoda, ...), sign in to it or enter the property's id on it, and map the
   site's rooms and rates to the Channex ones. Each site then asks your
   extranet administrator to approve the connection; how differs by site and
   Channex's screen walks through it.
7. **Bookings made before today.** "Import existing bookings" (in the
   connection's menu) brings in the future bookings each site already holds,
   so the calendar is complete from the first day.

Do one property first, on the test system, with a test listing. Make a
booking on the site, change it, cancel it; block dates in the PMS; change a
rate. Watch each arrive on the other side in the connection's Activity table
before connecting the rest.

### Certification

Channex gives production access to a PMS after checking that it behaves
correctly: that a full sync is two requests and not hundreds, that only what
changed is sent, that limits are respected, that bookings are acknowledged.
The test list is in their documentation ("PMS certification tests"); it is a
set of rate, restriction and availability changes to make on a test property,
and a booking to receive, change and cancel.

This PMS was built to that list and passes each case against the bundled
stand-in for Channex, which enforces the same limits. The run against
Channex's own test system has to be done with **your** account, because the
result is tied to it:

1. Set the three settings above to the test system and restart.
2. Create the test property Channex's document asks for (its name, two room
   types and four rate plans) under Settings, Properties, and connect it as
   above.
3. Make each change the document lists under Rates. One "Save" is one request.
4. For each test Channex asks for the ids of the requests. They are in the
   connection's Activity table, under each "Sent" row, as "Channel manager
   reference".
5. For the booking tests, make, change and cancel a booking with the test
   booking tool Channex provides; each shows under "Bookings received" as Recorded.
6. Send Channex the form, then show them the PMS in the live call they ask for.

Two answers they ask for in words: **rate limits**: pushes for a property are
spaced to stay within ten a minute, and a "too many requests" answer is waited
out for as long as it says and then retried; **what is sent**: only the dates
that changed, merged into ranges, plus one full sync a night.

### After go-live: the menu on each connection

- **Send everything again**: a full sync, after a large change or when in doubt.
- **Fetch bookings now**: asks for bookings without waiting for an announcement.
- **Compare with the channels**: reads back what Channex holds and corrects any
  difference. This also runs once a day by itself.
- **Pause** and **Resume**: stops and restarts sending. Resuming starts with a
  full sync, so nothing changed meanwhile is missed.

## Calendar connections (iCal)

For a single villa or room on a site that the channel manager does not reach.

1. In Channels, add a calendar connection for the property.
2. For the unit, add a calendar for each site: paste the address of the
   site's calendar (found in the site's own calendar or availability settings,
   usually called "export calendar"), and copy the PMS's address for that unit
   into the site ("import calendar").
3. Switch the connection on.

What to expect:

- Each stay found in a site's calendar is recorded as a reservation with no
  guest name and no price, marked for review. Add the details from the site.
  Entries the site marks as closed dates are recorded as blocks.
- A booking that disappears from the site's calendar is cancelled in the PMS
  only after it has been missing from two readings, so a calendar that is
  briefly empty does not cancel everything.
- If a calendar cannot be read, an alert says so and clears when it can.
- The PMS's own calendar lists every night the unit is taken, without guest
  details, and leaves out what that same site sold (it knows those already).
- Never use this for a room type with more than one room: a calendar can only
  say "taken" or "free".

## The reservations mailbox

Sites email the property about every new booking, change and cancellation.
The PMS can read those.

1. In Channels, add a reservations mailbox for the property and enter how to
   read it: the mail server, user and password (IMAP), and the folder. For a
   mailbox shared by several properties, also the address this property's mail
   is sent to. Or, if your mail service can forward mail to a web address, use
   the forwarding address shown instead of a mailbox (needs
   `INBOUND_EMAIL_SECRET`).
2. Map each room type to the name the sites use for it in their emails.
3. Switch the connection on.

What to expect:

- A booking read from an email is recorded and marked for staff to check
  against the site. An email that looks like a booking but cannot be read is
  passed on as an alert, not guessed at. If an AI service is configured it is
  given a second reading first, and what it reads is still marked for checking.
- **Changes and cancellations are applied only when your mail server confirms
  who sent the email** (SPF, DKIM or DMARC pass). Anyone can type an email that
  says "booking 123 is cancelled". An unverified one is shown to staff and not
  applied. An email that fails the checks is ignored whatever it says.
- The mailbox only reads. It does not close rooms on any site; the channel
  manager or the calendars do that.
- The patterns that read each site's emails were written from the published
  layouts, not from your mailbox. Before relying on this route, forward a
  dozen real emails from each site and check that each is read correctly;
  layouts differ by country and change without notice.

## Checklist before the first live booking

- [ ] `API_PUBLIC_URL` is the public HTTPS address, and
      `<API_PUBLIC_URL>/webhooks/channex` answers from outside.
- [ ] `CHANNEX_WEBHOOK_SECRET` is set, and step 4 shows "Done".
- [ ] Every room type and rate plan that is sold online is mapped.
- [ ] Rates and restrictions in the PMS are right for the whole horizon: on
      switching on, the PMS's values replace whatever the sites had.
- [ ] Existing bookings were imported, and the calendar matches each extranet.
- [ ] `alertEmails` (Settings, Organisation) names people who will act at
      night: an overbooking alert is only useful if someone reads it.
- [ ] A test booking on each site arrived, and closed the room on the others.
- [ ] A worker is running, and the banner on Channels says so.
