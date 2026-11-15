# Facebook booking assistant

An automatic assistant for the Messenger chat of **Cao Bằng Travel Guide**'s Facebook Page. It answers
booking questions, takes bookings for motorbike rental, tour packages and Easy Rider trips, and
confirms them, in English and Vietnamese. The team follows along, confirms and takes over in a small
dashboard.

It talks to Facebook through Facebook's own official interface for Pages, the Messenger Platform.

## What it does

- **Answers questions**: prices, what is included, deposit and payment, cancellation terms, what to
  bring, where the company is and how to reach it, plus any questions and answers you add.
- **Takes a booking**: works out from the customer's messages what they want, asks for what is
  missing (service, model or tour, date, days, how many, name, phone, pick-up place), shows a
  summary with the price, and records the booking when the customer says yes.
- **Confirms it**: by itself where the settings give a price and a capacity and room is left on
  those days; otherwise the booking waits until a person confirms it in the dashboard, and the
  assistant then sends the confirmation with price, deposit and cancellation terms.
- **Calls a person** when the customer asks for one, when it fails to understand twice in a row,
  for cancellations and changes of existing bookings, for requests larger than you allow, and when
  a customer asks for their data to be deleted. It then stays silent in that chat. Photos and
  questions about discounts are flagged for the team while the assistant carries on.
- **Steps back** as soon as a person of the team writes in a chat, in the Page's inbox (Messenger,
  Meta Business Suite) or in the dashboard.

It only ever answers people who wrote to the Page. It has no function for writing to people first
or to many people at once, and Facebook's interface would not allow it either. It serves the Page;
chats of personal profiles cannot be automated through Facebook's interface.

## Try it without Facebook

```bash
pnpm install
pnpm demo
```

Open <http://127.0.0.1:3400>, sign in with the password `demo` (with a `.env` file in place: the
password set there), and write as a customer under **Try the assistant**. Bookings and chats show
up in the dashboard as they would for real. Try-out mode uses the sample prices in
`config/business.demo.ts` and a database that is emptied at each start.

`pnpm talk` does the same in the terminal, and `pnpm talk config/business.ts` with the company's own
settings.

## Going live

Four things, in this order.

### 1. Fill in the settings

`config/business.ts` holds the company, what can be booked, prices and terms. It ships with the
company's name, contacts, the 30% deposit and the cancellation terms from the printed agreements,
and **without prices, motorbike models, tours or capacities**, which only you know. Until they are
filled in, the assistant tells customers that the team will confirm the price, and every booking
waits for a person.

The file explains each value. The ones that decide how the assistant behaves:

| Value | Meaning |
| --- | --- |
| `options` | The choices inside a service: motorbike models, tours. With one option the assistant does not ask which. |
| `price` | VND per motorbike per day, per person (tours), or per passenger per day (Easy Rider). `null`: the team quotes. |
| `capacity` | How many can be out on the same day. `null`: not known, a person checks. |
| `autoConfirm` | `true`: the assistant confirms by itself while capacity is left. Needs a price and a capacity on every option. |
| `depositPercent` | Deposit asked for in the confirmation; `0` for none. |
| `payment.instructions` | For example the bank account for deposits. Empty: "our team will send the payment details". |
| `faq` | Your own questions and answers, found by keywords. |

The assistant checks the file when it starts and names the value that is wrong. `pnpm talk
config/business.ts` shows how it answers with your settings.

The sentences themselves are in `src/engine/wording/en.ts` and `vi.ts`.

### 2. Connect Facebook

Put three values from Facebook into `.env`, as described under
[Connecting Facebook](#connecting-facebook), then look them over:

```bash
pnpm fb:check
```

### 3. Start it

To try it from any computer, without an address of your own:

```bash
pnpm start --tunnel
```

To run it for real, give it a lasting address first ([A lasting address](#a-lasting-address)), then:

```bash
pnpm start
```

The dashboard is at <http://127.0.0.1:3400>. Write to the Page from a Facebook account that has a
role on the app, and the assistant answers.

- **Run one copy only.** A second start on the same machine stops with a message. A copy started
  elsewhere with the same values takes the Page's messages away from the first.
- Keep it running with a process manager (`pm2 start "pnpm start" --name booking-assistant`, or a
  systemd service with `Restart=always`).
- Everything it keeps is in `var/` (the database, `assistant.sqlite`). Back the folder up; never
  share it. `.env` holds the keys to the Page's chat: keep it on the machine that runs the
  assistant, and nowhere else.
- Switch off the Page's own automatic replies (instant reply, away message, frequently asked
  questions) in Meta Business Suite, or customers get two answers.

### 4. Open it to all customers

A new Facebook app only passes on messages from people who have a role on it. See
[Opening the assistant to all customers](#opening-the-assistant-to-all-customers).

## Connecting Facebook

### What you need from Facebook

Once, at <https://developers.facebook.com>:

1. A developer account, and an app with the use case **Engage with customers on Messenger from
   Meta**. Its number, shown at the top of the app's dashboard, is `FB_APP_ID`.
2. The app's secret: **App settings > Basic > App secret > Show** (Facebook asks for your password).
   This is `FB_APP_SECRET`.
3. A token for the Page: **Use cases > Messenger > Customize > Messenger API Settings > Generate
   access tokens**. Connect the Page there, leave every permission ticked, and press **Generate**.
   This is `FB_PAGE_ACCESS_TOKEN`. The person who does this must have full access to the Page.

Copy `.env.example` to `.env` and put the three values in, with a password for the dashboard:

```bash
cp .env.example .env
```

That is all Facebook's dashboard is needed for. **The assistant sets up the rest itself** each time
it starts: it tells Facebook the address to deliver the Page's messages to (the "webhook"), answers
Facebook's check of that address, and switches the Page on for the app. Nothing has to be entered
under "Configure webhooks" in Facebook's dashboard. It looks all of this over again every ten
minutes and repairs what it finds missing; Facebook switches a webhook off when its address did not
answer for an hour.

`pnpm fb:check` shows what is in `.env` and what Facebook has on record for it, and says what is
wrong in plain words. It changes nothing. If the token in `.env` is that of a person (from
Facebook's Graph API Explorer, for example), `pnpm fb:check --save-page-token` turns it into a token
of the Page that does not expire and saves it in `.env`.

The token of a Page made in the app's dashboard does not expire. It ends when the person who made
it changes their Facebook password, loses access to the Page, or removes the app. The dashboard
then shows "Not connected" with the reason; put a new token into `.env` and start again.

### The address Facebook calls

Facebook does not hold a connection open: it calls the assistant whenever something happens in the
Page's chats. The assistant therefore needs an address with HTTPS that is reachable from the
internet.

- **To try it out:** `pnpm start --tunnel` opens a free tunnel through Cloudflare (it needs the
  program `cloudflared`: `brew install cloudflared`) and registers the tunnel's address with
  Facebook. The address is a new one at every start and lasts only while the program runs. Not for
  real use.
- **For real:** set `PUBLIC_URL` in `.env`. See the next section.

Only what Facebook needs is open at that address: the webhook, which acts on nothing but what
carries Facebook's signature, and the [privacy notice](#privacy-notice-and-deleting-a-customers-data).
The dashboard is on another port and is not reachable through it.

## A lasting address

The program listens on two ports of the machine it runs on:

| Port | What | Who must reach it |
| --- | --- | --- |
| 3401 (`WEBHOOK_PORT`) | What Facebook calls, and the privacy notice | The internet, over HTTPS, at `PUBLIC_URL` |
| 3400 (`DASHBOARD_PORT`) | The dashboard | The team only |

Both listen on this machine only (`127.0.0.1`). Something has to stand in front of port 3401 that
has a name and a certificate. Two usual ways:

**A web server on a machine with a public address.** With [Caddy](https://caddyserver.com), which
gets the certificate by itself:

```
assistant.example.com {
    @facebook path /webhook /privacy
    reverse_proxy @facebook 127.0.0.1:3401
    # The dashboard under the same name, behind its password.
    # Leave this line out to keep the dashboard off the internet.
    reverse_proxy 127.0.0.1:3400
}
```

**A tunnel with a name of your own**, for a machine without a public address. With a domain at
Cloudflare ([their guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)):

```bash
cloudflared tunnel login
cloudflared tunnel create booking-assistant
cloudflared tunnel route dns booking-assistant assistant.example.com
cloudflared tunnel run --url http://127.0.0.1:3401 booking-assistant
```

Either way, in `.env`:

```
PUBLIC_URL=https://assistant.example.com
```

Where only one port can be opened (some hosting services), set `WEBHOOK_PORT` to the same number as
`DASHBOARD_PORT`: both are then served from that port, the dashboard behind its password. In a
container, set `DASHBOARD_HOST=0.0.0.0` and `WEBHOOK_HOST=0.0.0.0`.

To open the dashboard from a phone, it needs HTTPS in front of it as well (the Caddy lines above do
that); set `DASHBOARD_URL` to its address so that messages to the team can link to it.

## Opening the assistant to all customers

While the app is new ("in development"), Facebook passes on only the messages of people who have a
role on the app: its administrators, developers and testers (**App roles** in the app's dashboard).
That is enough to try everything. For every customer to be answered, Facebook wants three things:

1. **The app's details filled in** under App settings > Basic: an icon, a category, and
   - Privacy policy URL: `PUBLIC_URL` + `/privacy`
   - User data deletion, instructions URL: `PUBLIC_URL` + `/privacy#delete`

   Both are served by the assistant itself; see below. They must be reachable at a lasting address.
2. **`pages_messaging` approved for everyone** ("Advanced Access"): requested in the app's
   dashboard under App Review. Facebook asks for a description of what the app does and a screen
   recording of it answering; it may also ask to verify the business.
3. **The app published** ("Live").

Facebook's documentation is not of one mind on step 2. Its
[overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview)
says the review is "not required if you only send and receive messages for your own Facebook Page";
its pages on [webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks)
and [error codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)
say that customers without a role are only served once `pages_messaging` is reviewed. The way to
find out for this app: do steps 1 and 3, then have someone who has no role on the app write to the
Page. If the assistant answers, nothing more is needed. If it stays silent, or the dashboard shows
a message as "not sent" because the person has no role on the app, do step 2.

For the review, what the reviewers need to know is short:

> The app answers people who write to our own Facebook Page, [Page name]. Send "Hello" to the Page:
> it replies that it is an automatic booking assistant and lists what can be booked. Send
> "2 motorbikes for 3 days from tomorrow": it asks for the missing details, shows a summary and
> records the booking on "yes". Send "staff": it hands the chat to a person and stops answering.
> It never writes first, and only replies within 24 hours of a customer's message.

Two more things can be requested the same way, and neither is needed to start:

- **Human Agent**: lets people of the team write from the dashboard for 7 days after a customer's
  last message instead of 24 hours. Once approved, set `FB_HUMAN_AGENT_TAG=true`.
- **Business Asset User Profile Access**: lets the assistant read a customer's name from their
  profile. Without it, it takes the name from the Page's own list of chats, and asks the customer
  where that gives none.

## Facebook's 24-hour rule

Facebook lets a Page write to a customer through its interface for **24 hours after the customer's
last message**. Every new message from the customer starts the time anew.

The assistant answers within seconds, so its own answers are never affected. A person confirming a
booking the next day may be: the dashboard says so on the booking and on the chat before you press
anything. The step is still taken (the booking is confirmed), the message to the customer is kept
as "not sent" with the reason, and you tell the customer yourself:

- from the Page's inbox in Meta Business Suite or Messenger, where a person has 7 days; or
- by phone, WhatsApp or Zalo, with the number in the booking.

When the customer writes again, "Send again" on the kept message goes through.

## Other apps on the Page

- **The Page's own automatic replies** (instant reply, away message, frequently asked questions in
  Meta Business Suite): switch them off, or customers get two answers.
- **Meta Business AI**, where it is switched on for the Page, holds the chats itself. Facebook then
  delivers customers' messages to other apps marked as not theirs to answer, and refuses what they
  send. The assistant leaves such chats alone and says so on the status page. Switch Business AI
  off for the Page, or leave the Page to it.
- **Another app that answers** (a chat tool, a CRM): one of the two has to be the one that answers.
  The status page names every other app connected to the Page.

## Day to day

**Bookings.** "Waiting for you" lists bookings a person has to confirm. Open one, check the price
(or enter it, where the settings have none), and confirm or decline. The customer is told at once,
in their language; a reason you type is passed on as you wrote it. Confirmed bookings can be
cancelled the same way.

**Chats.** Chats that need a person come first, with the reason. Writing a reply takes the chat
over; the assistant stays out for 12 hours (`STAFF_PAUSE_HOURS`) or until you press "Hand back to
the assistant". The same happens when someone answers in the Page's inbox directly.

**Being told.** With `STAFF_THREAD_IDS` set, team members get a Messenger message from the Page for
each new booking and each chat that needs a person. The ids are the ones the dashboard shows for a
chat ("Facebook id"): a team member writes to the Page once and finds theirs under Chats. The
24-hour rule holds here too: Facebook passes these messages on only to someone who wrote to the
Page within the last 24 hours, so whoever wants them sends the Page a word each morning.

**While it was off.** Facebook tries a few more times to deliver what got no answer, so a quick
restart usually loses nothing. Messages that arrive during a longer stop are not answered when the
assistant starts again; they stay in the Page's inbox for the team.

### Privacy notice and deleting a customer's data

The assistant serves a privacy notice in English and Vietnamese at `PUBLIC_URL` + `/privacy`
(`src/public/privacy.ts`; in try-out mode at <http://127.0.0.1:3400/privacy>). It says what the
assistant keeps (messages, the name Facebook shows, booking details), what for, and how to have it
deleted. **Read it before you publish it**, and change it where the company does things otherwise.

It tells customers to write "delete my data" to the Page. The assistant then calls a person. Answer
the customer, then press **Delete this chat** on the chat's page: the messages, the name and what
the assistant remembered are removed for good. Bookings stay, as the company's records; the chat in
Messenger itself is not touched.

## What to know

- **Tried against Facebook as far as possible without the app's keys.** The conversation logic, the
  dashboard and every call to Facebook are covered by tests, with a stand-in that answers as
  Facebook's documentation describes. The program was run for real through a tunnel: a delivery
  signed the way Facebook signs was taken in and answered, unsigned ones were turned away, and
  Facebook's real servers refused made-up keys with the message the dashboard then showed. Run
  `pnpm fb:check` and write to the Page once before relying on it.
- **Facebook's interface changes by version.** The assistant speaks version `v27.0`
  (`FB_GRAPH_VERSION`). Facebook retires a version about two years after it appears; raise the
  number before then and run the tests.
- **English and Vietnamese only.** A customer writing in another language gets the welcome message
  in English and, at the second message, a person.
- **Vietnamese wording**, in the chat and in the privacy notice, was written with the English and
  has not been checked by a native speaker.
- **The dashboard** is in English.
- **An earlier version signed in with a browser session** instead of Facebook's interface, through
  an unofficial library. That was against Facebook's terms and has been removed. It is in the
  history of this repository (commit `e36ff92`) should it ever be wanted.

## Development

```bash
pnpm test          # unit and integration tests
pnpm typecheck
pnpm lint
pnpm format:check
```

`scripts/walkthrough.ts` drives the dashboard in a real browser against `pnpm demo` and saves a
screenshot of each step.

| Path | What |
| --- | --- |
| `config/` | The company's settings, and sample settings for try-out and tests |
| `src/nlu/` | Reading a message: language, dates, counts, what is asked, which service |
| `src/engine/` | What the assistant answers, and the wording in both languages |
| `src/bookings/` | Prices, room left on each day, the steps a booking goes through |
| `src/bot/` | Runs the assistant on a connection: one answer at a time per chat, takeover, telling the team |
| `src/transport/` | The connection: Facebook's Messenger Platform (`messenger.ts`, `graph.ts`), and a stand-in for try-out and tests |
| `src/public/` | What is open to the internet: the address Facebook calls, and the privacy notice |
| `src/admin/` | The dashboard |
| `src/cli/` | `pnpm fb:check` |
| `src/tunnel.ts` | The try-out tunnel behind `--tunnel` |
| `src/store/` | The database (SQLite) |
| `test/fake-facebook.ts` | The stand-in for Facebook that the tests talk to |
