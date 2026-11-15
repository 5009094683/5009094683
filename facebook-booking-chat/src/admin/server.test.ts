import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestClock, demoBusiness, memoryStore } from '../../test/helpers';
import { Bot } from '../bot/bot';
import { Desk } from '../bookings/desk';
import { Engine } from '../engine/engine';
import type { Store } from '../store';
import { SimulatorTransport } from '../transport/simulator';
import { buildDashboard } from './server';

const business = demoBusiness();
const PASSWORD = 'correct horse battery';

let store: Store;
let clock: TestClock;
let facebook: SimulatorTransport;
let desk: Desk;
let bot: Bot;
let app: FastifyInstance;
let cookie: string;

async function setUp(options: { tryOut?: boolean } = {}): Promise<void> {
  store = memoryStore();
  clock = new TestClock();
  facebook = new SimulatorTransport(clock.now);
  desk = new Desk(store, business, clock.now);
  bot = new Bot({
    transport: facebook,
    store,
    engine: new Engine(business, desk, store.bookings),
    business,
    options: { debounceMs: 0, typingMsPerChar: 0, minTypingMs: 0, maxTypingMs: 0 },
    now: clock.now,
  });
  await bot.start();
  app = await buildDashboard({
    business,
    store,
    desk,
    bot,
    transport: facebook,
    simulator: options.tryOut ? facebook : null,
    password: PASSWORD,
    staffThreads: 0,
    pauseHours: 12,
    now: clock.now,
  });
  cookie = await signIn();
}

async function signIn(password = PASSWORD): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/login', payload: { password } });
  const set = response.headers['set-cookie'];
  return String(Array.isArray(set) ? set[0] : (set ?? '')).split(';')[0]!;
}

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { cookie, ...headers } });

const post = (
  url: string,
  payload: Record<string, string> = {},
  headers: Record<string, string> = {},
) => app.inject({ method: 'POST', url, payload, headers: { cookie, ...headers } });

async function customer(threadId: string, text: string): Promise<void> {
  facebook.customerSays(threadId, text);
  await bot.settled();
}

/** A tour booking that waits for a person, made through the chat. */
async function waitingBooking(threadId = 'lan', name = 'Trần Thị Lan'): Promise<string> {
  facebook.names.set(threadId, name);
  await customer(threadId, 'book the waterfall tour for 2 people on 21/11');
  await customer(threadId, '0987 654 321');
  await customer(threadId, 'Sunny Hotel');
  await customer(threadId, 'yes');
  return store.bookings.ofThread(threadId)[0]!.code;
}

beforeEach(() => setUp());
afterEach(async () => {
  await app.close();
  await bot.stop();
});

describe('who may see the dashboard', () => {
  it('shows nothing without signing in', async () => {
    const anonymous = (url: string) => app.inject({ method: 'GET', url });
    for (const url of [
      '/',
      '/bookings',
      '/conversations',
      '/status',
      '/conversations/lan',
      '/nowhere',
    ]) {
      const response = await anonymous(url);
      expect([response.statusCode, response.headers.location], url).toEqual([302, '/login']);
    }
    expect((await anonymous('/api/summary')).statusCode).toBe(401);
    expect((await anonymous('/api/conversations/lan/messages')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/conversations/lan/reply',
          payload: { text: 'hi' },
        })
      ).statusCode,
    ).toBe(401);
    expect(facebook.sent).toHaveLength(0);

    expect((await anonymous('/login')).statusCode).toBe(200);
    expect((await anonymous('/assets/app.css')).headers['content-type']).toContain('text/css');
    expect((await anonymous('/healthz')).json()).toEqual({ ok: true, connection: 'connected' });
  });

  it('signs in with the password only, with a cookie scripts cannot read', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'guess' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('That is not the password.');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const right = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: PASSWORD },
    });
    expect(right.statusCode).toBe(303);
    expect(String(right.headers['set-cookie'])).toMatch(
      /assistant_session=.+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict/,
    );
    expect((await get('/bookings')).statusCode).toBe(200);
  });

  it('stops taking passwords after many wrong ones', async () => {
    for (let i = 0; i < 8; i += 1) {
      await app.inject({ method: 'POST', url: '/login', payload: { password: `guess ${i}` } });
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.body).toContain('Too many wrong passwords');

    clock.advance(10 * 60 * 1000 + 1);
    expect(
      (await app.inject({ method: 'POST', url: '/login', payload: { password: PASSWORD } }))
        .statusCode,
    ).toBe(303);
  });

  it('signs out, and a session ends by itself after twelve hours', async () => {
    await post('/logout');
    expect((await get('/bookings')).headers.location).toBe('/login');

    cookie = await signIn();
    expect((await get('/bookings')).statusCode).toBe(200);
    clock.advance(12 * 60 * 60 * 1000 + 1);
    expect((await get('/bookings')).headers.location).toBe('/login');
  });

  it('refuses a form sent from another site, even with the session cookie', async () => {
    await customer('lan', 'hello');
    const foreign = await post(
      '/conversations/lan/reply',
      { text: 'you won a prize' },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(foreign.statusCode).toBe(403);
    const otherOrigin = await post(
      '/conversations/lan/reply',
      { text: 'you won a prize' },
      { origin: 'https://evil.example', host: 'desk.example' },
    );
    expect(otherOrigin.statusCode).toBe(403);
    expect(facebook.sentTo('lan')).toHaveLength(1);

    const own = await post(
      '/conversations/lan/reply',
      { text: 'Hello from the team' },
      { 'sec-fetch-site': 'same-origin' },
    );
    expect(own.statusCode).toBe(303);
  });

  it('sends headers that keep the pages out of frames and scripts out of the pages', async () => {
    const response = await get('/bookings');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    // Nothing inline: the policy would block it, and nothing should need it.
    expect(response.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(response.body).not.toContain('style="');
  });
});

describe('bookings', () => {
  it('lists the bookings that wait, and shows one in full', async () => {
    const code = await waitingBooking();
    const list = await get('/bookings');
    expect(list.body).toContain(code);
    expect(list.body).toContain('Trần Thị Lan');
    expect(list.body).toContain('2,400,000 VND');
    expect(list.body).toMatch(/Waiting for you<span class="n">1<\/span>/);

    const detail = await get(`/bookings/${code}`);
    expect(detail.body).toContain('This booking waits for you');
    expect(detail.body).toContain('0987 654 321');
    expect(detail.body).toContain('Sunny Hotel');
    expect(detail.body).toContain('30% = 720,000 VND');
    expect(detail.body.replace(/\s+/g, ' ')).toContain(
      'With this booking, 10 of 12 stay free on those days.',
    );
    expect((await get('/bookings?status=confirmed')).body).toContain('No confirmed bookings yet.');
    expect((await get('/bookings/CB-NOPE1')).headers.location).toBe('/bookings');
  });

  it('confirms with the price given, tells the customer, and clears the flag', async () => {
    const code = await waitingBooking();
    expect(store.conversations.get('lan')!.needsStaff).toBe(true);

    const response = await post(`/bookings/${code}/confirm`, { total: '2.600.000' });
    expect(response.headers.location).toBe(`/bookings/${code}?n=confirmed`);
    expect(store.bookings.get(code)).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'staff',
      totalPrice: 2_600_000,
    });
    const told = facebook.sentTo('lan').at(-1)!;
    expect(told).toContain(`Your booking ${code} is confirmed.`);
    expect(told).toContain('Price: 2,600,000 VND');
    expect(told).toContain('Deposit: please pay 30% (780,000 VND)');
    expect(store.conversations.get('lan')!.needsStaff).toBe(false);
    expect((await get(response.headers.location as string)).body).toContain(
      'Confirmed. The customer has been told.',
    );
  });

  it('keeps the worked-out price when none is typed, and refuses one that is no number', async () => {
    const code = await waitingBooking();
    const bad = await post(`/bookings/${code}/confirm`, { total: 'about 2 million' });
    expect(bad.headers.location).toBe(`/bookings/${code}?n=bad-price`);
    expect(store.bookings.get(code)!.status).toBe('pending');

    await post(`/bookings/${code}/confirm`, { total: '' });
    expect(store.bookings.get(code)).toMatchObject({ status: 'confirmed', totalPrice: 2_400_000 });
  });

  it('declines and cancels with the reason passed on, and refuses a second go', async () => {
    const code = await waitingBooking();
    const declined = await post(`/bookings/${code}/decline`, {
      note: 'The road is closed that day.',
    });
    expect(declined.headers.location).toBe(`/bookings/${code}?n=declined`);
    expect(facebook.sentTo('lan').at(-1)).toContain(
      `we cannot take booking ${code}. The road is closed that day.`,
    );

    const again = await post(`/bookings/${code}/confirm`, { total: '' });
    expect(again.headers.location).toBe(`/bookings/${code}?n=wrong-state`);
    expect(store.bookings.get(code)!.status).toBe('declined');

    const second = await waitingBooking('ben', 'Ben Carter');
    await post(`/bookings/${second}/confirm`);
    const cancelled = await post(`/bookings/${second}/cancel`, { note: '' });
    expect(cancelled.headers.location).toBe(`/bookings/${second}?n=cancelled`);
    expect(facebook.sentTo('ben').at(-1)).toContain(`Your booking ${second} has been cancelled.`);
  });

  it('says so when the customer could not be told', async () => {
    const code = await waitingBooking();
    facebook.failSendsWith = 'Not connected to Facebook yet.';
    const response = await post(`/bookings/${code}/confirm`);
    expect(response.headers.location).toBe(`/bookings/${code}?n=confirmed-unsent`);
    expect(store.bookings.get(code)!.status).toBe('confirmed');
    const page = await get(`/conversations/lan`);
    expect(page.body).toContain('not sent: Not connected to Facebook yet.');
    expect(page.body).toContain('Send again');
  });
});

describe('chats', () => {
  it('lists chats, those that need a person first', async () => {
    await customer('anna', 'how much is a scooter?');
    clock.advance(60_000);
    await customer('marco', 'can I talk to a real person?');
    clock.advance(60_000);
    await customer('zoe', 'hello');

    const body = (await get('/conversations')).body;
    expect(body.indexOf('Customer marco')).toBeLessThan(body.indexOf('Customer zoe'));
    expect(body.indexOf('Customer zoe')).toBeLessThan(body.indexOf('Customer anna'));
    expect(body).toContain('The customer asked for a person.');
    expect(body).toContain('A person has this chat');
  });

  it('shows a chat with both sides, and what a person sends goes out', async () => {
    await customer('anna', 'how much is a scooter?');
    const before = (await get('/conversations/anna')).body;
    expect(before).toContain('how much is a scooter?');
    expect(before).toContain('Honda Vision (automatic): 200,000 VND');
    expect(before).toContain('The assistant answers in this chat.');

    const response = await post('/conversations/anna/reply', {
      text: 'Hi Anna, Hien here.\nShall I call you?',
    });
    expect(response.headers.location).toBe('/conversations/anna?n=sent');
    expect(facebook.sentTo('anna').at(-1)).toBe('Hi Anna, Hien here.\nShall I call you?');

    const after = (await get('/conversations/anna')).body;
    expect(after).toContain('Hi Anna, Hien here.<br>Shall I call you?');
    expect(after).toContain('A person has this chat.');
    await customer('anna', 'yes please');
    expect(facebook.sentTo('anna').at(-1)).toBe('Hi Anna, Hien here.\nShall I call you?');
  });

  it('takes a chat over, hands it back, and marks it as dealt with', async () => {
    await customer('anna', 'staff please');
    expect(store.conversations.get('anna')).toMatchObject({ mode: 'human', needsStaff: true });

    await post('/conversations/anna/handled');
    expect(store.conversations.get('anna')).toMatchObject({ mode: 'human', needsStaff: false });
    await post('/conversations/anna/hand-back');
    expect(store.conversations.get('anna')!.mode).toBe('bot');
    await post('/conversations/anna/take-over');
    expect(store.conversations.get('anna')).toMatchObject({ mode: 'human', pausedUntil: null });
    expect((await post('/conversations/nobody/take-over')).headers.location).toBe('/conversations');
  });

  it('sends a failed message again', async () => {
    facebook.failSendsWith = 'Not connected to Facebook yet.';
    await customer('anna', 'hello');
    const failed = store.messages.list('anna').find((m) => m.status === 'failed')!;
    expect((await post(`/messages/${failed.id}/resend`)).headers.location).toBe(
      '/conversations/anna?n=resend-failed',
    );

    facebook.failSendsWith = null;
    expect((await post(`/messages/${failed.id}/resend`)).headers.location).toBe(
      '/conversations/anna?n=resent',
    );
    expect(facebook.sentTo('anna')).toHaveLength(1);
  });

  it('deletes a chat for a customer who asks, and keeps the bookings', async () => {
    // A chat without a booking goes altogether.
    await customer('anna', 'how much is a scooter?');
    expect((await get('/conversations/anna')).body).toContain('Delete this chat');
    const gone = await post('/conversations/anna/delete');
    expect(gone.headers.location).toBe('/conversations?n=deleted');
    expect(store.conversations.get('anna')).toBeUndefined();
    expect(store.messages.list('anna')).toEqual([]);
    expect((await get('/conversations?n=deleted')).body).toContain('The chat has been deleted');

    // With a booking: the messages and the name go, the booking stays in the records.
    const code = await waitingBooking('lan', 'Trần Thị Lan');
    await post('/conversations/lan/delete');
    expect(store.messages.list('lan')).toEqual([]);
    expect(store.conversations.get('lan')).toMatchObject({
      customerName: null,
      state: {},
      mode: 'bot',
      needsStaff: false,
      lastCustomerAt: null,
    });
    expect(store.bookings.get(code)).toMatchObject({
      status: 'pending',
      customerName: 'Trần Thị Lan',
    });
    expect((await get(`/bookings/${code}`)).statusCode).toBe(200);

    // The customer may write again and is answered as someone new.
    await customer('lan', 'hello');
    expect(facebook.sentTo('lan').at(-1)).toContain('automatic booking assistant');
    expect((await post('/conversations/nobody/delete')).headers.location).toBe('/conversations');
  });

  it('says nothing of a time limit where the connection has none', async () => {
    const code = await waitingBooking();
    clock.advance(3 * 24 * 60 * 60 * 1000);
    cookie = await signIn();
    expect((await get(`/bookings/${code}`)).body).not.toContain('will not get a message from here');
    expect((await get('/conversations/lan')).body).toContain(
      'Your reply goes out through the Page',
    );
  });

  it('counts a chat as read once a person has opened it', async () => {
    await customer('anna', 'hello');
    expect(store.conversations.get('anna')!.unread).toBe(1);
    await get('/conversations/anna');
    expect(store.conversations.get('anna')!.unread).toBe(0);
  });

  it('never lets what a customer wrote become part of the page', async () => {
    facebook.names.set('eve', '<img src=x onerror=alert(1)>');
    await customer('eve', '<script>alert("hi")</script> "quoted" & more');
    for (const url of ['/conversations', '/conversations/eve']) {
      const body = (await get(url)).body;
      expect(body, url).not.toContain('<img src=x');
      expect(body, url).not.toContain('<script>alert');
      expect(body, url).toContain('&lt;img src=x onerror=alert(1)&gt;');
    }
    expect((await get('/conversations/eve')).body).toContain(
      '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt; &quot;quoted&quot; &amp; more',
    );
  });

  it('hands new messages to an open page, and says when lists have changed', async () => {
    await customer('anna', 'hello');
    const first = (await get('/api/conversations/anna/messages')).json().messages;
    expect(first.map((m: { sender: string }) => m.sender)).toEqual(['customer', 'bot']);
    expect(first[0]).toMatchObject({ text: 'hello', status: 'received', time: '15 Nov, 09:00' });

    const signature = (await get('/api/summary')).json().signature;
    await customer('anna', 'how much is a scooter?');
    const newer = (await get(`/api/conversations/anna/messages?after=${first[1].id}`)).json()
      .messages;
    expect(newer).toHaveLength(2);
    expect((await get('/api/summary')).json().signature).not.toBe(signature);
  });
});

describe('status and try-out', () => {
  it('shows the connection and what can be booked', async () => {
    const body = (await get('/status')).body;
    expect(body).toContain('Honda XR 150 (manual)');
    expect(body).toContain('400,000 VND');
    expect(body).toContain('You confirm');
    expect(body).toContain('Simulated page');
    expect(body).toContain('this dashboard only (no STAFF_THREAD_IDS set)');
  });

  it('has no try-out page when connected to Facebook', async () => {
    expect((await get('/try')).headers.location).toBe('/bookings');
    expect((await get('/bookings')).body).not.toContain('Try the assistant');
  });

  it('lets one write as a customer in try-out mode', async () => {
    await app.close();
    await bot.stop();
    await setUp({ tryOut: true });

    const page = await get('/try');
    expect(page.body).toContain('Try the assistant');
    const chat = String(page.headers['set-cookie']).match(/try_chat=(try-[a-z0-9]{8})/)![1]!;
    const cookies = `${cookie}; try_chat=${chat}`;

    const sent = await app.inject({
      method: 'POST',
      url: '/try/send',
      payload: { thread: chat, text: 'how much is a scooter?' },
      headers: { cookie: cookies },
    });
    expect(sent.statusCode).toBe(204);
    await bot.settled();
    expect(facebook.sentTo(chat)[0]).toContain('200,000 VND');
    expect(store.conversations.get(chat)!.customerName).toBe('Demo Customer');

    const other = await app.inject({
      method: 'POST',
      url: '/try/send',
      payload: { thread: 'lan', text: 'hello' },
      headers: { cookie: cookies },
    });
    expect(other.statusCode).toBe(409);

    const fresh = await app.inject({
      method: 'POST',
      url: '/try/new',
      payload: { name: 'Emma Wilson' },
      headers: { cookie: cookies },
    });
    const next = String(fresh.headers['set-cookie']).match(/try_chat=(try-[a-z0-9]{8})/)![1]!;
    expect(next).not.toBe(chat);
    expect(facebook.names.get(next)).toBe('Emma Wilson');
  });
});
