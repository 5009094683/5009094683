# AI features

What the smart features do, which of them need an AI service, what that
service is sent, and what stops any of it from acting on its own.

## Two kinds of feature

**Worked out by the PMS itself.** These need no AI service, send nothing
anywhere, and are always on:

| Feature                    | What it does                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rate suggestions           | For each night ahead, a suggested rate from how the night is selling against the property's usual pace                 |
| Reservations at risk       | A score for upcoming bookings likely to cancel or not show, with the reasons (unpaid, booked long ago, no contact ...) |
| Room suggestions           | Which room to give stays that have none, so that no unbookable one-night gaps are left                                 |
| Housekeeping forecast      | The cleaning work ahead, day by day                                                                                    |
| Unusual cancellation alert | An alert when a property loses far more bookings in a day than it normally does                                        |
| Review figures             | How many reviews, how happy, about what, where, and how it is moving                                                   |

**Helped by an AI service**, when one is configured. Each has a plainer
version that is used when no service is configured or when it fails, so no
screen depends on it:

| Feature                   | With an AI service                                                        | Without                                                         |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Assistant                 | Answers questions and prepares actions in plain language, in any language | Understands a fixed set of phrasings ("who arrives today", ...) |
| Reply suggestions (inbox) | A draft in the guest's language from the property's facts and the booking | A draft for common questions (check-in time, parking, wifi ...) |
| Reviews                   | Reads the text for mood and subjects; drafts a public reply               | Uses the scores and key words; a standard reply                 |
| Booking emails            | Reads a notice the built-in reader does not recognise                     | The email waits for a person under Channels, Needs attention    |
| ID capture                | Reads name, number and dates off a photo of an identity document          | Not available; details are typed in                             |

## Switching it on

```bash
ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY=...
AI_MODEL=                    # optional; a sensible default per service
AI_PROVIDER=                 # optional; only needed when both keys are set, or "none" to switch off
AI_DOCUMENT_CAPTURE_ENABLED=false
```

Restart the API and the worker. The assistant and the suggestions then say
"AI" instead of "built-in rules" under what they produce. Using the
assistant takes the `ai.use` permission, which administrators, general
managers, revenue managers and the front desk have. The assistant can never
see or do more than the person using it.

**ID capture is a separate switch**, off by default, because it sends
photographs of identity documents to the AI service. Switch it on only when
your agreement with that service and your privacy notice to guests allow it.

## What cannot happen

- **Nothing is changed without a person saying yes.** When the assistant is
  asked to do something (close dates, change a rate, make or cancel a
  reservation, mark rooms, write to a guest), it shows exactly what it would
  do and waits. The confirmation is valid for fifteen minutes, for the person
  who asked, once. The check that the person is allowed to do it, and that the
  room is still free, is made again at that moment by the same code the
  screens use.
- **The AI never talks to the database.** It can only ask for one of sixteen
  fixed operations, each of which checks the person's role and property first.
  It cannot see another property's data by asking for it.
- **Drafts are drafts.** Replies to guests and to reviews are put in the box
  for a person to edit and send. Nothing is sent or posted by itself.
- **What guests write is never taken as an instruction.** Names, notes,
  messages, reviews and emails are passed as data, with a standing instruction
  to ignore anything in them addressed to an AI. And if that failed, the worst
  outcome is a proposal that a person would have to confirm.
- **A reading is not a record.** What is read off an ID photo is shown to the
  front desk to check and save. A booking read from an unrecognised email is
  accepted only when its reference and dates come out clean, and is marked for
  staff to check.
- **Rates stay inside your limits.** See below.

## Rate suggestions

For every main rate plan and each of the next 120 nights, the PMS compares
what is sold with what is usually sold by that many days ahead (from the
property's own history once it has enough, a standard booking curve until
then), projects where the night will end up, and moves the rate with the
expected occupancy. Local events you enter, the last room, and unsold rooms
at the last minute adjust it.

- A suggestion is never more than a set share away from the plan's base rate
  (40% unless changed), is rounded (to ₹50 unless changed), and is never
  outside the plan's **floor** and **ceiling**.
- Differences under 3% are not suggested.
- Every suggestion lists its reasons with the weight each one had: "Expected
  to be 85% full", "Booking faster than usual for this far ahead", the name
  of the event, "Last room of this kind".
- Suggestions wait for someone with the `ai.pricing.approve` permission
  (revenue managers, general managers, administrators) to apply or dismiss,
  singly or together. Applying one is an ordinary rate change: it is in the
  audit trail and goes to the booking sites.
- **Autopilot** is off. It can be switched on per room type, and only for
  rate plans that have both a floor and a ceiling. Suggestions for those are
  then applied when they are made, once a night, and are marked as such in
  the audit trail.

No AI service is involved in pricing: the same inputs always give the same
suggestion, and the reasons shown are the actual ones.

## What the AI service is sent

Only what the feature in use needs, at the moment it is used:

| Feature           | Sent                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Assistant         | The person's question and the conversation so far; the results of what it looked up, which can include guests' names, booking codes, dates and amounts |
| Reply suggestions | The last twelve messages of the conversation; the property's public details; the booking's dates, room type and meal plan; the guest's first name      |
| Review reading    | The review's text and scores                                                                                                                           |
| Review reply      | The review's text and score, the property's name, the guest's first name                                                                               |
| Booking emails    | The subject and text of the one email that could not be read                                                                                           |
| ID capture        | The photograph. It is not kept by the PMS after the reading                                                                                            |

Never sent: guests' email addresses, phone numbers or identity numbers by any
feature other than the last two (where the email or the document itself
contains them); card data, which the PMS does not have; passwords, keys or
anything about your staff beyond the question asked.

What the service does with it is governed by your agreement with that
service. Both supported services state that data sent through their API is
not used to train their models by default; check the terms that apply to your
account.

## What is recorded

- Every call to the AI service: who, for which feature, which model, how many
  tokens, how long it took, whether it worked. Not the question and not the
  answer.
- Every action the assistant proposed, and whether it was confirmed, by whom
  and with what result, for 90 days.
- Everything that was actually changed, in the audit trail, as "the assistant
  on behalf of" the person.
- Calls, failures and tokens per feature over the last thirty days are
  available to administrators (`GET /ai/usage`).

## When it is not working

The AI routes answer with the built-in version when the service fails, and
say so under the result. With a bad key the assistant goes on answering its
fixed set of requests and adds what the service said ("The AI service refused
the request: ..."); the failed calls show in the usage figures. See
[Runbooks](runbooks.md) for what to check.
