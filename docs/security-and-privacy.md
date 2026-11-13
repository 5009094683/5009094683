# Security and privacy

Who can see and do what, how sign-in is protected, what is encrypted, and how
guests' personal data is kept, handed over and erased.

## Roles

Access is given by role, per property or for all properties. One person can
hold different roles at different properties.

| Role               | For                               | Can                                                                                                                              |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Organisation admin | Whoever runs the system           | Everything, including users, sign-in, API keys and webhooks                                                                      |
| General manager    | A property's manager              | Everything at their properties, except managing the organisation                                                                 |
| Revenue manager    | Rates and distribution            | Rates, restrictions, channel connections, reservations, blocks, rate suggestions; reads the rest                                 |
| Front desk         | Reception                         | Reservations, check-in and check-out, guests and their identity details, bills and payments, housekeeping status, guest messages |
| Housekeeping       | Housekeepers                      | The housekeeping board and tasks. No guest contact details, no money                                                             |
| Maintenance        | Engineers                         | Maintenance issues, and taking a room off sale for a repair                                                                      |
| Accountant         | Accounts                          | Bills, refunds, invoices, tax rules, companies, owners, night audit, the audit trail                                             |
| Read only          | Owners' representatives, auditors | Reads reservations, rates, guests, bills, messages, reports; changes nothing                                                     |
| Villa owner        | The owner of a managed villa      | The owner portal only: their own units' calendar and statements. Nothing of the back office, and no guest names                  |

Things kept narrower than a role's general access:

- **Identity document numbers** are shown only on request, only to roles with
  that permission (front desk, managers, admins), and each viewing is recorded.
- **Refunds** take their own permission (accountant, managers).
- **Approving rate suggestions** takes its own permission (revenue, managers).
- **A copy of a guest's data, erasing a guest, the audit trail**: only for
  someone whose role covers every property (front desk or a manager for the
  copy; a manager for erasure; an accountant or a manager for the audit trail).
- The API checks the role against the property each request touches. Asking
  for another property's data by its id is refused, not silently filtered;
  another organisation's data answers "not found".

## Signing in

- **Passwords** are stored as scrypt hashes. A password must have at least ten
  characters and must not contain the person's own email name. Ten wrong
  passwords lock the account for fifteen minutes; sign-in attempts are also
  limited per network address.
- **Two-step sign-in** (authenticator app codes, with one-time recovery codes)
  can be switched on by each person and required for everyone by an
  administrator. A code cannot be used twice.
- **Single sign-on** through any OpenID Connect provider (Google Workspace,
  Microsoft Entra, Okta): Settings, Single sign-on. Only email addresses in
  the domains you list are let in, and an address the provider reports as
  unverified is refused. You choose whether someone signing in for the first
  time gets an account automatically, and with which role.
- **Sessions** are a random token in a cookie that scripts cannot read
  (`HttpOnly`), that is not sent on requests from other sites (`SameSite`),
  and that travels only over HTTPS in production. They last twelve hours
  (`SESSION_TTL_HOURS`). Disabling a user ends all their sessions at once;
  changing a password ends every session but the one it was changed from.
- **Requests from other websites** that try to act with a signed-in person's
  cookie are refused by their origin.
- **Invitations and password resets** are single-use links that expire.

## What is encrypted, and with what

In transit: everything, by the TLS proxy in front.

At rest, with `APP_ENCRYPTION_KEY` (AES-256-GCM, a fresh nonce each time):

- guests' identity document numbers and what they enter at online check-in;
- uploaded identity documents and message attachments, before they are written to disk;
- two-step sign-in seeds, single sign-on client secrets, mailbox passwords,
  webhook signing secrets.

Stored only as a one-way hash, so that even the database cannot give them
back: passwords, session tokens, API keys, invitation and reset links,
recovery codes.

The key can be changed without downtime: see
[Runbooks](runbooks.md#the-encryption-key-may-have-leaked). Encrypt the
database's disk and its backups as well; that is the hosting's job and is not
done by the application.

## Card data

None. Guests pay on the payment gateway's own page (Razorpay or Stripe), and
the gateway tells the PMS the outcome. Card numbers never pass through or
reach this system. Staff recording a card payment at the desk enter a slip
number or the last four digits; anything that looks like a full card number is
refused. Card details that booking sites hold for a reservation stay with the
channel manager and are not fetched.

## The audit trail

Every change is recorded: who (person, API key, booking site, the system
itself, or the assistant on someone's behalf), what, to what, when, and from
which address. Settings, Audit shows it, with filters.

The database refuses to change or delete an entry, whatever the application
asks. The single exception is erasing a guest, which removes their name from
the wording of entries about them and nothing else; who did what and when
stays as written.

## Guests' personal data

**What is kept**: name and contact details, stays, what they wrote and what
was written to them, identity details and documents where the law or the
property asks for them at check-in, and bills.

**How long**: you decide, under Settings, Organisation. The worker applies it
once a day:

- **Identity details**: erased so many days after departure. This removes the
  document number from the guest's profile, what was entered at online
  check-in, and the uploaded documents themselves.
- **The whole profile**: erased so many days after the guest's last stay, in
  the way described under "Erasure" below.
- Zero means "keep until removed by hand". Set these to what your registration
  rules require and no longer.

**A copy for the guest**: `GET /guests/<id>/export` returns everything held
about one guest: profile, stays, conversations, online check-in details,
invoice numbers, a list of documents. Taking it is recorded.

**Erasure**: `POST /guests/<id>/erase`.

- Removed: name, email, phone, address, date of birth, nationality, identity
  details, notes, preferences; all conversations with them; their documents;
  what they entered at online check-in; their name on reviews and in the
  audit trail.
- Kept, without a name: the stays themselves, with their dates, rooms and
  amounts, under "Former guest". The books and the statistics need them.
- Kept as issued: tax invoices. The law requires them to be kept unchanged
  for years, and that outranks a request to erase.
- Refused while the guest has a stay under way or to come.
- It cannot be undone.

**Who else receives guest data**:

| Receiver                                   | What                                                                    | When                          |
| ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------- |
| Booking sites, through the channel manager | Nothing about guests is sent out; their bookings come in                | Always                        |
| Payment gateway                            | Booking reference, amount, the guest's name, email and phone            | When a guest pays online      |
| WhatsApp, the mail server                  | The message and the recipient                                           | When a message is sent        |
| AI service, if one is configured           | See [AI features](ai.md): mostly nothing that names a guest             | Per feature                   |
| Webhook receivers of yours                 | Ids only, never names or contact details                                | When subscribed events happen |
| Villa owners                               | Dates, source and revenue of stays at their villa. Never a guest's name | In the owner portal           |

## Other protections worth knowing about

- **Guest links** (to pay, to see a booking, to check in online) are signed
  and tied to one reservation. They stop working two months after departure,
  and all links for a booking can be made to stop at once from the
  reservation. They are never written to the logs.
- **Uploads** are limited to photos and PDFs, judged by their content and not
  by what the sender calls them, and to 8 MB.
- **Addresses typed in by users** (calendar feeds to read, webhooks to call)
  cannot point into your own network in production.
- **Inbound webhooks** from the channel manager, the payment gateway, WhatsApp
  and mail services are each verified by signature or shared secret before
  anything in them is used.
- **Booking emails**: a change or cancellation is applied only when your mail
  server confirms who sent it.
- **Text from guests** (names, notes, messages, reviews, the content of
  emails) is treated as data wherever it is given to the AI service, with an
  instruction that it is never a command; and whatever the AI proposes still
  needs a person's confirmation.
- **Limits** on requests protect sign-in, the public booking routes and the AI
  routes.

## What is your job, not the software's

- Keeping `APP_ENCRYPTION_KEY`, the database password and the API keys of
  other services out of the repository and in a secrets store.
- TLS certificates (the bundled proxy does this), firewalling the database,
  encrypting disks and backups, copying backups off the machine.
- Deciding the retention periods, and telling guests what you keep and why.
- Reviewing who has which role, and disabling accounts when people leave.
- A written agreement with each processor you switch on (payment gateway,
  mail, WhatsApp, AI service, channel manager).
