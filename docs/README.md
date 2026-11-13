# Hotel and villa property management system

A property management system (PMS) for a chain of hotels and villas, with the
calendar, bookings and blocked dates kept in step with the booking sites
(Booking.com, Airbnb, Agoda, Expedia, MakeMyTrip and the rest) as they change.

This folder is the documentation. Start with the page that matches what you
are about to do.

| If you want to                                             | Read                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| Run it on your own machine and look around                 | [Getting started](getting-started.md)                |
| Understand how it is built and why bookings cannot collide | [Architecture](architecture.md)                      |
| Connect the booking sites and go live                      | [Connecting the booking sites](channels.md)          |
| Install it for real use                                    | [Deployment](deployment.md)                          |
| Know what to do when something goes wrong                  | [Runbooks](runbooks.md)                              |
| Let another system read or change data, or be told of it   | [API keys and webhooks](integrations.md)             |
| Know who can see what, and how guest data is protected     | [Security and privacy](security-and-privacy.md)      |
| Switch the AI features on, and know what they send where   | [AI features](ai.md)                                 |
| See how it behaves under load                              | [Load testing](load-testing.md)                      |

## What is in it

**Selling and the calendar**

- Properties, room types, rooms and rate plans; hotels sold by room type and
  villas sold as a whole or by the bedroom, where selling one side closes the other.
- A live calendar across all properties: drag to book, to move a stay, to block dates.
- Rates and restrictions (minimum stay, closed to arrival or departure, stop sell) by date.
- Two rules the database itself enforces, whatever the application does: a room
  is never given to two stays on the same night, and a room type is never sold
  beyond the rooms it has.

**The booking sites**

- Availability, rates and restrictions go out to every connected site within
  seconds of a change; bookings, changes and cancellations made on a site come
  in within seconds and close the room on the other sites.
- Three routes, used together: a certified channel manager (Channex) for sites
  with a proper connection, calendar feeds (iCal) for single listings without
  one, and the reservations mailbox for booking emails.
- A monitor that shows what was sent and received, what is waiting and why,
  with alerts when a site falls behind, disconnects, or two sites sell the last room.

**Running the property**

- Front desk: arrivals, departures, guests in house, check-in and check-out, room moves.
- Bills (folios): charges, payments, refunds, split bills, company billing,
  GST invoices and credit notes with gap-free numbering, tax rules by slab.
- Night audit, by itself each night or run by hand.
- Housekeeping board and tasks; maintenance issues that can take a room off
  sale, which closes it on the booking sites too.

**Guests**

- Your own booking website with live prices, promotional codes and online payment.
- One inbox for messages from booking sites, WhatsApp and email; message
  templates and messages sent by themselves before arrival and after departure.
- Online check-in with identity details and documents, kept encrypted.

**Management**

- Reports: occupancy, average rate, revenue per available room, pace against
  last week, last month and last year, where bookings came from and what each
  source cost, takings by day, travel agent commission. As spreadsheets, and by
  email on a schedule.
- The tax register for the GST return, and the guest register for the police
  or the foreigners' registration portal, as files.
- Villa owners: contracts, costs, a statement each month, and a portal where
  an owner sees their own villa's bookings and statements and takes dates for themselves.
- Companies and travel agents with credit limits, statements and commission.

**AI, with a person deciding**

- An assistant that looks things up and prepares changes; nothing changes until
  the person who asked confirms it.
- Rate suggestions from how each night is selling, always inside the floor and
  ceiling you set; applied by a person, or by themselves for room types you choose.
- Suggested replies to guests and to reviews, review mood and subjects,
  likelihood that a booking cancels or does not arrive, room assignments that
  leave fewer gaps, housekeeping workload ahead.
- Every one of these works without an AI service, from built-in rules; with a
  key for one, the wording-heavy ones get better.

**For a group**

- Roles by property, two-step sign-in, single sign-on (OpenID Connect), an
  audit trail of every change.
- API keys and signed webhooks for other systems.
- Retention rules for guest data, a copy of a guest's data on request, erasure.
- Container images, backups, metrics for monitoring.

## What is deliberately not in it

- **No scraping of booking-site extranets.** The sites' terms forbid it, it
  cannot be made dependable (two-step sign-in, bot detection, redesigns), and
  it puts your listings at risk. The channel manager route does the same job
  through connections the sites have approved. See
  [Connecting the booking sites](channels.md) for what that needs from you.
- **No card numbers.** Guests pay on the payment gateway's own page. Card
  details never reach this system, and a reference that looks like a card
  number is refused.
- **Door locks, restaurant tills and key encoders** are not driven directly.
  They can be connected through the API and webhooks.
- **Filing with government portals** (guest registration, tax returns) is not
  automatic. Two files are there to hand over or to load into the portal's or
  the accountant's own tools: the tax register (every invoice and credit note
  by service code and tax rate) and the guest register (who arrived, with
  identity and visa details).
