import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Bot } from '../bot/bot';
import { type Availability, type Desk, BookingError } from '../bookings/desk';
import { type Business, findOption, findService } from '../business/schema';
import { PUBLIC_PATHS } from '../public/server';
import { type Booking, type BookingStatus, type Store, BOOKING_STATUSES } from '../store';
import type { SimulatorTransport } from '../transport/simulator';
import type { Transport } from '../transport/types';
import {
  type Chrome,
  type Notice,
  type Section,
  bookingPage,
  bookingsPage,
  conversationPage,
  conversationsPage,
  formatTime,
  loginPage,
  statusPage,
  tryPage,
} from './views';

export interface DashboardDeps {
  business: Business;
  store: Store;
  desk: Desk;
  bot: Bot;
  transport: Transport;
  /** Set in try-out mode: adds the page on which one writes as a customer. */
  simulator: SimulatorTransport | null;
  password: string;
  /** Shown on the status page. */
  staffThreads: number;
  pauseHours: number;
  /**
   * The part that is open to the internet (Facebook's calls, the privacy
   * notice), when it shares this port instead of having its own. Its paths
   * need no sign-in.
   */
  publicRoutes?: FastifyPluginAsync;
  now?: () => number;
  logger?: boolean | object;
}

const SESSION_COOKIE = 'assistant_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const NOTICES: Record<string, Notice> = {
  confirmed: { kind: 'ok', text: 'Confirmed. The customer has been told.' },
  declined: { kind: 'ok', text: 'Declined. The customer has been told.' },
  cancelled: { kind: 'ok', text: 'Cancelled. The customer has been told.' },
  'confirmed-unsent': {
    kind: 'warn',
    text: 'Confirmed, but the message to the customer could not be sent. Open the chat and send it again.',
  },
  'declined-unsent': {
    kind: 'warn',
    text: 'Declined, but the message to the customer could not be sent. Open the chat and send it again.',
  },
  'cancelled-unsent': {
    kind: 'warn',
    text: 'Cancelled, but the message to the customer could not be sent. Open the chat and send it again.',
  },
  'bad-price': {
    kind: 'bad',
    text: 'The total price must be a whole number of VND, for example 2400000. Nothing was changed.',
  },
  'wrong-state': {
    kind: 'bad',
    text: 'That is no longer possible: the booking has changed in the meantime. Nothing was changed.',
  },
  deleted: {
    kind: 'ok',
    text: 'The chat has been deleted: its messages and what the assistant remembered of it.',
  },
  sent: { kind: 'ok', text: 'Sent. The assistant stays out of this chat for now.' },
  unsent: {
    kind: 'bad',
    text: 'Your message could not be sent. It is marked in the chat; you can send it again.',
  },
  takeover: {
    kind: 'info',
    text: 'You have this chat. The assistant stays silent until you hand it back.',
  },
  handback: { kind: 'ok', text: 'The assistant answers in this chat again.' },
  handled: { kind: 'ok', text: 'Marked as dealt with.' },
  resent: { kind: 'ok', text: 'Sent again.' },
  'resend-failed': { kind: 'bad', text: 'It could not be sent this time either.' },
};

const asset = (name: string) => readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
}

export async function buildDashboard(deps: DashboardDeps): Promise<FastifyInstance> {
  const { business, store, desk, bot, transport, simulator } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });
  await app.register(cookie);
  await app.register(formbody);

  const css = asset('app.css');
  const js = asset('app.js');
  const sessions = new Map<string, number>();
  const failedLogins = new Map<string, { count: number; resetAt: number }>();
  const expected = digest(deps.password);

  // ------------------------------------------------------------- security

  function signedIn(request: FastifyRequest): boolean {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return false;
    const expires = sessions.get(token);
    if (expires === undefined) return false;
    if (expires < now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  /** A form may only be posted from this dashboard's own pages. */
  function fromOwnPage(request: FastifyRequest): boolean {
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string') return site === 'same-origin' || site === 'none';
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    // Facebook's calls and the privacy notice answer for themselves: they are
    // not part of the dashboard, and what Facebook sends is checked by its signature.
    if (deps.publicRoutes && PUBLIC_PATHS.includes(path)) return;

    void reply.headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (request.method !== 'GET' && request.method !== 'HEAD' && !fromOwnPage(request)) {
      return reply.code(403).send('This form was not sent from the dashboard.');
    }
    if (path === '/login' || path === '/healthz' || path.startsWith('/assets/')) return;
    if (signedIn(request)) return;
    if (path.startsWith('/api/') || request.method !== 'GET') {
      return reply.code(401).send({ error: 'Sign in again.' });
    }
    return reply.redirect('/login');
  });

  if (deps.publicRoutes) await app.register(deps.publicRoutes);

  /**
   * True when the service no longer lets a person of the team write to this
   * customer from here, because the customer's last message is too long ago.
   */
  function replyTimeIsOver(threadId: string): boolean {
    const window = transport.staffReplyWindowMs ?? transport.replyWindowMs;
    const lastCustomerAt = store.conversations.get(threadId)?.lastCustomerAt ?? null;
    return window !== undefined && lastCustomerAt !== null && now() - lastCustomerAt > window;
  }

  // ---------------------------------------------------------------- pages

  function chrome(current: Section, request: FastifyRequest): Chrome {
    const counts = store.bookings.counts();
    const needsStaff = store.conversations.countNeedingStaff();
    const code = (request.query as Record<string, string | undefined>).n;
    return {
      business,
      current,
      pending: counts.pending,
      needsStaff,
      connection: transport.status(),
      simulator: simulator !== null,
      signature: summarySignature(),
      notice: code ? (NOTICES[code] ?? null) : null,
    };
  }

  function summarySignature(): string {
    const counts = store.bookings.counts();
    return [
      counts.pending,
      counts.confirmed,
      counts.declined,
      counts.cancelled,
      store.conversations.countNeedingStaff(),
      store.messages.latestId(),
      transport.status().state,
    ].join('.');
  }

  const page = (reply: FastifyReply, body: string) =>
    reply.type('text/html; charset=utf-8').send(body);
  const back = (reply: FastifyReply, path: string, notice?: string) =>
    reply.redirect(notice ? `${path}?n=${notice}` : path, 303);

  app.get('/healthz', async () => ({ ok: true, connection: transport.status().state }));
  app.get('/assets/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(css),
  );
  app.get('/assets/app.js', async (_request, reply) =>
    reply.type('text/javascript; charset=utf-8').send(js),
  );

  app.get('/login', async (request, reply) => {
    if (signedIn(request)) return reply.redirect('/bookings');
    return page(reply, loginPage(business.company.name, null));
  });

  app.post('/login', async (request, reply) => {
    const attempts = failedLogins.get(request.ip);
    if (attempts && attempts.resetAt > now() && attempts.count >= LOGIN_ATTEMPTS) {
      return page(
        reply.code(429),
        loginPage(business.company.name, 'Too many wrong passwords. Try again in ten minutes.'),
      );
    }
    if (!timingSafeEqual(digest(field(request.body, 'password')), expected)) {
      const current =
        attempts && attempts.resetAt > now()
          ? attempts
          : { count: 0, resetAt: now() + LOGIN_WINDOW_MS };
      failedLogins.set(request.ip, { count: current.count + 1, resetAt: current.resetAt });
      return page(reply.code(401), loginPage(business.company.name, 'That is not the password.'));
    }
    failedLogins.delete(request.ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_MS);
    void reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      maxAge: SESSION_MS / 1000,
    });
    return back(reply, '/bookings');
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) sessions.delete(token);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return back(reply, '/login');
  });

  app.get('/', async (_request, reply) => reply.redirect('/bookings'));

  // -------------------------------------------------------------- bookings

  app.get('/bookings', async (request, reply) => {
    const asked = (request.query as Record<string, string | undefined>).status;
    const counts = store.bookings.counts();
    const status: BookingStatus | 'all' =
      asked === 'all'
        ? 'all'
        : BOOKING_STATUSES.includes(asked as BookingStatus)
          ? (asked as BookingStatus)
          : counts.pending > 0
            ? 'pending'
            : 'all';
    const bookings = store.bookings.list(status === 'all' ? undefined : status);
    return page(reply, bookingsPage(chrome('bookings', request), { status, bookings, counts }));
  });

  app.get('/bookings/:code', async (request, reply) => {
    const booking = store.bookings.get((request.params as { code: string }).code);
    if (!booking) return notFound(request, reply);

    const service = findService(business, booking.serviceId);
    const option = service ? findOption(service, booking.optionId) : undefined;
    let availability: Availability | null = null;
    if (option) {
      availability = desk.availability(
        booking.serviceId,
        booking.optionId,
        booking.startDate,
        booking.days,
        booking.quantity,
        booking.code,
      );
    }
    return page(
      reply,
      bookingPage(chrome('bookings', request), {
        booking,
        availability,
        capacity: option?.capacity ?? null,
        replyTimeOver: replyTimeIsOver(booking.threadId),
      }),
    );
  });

  /** Runs a step on a booking, tells the customer, and goes back to the booking. */
  async function bookingStep(
    request: FastifyRequest,
    reply: FastifyReply,
    step: (code: string) => Booking,
  ): Promise<FastifyReply> {
    const code = (request.params as { code: string }).code;
    let booking: Booking;
    try {
      booking = step(code);
    } catch (error) {
      if (!(error instanceof BookingError)) throw error;
      if (error.reason === 'not_found') return notFound(request, reply);
      return back(reply, `/bookings/${code}`, 'wrong-state');
    }
    const told = await bot.announce(booking);
    const conversation = store.conversations.get(booking.threadId);
    if (conversation?.needsStaffReason?.includes(booking.code)) {
      store.conversations.clearFlag(booking.threadId);
    }
    return back(
      reply,
      `/bookings/${booking.code}`,
      told ? booking.status : `${booking.status}-unsent`,
    );
  }

  app.post('/bookings/:code/confirm', async (request, reply) => {
    const raw = field(request.body, 'total').trim();
    let total: number | null = null;
    if (raw !== '') {
      const digits = raw.replace(/[\s.,]/g, '');
      if (!/^\d{1,12}$/.test(digits) || Number(digits) <= 0) {
        return back(reply, `/bookings/${(request.params as { code: string }).code}`, 'bad-price');
      }
      total = Number(digits);
    }
    return bookingStep(request, reply, (code) => desk.confirm(code, total));
  });

  app.post('/bookings/:code/decline', async (request, reply) =>
    bookingStep(request, reply, (code) => desk.decline(code, field(request.body, 'note'))),
  );

  app.post('/bookings/:code/cancel', async (request, reply) =>
    bookingStep(request, reply, (code) => desk.cancel(code, field(request.body, 'note'))),
  );

  // ----------------------------------------------------------------- chats

  app.get('/conversations', async (request, reply) =>
    page(reply, conversationsPage(chrome('conversations', request), store.conversations.list())),
  );

  app.get('/conversations/:threadId', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    if (!store.conversations.get(threadId)) return notFound(request, reply);
    store.conversations.markRead(threadId);
    return page(
      reply,
      conversationPage(chrome('conversations', request), {
        conversation: store.conversations.get(threadId)!,
        messages: store.messages.list(threadId),
        bookings: store.bookings.ofThread(threadId),
        pauseHours: deps.pauseHours,
        replyTimeOver: replyTimeIsOver(threadId),
      }),
    );
  });

  function chatStep(notice: string, step: (threadId: string) => void) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { threadId } = request.params as { threadId: string };
      if (!store.conversations.get(threadId)) return notFound(request, reply);
      step(threadId);
      return back(reply, `/conversations/${threadId}`, notice);
    };
  }

  app.post(
    '/conversations/:threadId/take-over',
    chatStep('takeover', (id) => bot.takeOver(id)),
  );
  app.post(
    '/conversations/:threadId/hand-back',
    chatStep('handback', (id) => bot.handBack(id)),
  );
  app.post(
    '/conversations/:threadId/handled',
    chatStep('handled', (id) => store.conversations.clearFlag(id)),
  );

  // A customer may ask for their data to be deleted (see the privacy notice).
  app.post('/conversations/:threadId/delete', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    if (!store.conversations.get(threadId)) return notFound(request, reply);
    bot.forget(threadId);
    return back(reply, '/conversations', 'deleted');
  });

  app.post('/conversations/:threadId/reply', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const text = field(request.body, 'text').trim();
    if (!store.conversations.get(threadId)) return notFound(request, reply);
    if (text === '') return back(reply, `/conversations/${threadId}`);
    const sent = await bot.sendAsStaff(threadId, text.slice(0, 5000));
    return back(reply, `/conversations/${threadId}`, sent ? 'sent' : 'unsent');
  });

  app.post('/messages/:id/resend', async (request, reply) => {
    const message = store.messages.get(Number((request.params as { id: string }).id));
    if (!message) return notFound(request, reply);
    const sent = await bot.resend(message.id);
    return back(reply, `/conversations/${message.threadId}`, sent ? 'resent' : 'resend-failed');
  });

  app.get('/api/conversations/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const after = Number((request.query as Record<string, string | undefined>).after ?? 0);
    const messages = store.messages.list(threadId, Number.isFinite(after) ? after : 0).map((m) => ({
      id: m.id,
      sender: m.sender,
      text: m.text,
      attachments: m.attachments,
      status: m.status,
      error: m.error,
      time: formatTime(m.createdAt, business.timezone),
    }));
    return { messages };
  });

  app.get('/api/summary', async () => ({ signature: summarySignature() }));

  // ---------------------------------------------------------------- status

  app.get('/status', async (request, reply) =>
    page(reply, statusPage(chrome('status', request), { staffThreads: deps.staffThreads })),
  );

  // ---------------------------------------------------------------- try it

  if (simulator) {
    const TRY_COOKIE = 'try_chat';
    const tryCookie = { path: '/', httpOnly: true, sameSite: 'strict' as const };

    const currentChat = (request: FastifyRequest): string | null => {
      const id = request.cookies[TRY_COOKIE];
      return id && /^try-[a-z0-9]{8}$/.test(id) ? id : null;
    };
    const startChat = (reply: FastifyReply, name: string): string => {
      const id = `try-${randomBytes(4).toString('hex')}`;
      simulator.names.set(id, name.trim().slice(0, 60) || 'Demo Customer');
      void reply.setCookie(TRY_COOKIE, id, tryCookie);
      return id;
    };

    app.get('/try', async (request, reply) => {
      const threadId = currentChat(request) ?? startChat(reply, 'Demo Customer');
      return page(
        reply,
        tryPage(chrome('try', request), {
          threadId,
          name: simulator.names.get(threadId) ?? 'Demo Customer',
          messages: store.messages.list(threadId),
        }),
      );
    });

    app.post('/try/new', async (request, reply) => {
      startChat(reply, field(request.body, 'name'));
      return back(reply, '/try');
    });

    app.post('/try/send', async (request, reply) => {
      const threadId = currentChat(request);
      const text = field(request.body, 'text').trim();
      if (!threadId || field(request.body, 'thread') !== threadId) {
        return reply.code(409).send({ error: 'Start a new chat first.' });
      }
      if (text !== '') simulator.customerSays(threadId, text.slice(0, 5000));
      return reply.code(204).send();
    });
  }

  // ---------------------------------------------------------------- errors

  function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
    return back(reply, request.url.startsWith('/conversations') ? '/conversations' : '/bookings');
  }

  app.setNotFoundHandler((request, reply) => {
    if (!signedIn(request)) return reply.redirect('/login');
    return reply.redirect('/bookings');
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply
      .code(status >= 400 && status < 600 ? status : 500)
      .type('text/plain; charset=utf-8')
      .send(
        status === 500
          ? 'Something went wrong. It has been written to the log.'
          : String((error as Error).message),
      );
  });

  return app;
}
