# Facebook booking assistant

An automatic assistant for the Messenger chat of **Cao Bằng Travel Guide**'s Facebook Page. It answers
booking questions, takes bookings for motorbike rental, tour packages and Easy Rider trips, and
confirms them, in English and Vietnamese. The team follows along, confirms and takes over in a small
dashboard.

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
  for cancellations and changes of existing bookings, and for requests larger than you allow. It
  then stays silent in that chat. Photos and questions about discounts are flagged for the team
  while the assistant carries on.
- **Steps back** as soon as a person of the team writes in a chat, in Messenger or in the dashboard.

It only ever answers people who wrote to the Page. It has no function for writing to people first
or to many people at once.

## Try it without Facebook

```bash
pnpm install
pnpm demo
```

Open <http://127.0.0.1:3400>, sign in with the password `demo`, and write as a customer under
**Try the assistant**. Bookings and chats show up in the dashboard as they would for real. Try-out
mode uses the sample prices in `config/business.demo.ts` and a database that is emptied at each start.

`pnpm talk` does the same in the terminal, and `pnpm talk config/business.ts` with the company's own
settings.

## Going live

Three things are needed, in this order.

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

See [Connecting Facebook](#connecting-facebook) below, then make sure it works:

```bash
pnpm fb:check --reply
```

### 3. Start it

```bash
cp .env.example .env      # then set DASHBOARD_PASSWORD in it
pnpm start
```

The dashboard is at <http://127.0.0.1:3400>.

- **Run one copy only.** Two copies answer every customer twice. A second start on the same
  machine stops with a message.
- Keep it running with a process manager (`pm2 start "pnpm start" --name booking-assistant`, or a
  systemd service with `Restart=always`).
- Everything it keeps is in `var/`: the database (`assistant.sqlite`) and the session file. Back
  the folder up; never share it.
- The dashboard listens on this machine only. To open it from a phone, put a web server with HTTPS
  in front of it (Caddy: `desk.example.com { reverse_proxy 127.0.0.1:3400 }`) and set `DASHBOARD_URL`.
- Switch off the Page's own automatic replies (instant reply, away message) in Meta Business
  Suite, or customers get two answers.

## Connecting Facebook

### Why not Facebook's official interface

The request was to use the official interface only if it could be had in one click. It cannot.
Facebook's Messenger Platform needs a Meta developer account, an app with the Messenger use case,
an access token for the Page, and a web address with HTTPS that Facebook can call; it works for
Pages only, never for personal profiles. (Meta's
[overview](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview)
says App Review is not required when the app only serves your own Page; this was not tried.)

So the assistant connects the other way: it signs in with the cookies of a browser session and
talks to Messenger as the website does, through the open-source library
[ws3-fca](https://www.npmjs.com/package/ws3-fca). Read [What to know](#what-to-know) before relying
on it. The rest of the program does not depend on how it is connected (`src/transport/types.ts`),
so the official interface can be added later without touching the rest.

### Use the Page, not a personal profile

Facebook encrypts chats between personal profiles end to end, and this connection cannot read
them. Chats with a Page are not encrypted that way. Customers should write to the Page, and the
session must be exported while the browser is switched into the Page.

### Export the session

1. Open a **new private window** (or a separate browser profile) and sign in to Facebook with an
   account that manages the Page.
2. Switch into the Page: profile picture at the top right, then the Page's name.
3. Export the cookies of `facebook.com` as JSON, with a cookie export extension such as
   Cookie-Editor ("Export", "JSON").
4. Save the result as `var/facebook-session.json`.
5. Close the window **without signing out**. Signing out ends the session, and the file with it.

The file is a login to the company's account. Keep it on the machine that runs the assistant, and
nowhere else. The assistant writes Facebook's renewed cookies back into it as it runs.

### Check it

`pnpm fb:check` signs in, tells you whether it is signed in as the Page, waits for a message (send
one to the Page from another account), and shows it. With `--reply` it also answers that message
with a test line, and tells you if `FB_SEND_VIA` should be changed.

When Facebook ends the session (after a password change, a security check, or with time), the
dashboard shows "Not connected" with the reason. Export a fresh file over the old one; the
assistant picks it up at its next attempt, without a restart.

## Day to day

**Bookings.** "Waiting for you" lists bookings a person has to confirm. Open one, check the price
(or enter it, where the settings have none), and confirm or decline. The customer is told at once,
in their language; a reason you type is passed on as you wrote it. Confirmed bookings can be
cancelled the same way.

**Chats.** Chats that need a person come first, with the reason. Writing a reply takes the chat
over; the assistant stays out for 12 hours (`STAFF_PAUSE_HOURS`) or until you press "Hand back to
the assistant". The same happens when someone answers in Messenger or Meta Business Suite directly.

**Being told.** With `STAFF_THREAD_IDS` set, team members get a Messenger message for each new
booking and each chat that needs a person.

**While it was off.** Messages that arrive while the assistant is not running are not answered
when it starts again. They stay unread in the Page's inbox for the team.

## What to know

- **Not tried against Facebook.** No Facebook account was available while this was built. The
  conversation logic, the dashboard and the handling of the client library are covered by tests,
  and the library was run for real as far as a rejected session. Whether signing in, receiving
  and sending work with your Page today is what `pnpm fb:check --reply` is for; run it before
  anything else.
- **Against Facebook's terms.** Automating an account this way is not permitted by Facebook.
  Accounts doing it can be asked to verify themselves, be restricted or be closed, and that would
  hit the profile that manages the Page. The assistant keeps a low profile (it only answers, at a
  human pace, with a cap per chat), which lowers the risk and does not remove it.
- **It can break without warning.** The library imitates the website; when Facebook changes the
  website, it stops working until the library is updated.
- **The client library.** It is a small community project, and it holds the login to the account.
  An earlier release (2025) was reported to make accounts follow and share its author's pages. The
  release used here, 3.5.2, was checked for this project: its code names no address but Facebook's
  own, runs no downloaded code, and follows or shares nothing by itself. The version is pinned,
  with its checksum in the lockfile, for that reason. Check a new release the same way before
  moving to it.
- **Known weaknesses.** `pnpm audit` reports two denial-of-service problems in the old WebSocket
  package (`ws` 3) the library uses for the live connection. They can only be triggered by the
  server it connects to, which is Facebook's. Other outdated packages the library asks for are
  replaced by current ones (`pnpm-workspace.yaml`).
- **English and Vietnamese only.** A customer writing in another language gets the welcome message
  in English and, at the second message, a person.
- **Vietnamese wording** was written with the English and has not been checked by a native speaker.
- **The dashboard** is in English.

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
| `src/transport/` | The connection: Facebook, and a stand-in for try-out and tests |
| `src/admin/` | The dashboard |
| `src/store/` | The database (SQLite) |
