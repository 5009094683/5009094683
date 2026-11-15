import type { Availability } from '../bookings/desk';
import { depositOf, formatMoney } from '../bookings/pricing';
import type { Business } from '../business/schema';
import { bookingTitle } from '../engine/view';
import { formatDate } from '../nlu/dates';
import {
  type Booking,
  type BookingStatus,
  type Conversation,
  type ConversationSummary,
  type StoredMessage,
  BOOKING_STATUSES,
} from '../store';
import type { TransportStatus } from '../transport/types';
import { type Html, html, multiline } from './html';

export type Section = 'bookings' | 'conversations' | 'status' | 'try';

export interface Notice {
  kind: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

/** What every page shows around its own content. */
export interface Chrome {
  business: Business;
  current: Section;
  pending: number;
  needsStaff: number;
  connection: TransportStatus;
  simulator: boolean;
  /** Changes whenever something new has come in; lists reload when it does. */
  signature: string;
  notice: Notice | null;
}

const STATUS_WORDS: Record<BookingStatus, string> = {
  pending: 'Waiting for you',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

const CONNECTION_WORDS: Record<TransportStatus['state'], string> = {
  starting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Not connected',
  stopped: 'Stopped',
};

const SENDER_WORDS: Record<StoredMessage['sender'], string> = {
  customer: 'Customer',
  bot: 'Assistant',
  staff: 'Team',
};

export function formatTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function money(amount: number | null): string {
  return amount === null ? 'not set' : formatMoney(amount, 'en');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function quantityWord(booking: Booking): string {
  if (booking.serviceKind === 'rental') return plural(booking.quantity, 'motorbike', 'motorbikes');
  if (booking.serviceKind === 'tour') return plural(booking.quantity, 'person', 'people');
  return plural(booking.quantity, 'passenger', 'passengers');
}

function period(booking: Booking): string {
  const start = formatDate(booking.startDate, 'en');
  return booking.days === 1
    ? `${start} (1 day)`
    : `${start} to ${formatDate(booking.endDate, 'en')} (${booking.days} days)`;
}

function displayName(conversation: { customerName: string | null; threadId: string }): string {
  return conversation.customerName ?? `Customer ${conversation.threadId}`;
}

// ------------------------------------------------------------------ frame

function document(title: string, body: Html, company: string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${title} · ${company}</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        ${body}
        <script src="/assets/app.js" defer></script>
      </body>
    </html>`.text;
}

function page(chrome: Chrome, title: string, content: Html): string {
  const link = (section: Section, href: string, label: Html | string) =>
    html`<a href="${href}" class="${chrome.current === section ? 'current' : ''}">${label}</a>`;
  const state = chrome.connection.state;

  return document(
    title,
    html`<header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href="/bookings">
            ${chrome.business.company.name}
            <small>Booking assistant</small>
          </a>
          <nav class="nav">
            ${link(
              'bookings',
              '/bookings',
              html`Bookings
              ${chrome.pending > 0 && html`<span class="count">${chrome.pending}</span>`}`,
            )}
            ${link(
              'conversations',
              '/conversations',
              html`Chats
              ${chrome.needsStaff > 0 && html`<span class="count">${chrome.needsStaff}</span>`}`,
            )}
            ${link(
              'status',
              '/status',
              html`<span class="dot ${state}"></span>
                ${chrome.simulator ? 'Try-out mode' : CONNECTION_WORDS[state]}`,
            )}
            ${chrome.simulator && link('try', '/try', 'Try the assistant')}
          </nav>
          <form class="signout" method="post" action="/logout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <main>
        ${
          !chrome.simulator &&
          state === 'disconnected' &&
          html`<div class="banner bad">
            <span>
              <strong>The assistant is not connected to Facebook</strong> and answers nobody.
              ${chrome.connection.lastError}
            </span>
            <a class="button secondary" href="/status">Details</a>
          </div>`
        }
        ${chrome.notice && html`<div class="banner ${chrome.notice.kind}">${chrome.notice.text}</div>`}
        ${content}
      </main>`,
    chrome.business.company.name,
  );
}

export function loginPage(company: string, error: string | null): string {
  return document(
    'Sign in',
    html`<div class="login">
      <div class="card">
        <h1>${company}</h1>
        <p class="muted">Booking assistant</p>
        ${error && html`<div class="banner bad">${error}</div>`}
        <form method="post" action="/login">
          <div class="field">
            <label for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              autofocus
            />
          </div>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </div>`,
    company,
  );
}

// --------------------------------------------------------------- bookings

export function bookingsPage(
  chrome: Chrome,
  view: {
    status: BookingStatus | 'all';
    bookings: Booking[];
    counts: Record<BookingStatus, number>;
  },
): string {
  const timezone = chrome.business.timezone;
  const total = BOOKING_STATUSES.reduce((sum, status) => sum + view.counts[status], 0);
  const tab = (status: BookingStatus | 'all', label: string, n: number) =>
    html`<a href="/bookings?status=${status}" class="${view.status === status ? 'current' : ''}"
      >${label}<span class="n">${n}</span></a
    >`;

  const rows = view.bookings.map(
    (booking) =>
      html`<tr>
        <td class="nowrap">
          <a href="/bookings/${booking.code}"><strong>${booking.code}</strong></a>
        </td>
        <td><span class="pill ${booking.status}">${STATUS_WORDS[booking.status]}</span></td>
        <td class="wide">
          ${bookingTitle(booking, chrome.business)}<br /><span class="muted small"
            >${quantityWord(booking)}</span
          >
        </td>
        <td>${period(booking)}</td>
        <td class="nowrap">
          ${booking.customerName}${booking.phone && html`<br /><span class="muted small">${booking.phone}</span>`}
        </td>
        <td class="num nowrap">
          ${booking.totalPrice === null ? html`<span class="muted">to quote</span>` : money(booking.totalPrice)}
        </td>
        <td class="nowrap muted small">${formatTime(booking.createdAt, timezone)}</td>
      </tr>`,
  );

  const emptyText: Record<BookingStatus | 'all', string> = {
    pending: 'No booking is waiting for you.',
    confirmed: 'No confirmed bookings yet.',
    declined: 'No declined bookings.',
    cancelled: 'No cancelled bookings.',
    all: 'No bookings yet. They appear here as soon as a customer books in the chat.',
  };

  return page(
    chrome,
    'Bookings',
    html`<div class="head" data-watch="${chrome.signature}">
        <div>
          <h1>Bookings</h1>
          <p class="muted">
            Taken by the assistant in the chat. Confirm the ones that wait for you.
          </p>
        </div>
      </div>
      <div class="tabs">
        ${tab('pending', 'Waiting for you', view.counts.pending)}
        ${tab('confirmed', 'Confirmed', view.counts.confirmed)}
        ${tab('declined', 'Declined', view.counts.declined)}
        ${tab('cancelled', 'Cancelled', view.counts.cancelled)} ${tab('all', 'All', total)}
      </div>
      <div class="card flush">
        ${
          rows.length === 0
            ? html`<div class="empty">${emptyText[view.status]}</div>`
            : html`<div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Booking</th>
                      <th>State</th>
                      <th>Service</th>
                      <th>Dates</th>
                      <th>Customer</th>
                      <th class="num">Total</th>
                      <th>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows}
                  </tbody>
                </table>
              </div>`
        }
      </div>`,
  );
}

export function bookingPage(
  chrome: Chrome,
  view: {
    booking: Booking;
    availability: Availability | null;
    capacity: number | null;
    /** The customer's last message is too long ago for a message from here to reach them. */
    replyTimeOver: boolean;
  },
): string {
  const { booking } = view;
  const timezone = chrome.business.timezone;
  const deposit = depositOf(booking.totalPrice, booking.depositPercent);

  const tellYourself =
    view.replyTimeOver &&
    html`<div class="banner warn">
      <span>
        <strong>The customer will not get a message from here.</strong> Their last message is too
        long ago, and Facebook no longer lets the Page write to them from the dashboard. You can
        still take the step; then tell the customer yourself, from the Page’s inbox in Meta Business
        Suite${booking.phone ? ` or by phone (${booking.phone})` : ''}.
      </span>
    </div>`;

  let room: Html;
  if (view.availability === null) {
    room = html`<span class="muted">This service is no longer in the settings.</span>`;
  } else if (view.availability.state === 'unknown') {
    room = html`<span class="muted"
      >No capacity is set for this in the settings: check yourself that it is free.</span
    >`;
  } else if (view.availability.state === 'available') {
    room = html`With this booking, ${view.availability.left - booking.quantity} of ${view.capacity}
    stay free on those days.`;
  } else {
    room = html`<strong>Not enough room on those days:</strong> other bookings leave
      ${view.availability.left} of ${view.capacity} free, and this one needs ${booking.quantity}.`;
  }

  const confirmForm = html`<form method="post" action="/bookings/${booking.code}/confirm">
    <div class="field">
      <label for="total">Total price (VND)</label>
      <input
        id="total"
        name="total"
        type="text"
        inputmode="numeric"
        value="${booking.totalPrice === null ? '' : String(booking.totalPrice)}"
        placeholder="${booking.totalPrice === null ? 'for example 2400000' : ''}"
      />
      <p class="hint">
        ${
          booking.totalPrice === null
            ? 'No price is set for this in the settings. Enter the price you quote; the customer is told it.'
            : 'Worked out from the settings. Change it if you agreed another price.'
        }
      </p>
    </div>
    <button type="submit">Confirm and tell the customer</button>
  </form>`;

  const refuseForm = (action: 'decline' | 'cancel', label: string, ask: string) =>
    html`<form method="post" action="/bookings/${booking.code}/${action}" data-confirm="${ask}">
      <div class="field">
        <label for="${action}-note">Reason, as the customer will read it (optional)</label>
        <textarea
          id="${action}-note"
          name="note"
          rows="2"
          placeholder="${booking.lang === 'vi' ? 'Viết bằng tiếng Việt cho khách này' : 'Write it in English for this customer'}"
        ></textarea>
      </div>
      <button type="submit" class="danger">${label}</button>
    </form>`;

  let actions: Html;
  if (booking.status === 'pending') {
    actions = html`<h2>This booking waits for you</h2>
      ${tellYourself} ${confirmForm}
      <hr />
      ${refuseForm('decline', 'Decline and tell the customer', `Decline ${booking.code} and tell the customer?`)}`;
  } else if (booking.status === 'confirmed') {
    actions = html`<h2>
        Confirmed ${booking.confirmedBy === 'auto' ? 'by the assistant' : 'by the team'}
      </h2>
      <p class="muted">The customer has been told. If the booking falls through, cancel it here.</p>
      ${tellYourself}
      ${refuseForm('cancel', 'Cancel and tell the customer', `Cancel ${booking.code} and tell the customer?`)}`;
  } else {
    actions = html`<h2>${STATUS_WORDS[booking.status]}</h2>
      <p class="muted">
        Nothing more to do. ${booking.staffNote && html`Reason given: ${booking.staffNote}`}
      </p>`;
  }

  return page(
    chrome,
    `Booking ${booking.code}`,
    html`<div class="head">
        <div>
          <p class="small"><a href="/bookings">← All bookings</a></p>
          <h1>
            Booking ${booking.code}
            <span class="pill ${booking.status}">${STATUS_WORDS[booking.status]}</span>
          </h1>
        </div>
        <a class="button secondary" href="/conversations/${booking.threadId}">Open the chat</a>
      </div>
      <div class="columns">
        <div class="card">
          <dl class="facts">
            <dt>Service</dt>
            <dd>${bookingTitle(booking, chrome.business)}</dd>
            <dt>Dates</dt>
            <dd>${period(booking)}</dd>
            <dt>How many</dt>
            <dd>${quantityWord(booking)}</dd>
            <dt>Customer</dt>
            <dd>${booking.customerName}</dd>
            <dt>Phone</dt>
            <dd>${booking.phone ?? html`<span class="muted">not given</span>`}</dd>
            <dt>Pick-up / staying at</dt>
            <dd>${booking.pickup ?? html`<span class="muted">not given</span>`}</dd>
            <dt>Language</dt>
            <dd>${booking.lang === 'vi' ? 'Vietnamese' : 'English'}</dd>
            <dt>Total</dt>
            <dd>
              ${booking.totalPrice === null ? html`<span class="muted">to be quoted by you</span>` : money(booking.totalPrice)}
              ${
                booking.unitPrice !== null &&
                html`<span class="muted small">
                  (${money(booking.unitPrice)}
                  each${booking.serviceKind === 'tour' ? '' : ' per day'})</span
                >`
              }
            </dd>
            <dt>Deposit</dt>
            <dd>
              ${
                booking.depositPercent === 0
                  ? html`<span class="muted">none for this service</span>`
                  : html`${booking.depositPercent}%${deposit !== null && ` = ${money(deposit)}`}`
              }
            </dd>
            <dt>Room</dt>
            <dd>${room}</dd>
            <dt>Received</dt>
            <dd>${formatTime(booking.createdAt, timezone)}</dd>
            ${
              booking.updatedAt !== booking.createdAt &&
              html`<dt>Last change</dt>
                <dd>${formatTime(booking.updatedAt, timezone)}</dd>`
            }
          </dl>
        </div>
        <div class="card">${actions}</div>
      </div>`,
  );
}

// ---------------------------------------------------------- conversations

function conversationTags(conversation: Conversation): Html {
  return html`${
    conversation.needsStaff &&
    html`<span class="pill attention">${conversation.needsStaffReason ?? 'Needs you'}</span>`
  }
  ${
    conversation.mode === 'human'
      ? html`<span class="pill person">A person has this chat</span>`
      : html`<span class="pill assistant">Assistant answers</span>`
  }`;
}

export function conversationsPage(chrome: Chrome, conversations: ConversationSummary[]): string {
  const timezone = chrome.business.timezone;
  const rows = conversations.map((conversation) => {
    const name = displayName(conversation);
    const who = conversation.lastSender
      ? `${SENDER_WORDS[conversation.lastSender as StoredMessage['sender']]}: `
      : '';
    const at = conversation.lastMessageAt ?? conversation.createdAt;
    // Unread messages matter where a person is expected to read them; the
    // assistant has read and answered the rest.
    const waitingForPerson = conversation.needsStaff || conversation.mode === 'human';
    return html`<a class="convo" href="/conversations/${conversation.threadId}">
      <span class="avatar">${name.trim().charAt(0).toUpperCase()}</span>
      <span class="convo-main">
        <span class="convo-top">
          <span
            class="convo-name ${waitingForPerson && conversation.unread > 0 ? 'unread' : ''}"
            data-unread="${conversation.unread}"
            >${name}</span
          >
          <span class="muted small nowrap">${formatTime(at, timezone)}</span>
        </span>
        <span class="snippet"
          >${who}${(conversation.lastText ?? '').replace(/\s+/g, ' ').slice(0, 140) || '(no text)'}</span
        >
        <span class="tags">${conversationTags(conversation)}</span>
      </span>
    </a>`;
  });

  return page(
    chrome,
    'Chats',
    html`<div class="head" data-watch="${chrome.signature}">
        <div>
          <h1>Chats</h1>
          <p class="muted">
            Every chat the assistant has seen. Those that need a person come first.
          </p>
        </div>
      </div>
      <div class="card flush">
        ${
          rows.length === 0
            ? html`<div class="empty">No chats yet. They appear here when a customer writes.</div>`
            : rows
        }
      </div>`,
  );
}

export function messageBubble(message: StoredMessage, timezone: string, withResend: boolean): Html {
  const meta = [SENDER_WORDS[message.sender], formatTime(message.createdAt, timezone)];
  if (message.attachments > 0) meta.push('sent a photo, sticker or file');
  if (message.status === 'failed') meta.push(`not sent: ${message.error ?? 'error'}`);
  if (message.status === 'pending') meta.push('sending');
  return html`<div
    class="bubble ${message.sender} ${message.status === 'failed' ? 'failed' : ''}"
    data-id="${message.id}"
  >
    ${message.text === '' ? '(no text)' : multiline(message.text)}
    <span class="meta"
      >${meta.join(' · ')}
      ${
        withResend &&
        message.status === 'failed' &&
        html`<form class="inline" method="post" action="/messages/${message.id}/resend">
          · <button class="link" type="submit">Send again</button>
        </form>`
      }</span
    >
  </div>`;
}

export function conversationPage(
  chrome: Chrome,
  view: {
    conversation: Conversation;
    messages: StoredMessage[];
    bookings: Booking[];
    pauseHours: number;
    /** The customer's last message is too long ago for a message from here to reach them. */
    replyTimeOver: boolean;
  },
): string {
  const { conversation, messages, bookings } = view;
  const timezone = chrome.business.timezone;
  const id = conversation.threadId;
  const last = messages.filter((m) => m.status !== 'pending').at(-1)?.id ?? 0;

  const who =
    conversation.mode === 'human'
      ? html`<div class="banner info">
          <span>
            <strong>A person has this chat.</strong> The assistant stays silent
            ${
              conversation.pausedUntil === null
                ? 'until you hand the chat back.'
                : `until ${formatTime(conversation.pausedUntil, timezone)}, or until you hand the chat back.`
            }
          </span>
          <form method="post" action="/conversations/${id}/hand-back">
            <button type="submit" class="secondary">Hand back to the assistant</button>
          </form>
        </div>`
      : html`<div class="banner ok">
          <span><strong>The assistant answers in this chat.</strong></span>
          <form method="post" action="/conversations/${id}/take-over">
            <button type="submit" class="secondary">Take over</button>
          </form>
        </div>`;

  return page(
    chrome,
    displayName(conversation),
    html`<div class="head">
        <div>
          <p class="small"><a href="/conversations">← All chats</a></p>
          <h1>${displayName(conversation)}</h1>
          <p class="muted small">
            Facebook id ${id} · writes in ${conversation.lang === 'vi' ? 'Vietnamese' : 'English'}
          </p>
        </div>
      </div>
      ${
        conversation.needsStaff &&
        html`<div class="banner warn">
          <span><strong>Needs you:</strong> ${conversation.needsStaffReason}</span>
          <form method="post" action="/conversations/${id}/handled">
            <button type="submit" class="secondary">Mark as dealt with</button>
          </form>
        </div>`
      }
      ${who}
      <div class="columns">
        <div class="card flush">
          <div class="chat" data-chat="${id}" data-last="${last}">
            ${
              messages.length === 0
                ? html`<div class="empty">No messages yet.</div>`
                : messages.map((message) => messageBubble(message, timezone, true))
            }
          </div>
          <form class="reply" method="post" action="/conversations/${id}/reply">
            <div class="reply-row">
              <textarea
                name="text"
                rows="2"
                placeholder="Write to the customer…"
                required
                data-enter-sends
              ></textarea>
              <button type="submit">Send</button>
            </div>
            ${
              view.replyTimeOver
                ? html`<p class="hint warn-text">
                    The customer’s last message is too long ago: Facebook no longer lets the Page
                    write to them from here, and a reply will come back as not sent. Answer from the
                    Page’s inbox in Meta Business Suite, or by phone. Once the customer writes
                    again, replies from here go through again.
                  </p>`
                : html`<p class="hint">
                    Your reply goes out through the Page. The assistant then stays out of this chat
                    for ${view.pauseHours} hours, or until you hand it back.
                  </p>`
            }
          </form>
        </div>
        <div class="card">
          <h2>Bookings of this customer</h2>
          ${
            bookings.length === 0
              ? html`<p class="muted">None yet.</p>`
              : bookings.map(
                  (booking) =>
                    html`<p>
                      <a href="/bookings/${booking.code}"><strong>${booking.code}</strong></a>
                      <span class="pill ${booking.status}">${STATUS_WORDS[booking.status]}</span
                      ><br />
                      <span class="small muted"
                        >${bookingTitle(booking, chrome.business)} · ${period(booking)}</span
                      >
                    </p>`,
                )
          }
          <hr />
          <form
            method="post"
            action="/conversations/${id}/delete"
            data-confirm="Delete this chat? Its messages and what the assistant remembers of it are removed for good."
          >
            <p class="hint">
              For a customer who asks for their data to be deleted: removes the messages, the name
              and what the assistant remembers. Bookings stay in your records. The chat in Messenger
              itself is not touched.
            </p>
            <button type="submit" class="danger">Delete this chat</button>
          </form>
        </div>
      </div>`,
  );
}

// ----------------------------------------------------------------- status

export function statusPage(chrome: Chrome, view: { staffThreads: number }): string {
  const { connection, business } = chrome;
  const timezone = business.timezone;
  const kind = {
    page: 'Facebook Page',
    simulator: 'Simulated (no Facebook)',
  };

  const services = business.services.map((service) =>
    service.options.map(
      (option, i) =>
        html`<tr>
          <td>${i === 0 && html`<strong>${service.name.en}</strong>`}</td>
          <td>
            ${option.name.en}${
              option.days !== undefined &&
              html` <span class="muted small">· always ${plural(option.days, 'day', 'days')}</span>`
            }
          </td>
          <td class="num nowrap">
            ${option.price === null ? html`<span class="muted">team quotes</span>` : money(option.price)}
          </td>
          <td class="num">${option.capacity ?? html`<span class="muted">not set</span>`}</td>
          <td class="nowrap">${service.autoConfirm ? 'Assistant confirms' : 'You confirm'}</td>
          <td class="num">
            ${service.depositPercent > 0 ? `${service.depositPercent}%` : html`<span class="muted">none</span>`}
          </td>
        </tr>`,
    ),
  );

  return page(
    chrome,
    'Status',
    html`<div class="head">
        <div>
          <h1>Status</h1>
          <p class="muted">
            The connection to Facebook, and the settings the assistant works from.
          </p>
        </div>
      </div>
      <div class="card">
        <h2>Connection</h2>
        <dl class="facts">
          <dt>State</dt>
          <dd>
            <span class="dot ${connection.state}"></span>
            <strong
              >${chrome.simulator ? 'Try-out mode' : CONNECTION_WORDS[connection.state]}</strong
            >
            <span class="muted">since ${formatTime(connection.since, timezone)}</span>
          </dd>
          <dt>Answers as</dt>
          <dd>
            ${
              connection.account === null
                ? html`<span class="muted">not signed in</span>`
                : html`${connection.account.name ?? 'Name not available'}
                    <span class="muted"
                      >· ${kind[connection.account.kind]} · id ${connection.account.id}</span
                    >`
            }
          </dd>
          ${
            connection.lastError &&
            html`<dt>Problem</dt>
              <dd>${connection.lastError}</dd>`
          }
          <dt>Last message in</dt>
          <dd>
            ${
              connection.lastMessageAt === null
                ? html`<span class="muted">none since the start</span>`
                : formatTime(connection.lastMessageAt, timezone)
            }
          </dd>
          ${(connection.details ?? []).map(
            (detail) =>
              html`<dt>${detail.label}</dt>
                <dd>${detail.value}</dd>`,
          )}
          <dt>Team is told on</dt>
          <dd>
            ${
              view.staffThreads === 0
                ? html`<span class="muted">this dashboard only (no STAFF_THREAD_IDS set)</span>`
                : html`${plural(view.staffThreads, 'Messenger chat', 'Messenger chats')} and this
                  dashboard
                  ${
                    !chrome.simulator &&
                    html`<br /><span class="muted small"
                        >Facebook passes these on only to team members who wrote to the Page within
                        the last 24 hours.</span
                      >`
                  }`
            }
          </dd>
        </dl>
        ${(connection.notes ?? []).map((note) => html`<div class="banner warn">${note}</div>`)}
        ${
          chrome.simulator &&
          html`<hr />
            <p class="muted">
              Nothing is sent to Facebook in try-out mode. Write as a customer under
              <a href="/try">Try the assistant</a>.
            </p>`
        }
      </div>
      <div class="card flush">
        <div class="card-head">
          <h2>What can be booked</h2>
          <p class="muted small">
            From ${business.company.name}'s settings file. To change prices, capacity or who
            confirms, edit the file and restart the assistant.
          </p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Option</th>
                <th class="num">Price</th>
                <th class="num">Capacity</th>
                <th>Confirmation</th>
                <th class="num">Deposit</th>
              </tr>
            </thead>
            <tbody>
              ${services}
            </tbody>
          </table>
        </div>
      </div>`,
  );
}

// ----------------------------------------------------------------- try it

export function tryPage(
  chrome: Chrome,
  view: { threadId: string; name: string; messages: StoredMessage[] },
): string {
  const timezone = chrome.business.timezone;
  const last = view.messages.filter((m) => m.status !== 'pending').at(-1)?.id ?? 0;
  return page(
    chrome,
    'Try the assistant',
    html`<div class="head">
        <div>
          <h1>Try the assistant</h1>
          <p class="muted">
            Write as a customer would on Messenger. Bookings made here show under Bookings, the chat
            under Chats.
          </p>
        </div>
        <form method="post" action="/try/new" class="actions">
          <input
            type="text"
            name="name"
            value="${view.name}"
            aria-label="Customer name"
            class="name-input"
          />
          <button type="submit" class="secondary">Start a new chat</button>
        </form>
      </div>
      <div class="phone">
        <div class="card flush">
          <div class="chat" data-chat="${view.threadId}" data-last="${last}">
            ${
              view.messages.length === 0
                ? html`<div class="empty">
                    Say hello, or ask for “2 motorbikes for 3 days from tomorrow”.
                  </div>`
                : view.messages.map((message) => messageBubble(message, timezone, false))
            }
          </div>
          <form class="reply" method="post" action="/try/send" data-try>
            <input type="hidden" name="thread" value="${view.threadId}" />
            <div class="reply-row">
              <textarea
                name="text"
                rows="1"
                placeholder="Message as ${view.name}…"
                required
                autofocus
                data-enter-sends
              ></textarea>
              <button type="submit">Send</button>
            </div>
          </form>
        </div>
      </div>`,
  );
}
