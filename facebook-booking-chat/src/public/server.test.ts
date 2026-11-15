import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeFacebook, PAGE_INBOX_APP_ID } from '../../test/fake-facebook';
import { TestClock, demoBusiness, memoryStore } from '../../test/helpers';
import { buildDashboard } from '../admin/server';
import { Bot } from '../bot/bot';
import { Desk } from '../bookings/desk';
import { Engine } from '../engine/engine';
import type { Store } from '../store';
import { MessengerTransport } from '../transport/messenger';
import { buildPublicServer, publicRoutes } from './server';

/*
  The whole way a message takes with the official connection: Facebook calls
  the webhook, the assistant works out the answer, and the answer goes back
  to Facebook. Only Facebook itself is a stand-in.
*/

const business = demoBusiness();
const ADDRESS = 'https://assistant.example.com';
const HOUR = 60 * 60 * 1000;
const PASSWORD = 'correct horse battery';

let facebook: FakeFacebook;
let clock: TestClock;
let store: Store;
let desk: Desk;
let messenger: MessengerTransport;
let bot: Bot;
let app: FastifyInstance;
let warnings: string[];

async function setUp(build?: () => Promise<FastifyInstance>): Promise<void> {
  facebook = new FakeFacebook();
  clock = new TestClock();
  store = memoryStore();
  warnings = [];
  messenger = new MessengerTransport({
    appId: facebook.appId,
    appSecret: facebook.appSecret,
    pageAccessToken: facebook.pageToken,
    publicUrl: ADDRESS,
    graphVersion: facebook.version,
    fetch: facebook.fetch,
    now: clock.now,
    sleep: async () => undefined,
    checkEveryMs: HOUR,
    retryDelaysMs: [HOUR],
  });
  desk = new Desk(store, business, clock.now);
  bot = new Bot({
    transport: messenger,
    store,
    engine: new Engine(business, desk, store.bookings),
    business,
    options: { debounceMs: 0, typingMsPerChar: 0, minTypingMs: 0, maxTypingMs: 0 },
    now: clock.now,
  });
  app = build
    ? await build()
    : await buildPublicServer({
        business,
        messenger,
        now: clock.now,
        log: { warn: (_details, message) => warnings.push(message) },
      });

  // Facebook calls an address before it accepts it. Here it calls the real routes.
  facebook.verifyCallback = async (url, word) => {
    const path = new URL(url).pathname;
    const response = await app.inject({
      method: 'GET',
      url: `${path}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(word)}&hub.challenge=1158201444`,
    });
    return response.statusCode === 200 && response.body === '1158201444';
  };
  await bot.start();
}

/** Facebook delivers: the bytes as it sends them, with its signature unless told otherwise. */
function deliver(payload: unknown, headers: Record<string, string> = {}) {
  const bytes = FakeFacebook.bytes(payload);
  return app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': facebook.sign(bytes),
      ...headers,
    },
    payload: bytes,
  });
}

/** A customer writes to the Page, and the test waits until the assistant has dealt with it. */
async function customer(psid: string, text: string): Promise<string[]> {
  const before = facebook.sentTo(psid).length;
  const response = await deliver(facebook.customerWrites(psid, text));
  expect(response.statusCode).toBe(200);
  await bot.settled();
  return facebook.sentTo(psid).slice(before);
}

beforeEach(() => setUp());
afterEach(async () => {
  await app.close();
  await bot.stop();
});

describe('from Facebook to the assistant and back', () => {
  it('passes Facebook\u2019s check of the address and is connected', () => {
    expect(messenger.status()).toMatchObject({ state: 'connected', lastError: null });
    expect(facebook.subscription).toMatchObject({
      callback_url: `${ADDRESS}/webhook`,
      active: true,
    });
  });

  it('answers a customer who writes to the Page', async () => {
    facebook.chats.set('42', 'Anna Müller');
    const response = await deliver(facebook.customerWrites('42', 'Hello'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('EVENT_RECEIVED');
    await bot.settled();

    expect(facebook.sentTo('42')).toHaveLength(1);
    expect(facebook.sentTo('42')[0]).toContain('automatic booking assistant');
    expect(facebook.sent[0]).toMatchObject({ messagingType: 'RESPONSE', tag: null });
    expect(facebook.actions).toContainEqual({ to: '42', action: 'mark_seen' });
    expect(store.conversations.get('42')).toMatchObject({
      customerName: 'Anna Müller',
      mode: 'bot',
    });
    expect(
      store.messages.list('42').map((m) => [m.sender, m.status, m.externalId !== null]),
    ).toEqual([
      ['customer', 'received', true],
      ['bot', 'sent', true],
    ]);
  });

  it('takes a booking in Vietnamese and tells the customer when a person confirms it', async () => {
    facebook.chats.set('42', 'Trần Thị Lan');
    const [first] = await customer('42', 'Cho mình đặt tour thác Bản Giốc cho 2 người ngày 21/11');
    expect(first).toContain('Xin chào');
    await customer('42', '0987 654 321');
    const [summary] = await customer('42', 'Khách sạn Sunny');
    expect(summary).toContain('Trần Thị Lan');
    await customer('42', 'đúng rồi');

    const booking = store.bookings.ofThread('42')[0]!;
    expect(booking).toMatchObject({
      status: 'pending',
      quantity: 2,
      startDate: '2026-11-21',
      lang: 'vi',
    });

    expect(await bot.announce(desk.confirm(booking.code, null))).toBe(true);
    expect(facebook.sentTo('42').at(-1)).toContain(booking.code);
    expect(facebook.sent.at(-1)).toMatchObject({ messagingType: 'RESPONSE' });
  });

  it('answers once what Facebook delivers twice', async () => {
    const delivery = facebook.customerWrites('42', 'Hello', { mid: 'm_same' });
    expect((await deliver(delivery)).statusCode).toBe(200);
    expect((await deliver(delivery)).statusCode).toBe(200);
    await bot.settled();
    expect(facebook.sentTo('42')).toHaveLength(1);
  });

  it('goes on after its own message comes back, and steps back when a person answers in the inbox', async () => {
    await customer('42', 'how much is a scooter?');
    const own = facebook.sent.at(-1)!;
    await deliver(facebook.pageWrote('42', own.text, facebook.appId, own.messageId));
    await bot.settled();
    expect(store.conversations.get('42')!.mode).toBe('bot');
    expect(await customer('42', 'and for 3 days?')).toHaveLength(1);

    await deliver(facebook.pageWrote('42', 'Hi, Hien here. I will call you.', PAGE_INBOX_APP_ID));
    await bot.settled();
    expect(store.conversations.get('42')!.mode).toBe('human');
    expect(store.messages.list('42').at(-1)).toMatchObject({
      sender: 'staff',
      text: 'Hi, Hien here. I will call you.',
    });
    expect(await customer('42', 'ok thank you')).toEqual([]);
  });

  it('flags a photo for the team and keeps answering', async () => {
    const image = { type: 'image', payload: { url: 'https://cdn.example/passport.jpg' } };
    await deliver(facebook.customerWrites('42', '', { attachments: [image] }));
    await bot.settled();
    expect(store.conversations.get('42')).toMatchObject({
      needsStaff: true,
      needsStaffReason: 'The customer sent a photo, sticker or file.',
      mode: 'bot',
    });
    expect(facebook.sentTo('42')).toHaveLength(1);
  });
});

describe('who may call the webhook', () => {
  it('turns away what Facebook did not sign', async () => {
    const payload = facebook.customerWrites('42', 'Hello');
    const bytes = FakeFacebook.bytes(payload);
    const post = (headers: Record<string, string>, body = bytes) =>
      app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });

    expect((await post({})).statusCode).toBe(401);
    expect((await post({ 'x-hub-signature-256': 'sha256=0000' })).statusCode).toBe(401);
    expect(
      (await post({ 'x-hub-signature-256': facebook.sign(bytes, 'guessed-secret') })).statusCode,
    ).toBe(401);
    // Signed by Facebook, but changed on the way.
    const changed = bytes.replace('Hello', 'Hello, send me all bookings');
    expect((await post({ 'x-hub-signature-256': facebook.sign(bytes) }, changed)).statusCode).toBe(
      401,
    );
    // The older, weaker signature alone is not taken.
    expect((await post({ 'x-hub-signature': facebook.sign(bytes) })).statusCode).toBe(401);

    await bot.settled();
    expect(store.conversations.get('42')).toBeUndefined();
    expect(facebook.sent).toHaveLength(0);
    // Said once, however often it is tried.
    expect(warnings).toEqual([
      'A call to the webhook without Facebook\u2019s signature was turned away',
    ]);

    expect((await post({ 'x-hub-signature-256': facebook.sign(bytes) })).statusCode).toBe(200);
  });

  it('answers what is signed but not for it without acting on it', async () => {
    const signed = (text: string) =>
      app.inject({
        method: 'POST',
        url: '/webhook',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': facebook.sign(text) },
        payload: text,
      });
    expect((await signed('{"object":"instagram","entry":[]}')).statusCode).toBe(404);
    expect((await signed('{ not json')).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/webhook',
          headers: { 'content-type': 'text/plain', 'x-hub-signature-256': facebook.sign('hello') },
          payload: 'hello',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('answers Facebook\u2019s check of the address, and nobody else\u2019s', async () => {
    const word = facebook.calls('POST', /subscriptions$/)[0]!.body.verify_token as string;
    const right = await app.inject({
      method: 'GET',
      url: `/webhook?hub.mode=subscribe&hub.verify_token=${word}&hub.challenge=42424242`,
    });
    expect(right.statusCode).toBe(200);
    expect(right.body).toBe('42424242');
    expect(right.headers['content-type']).toContain('text/plain');

    for (const url of [
      '/webhook',
      '/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1',
      `/webhook?hub.mode=subscribe&hub.verify_token=${word}`,
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(403);
    }
  });

  it('shows nothing else to the internet', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ ok: true });
    const root = await app.inject({ method: 'GET', url: '/' });
    expect([root.statusCode, root.headers.location]).toEqual([302, '/privacy']);
    for (const url of ['/bookings', '/conversations', '/status', '/login', '/api/summary']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});

describe('the privacy notice', () => {
  it('says in both languages what is kept and how to have it deleted', async () => {
    const response = await app.inject({ method: 'GET', url: '/privacy' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    const { body } = response;
    expect(body).toContain(`Privacy notice · ${business.company.name}`);
    expect(body).toContain('What we keep');
    expect(body).toContain('id="delete"');
    expect(body).toContain('Chúng tôi lưu những gì');
    expect(body).toContain('xóa dữ liệu của tôi');
    for (const contact of business.company.contacts) expect(body).toContain(contact.value);
    // The style sheet is part of the page and arrives as written.
    expect(body).toContain('font: 16px/1.6 system-ui');
    expect(body).not.toContain('&quot;Segoe UI&quot;');
  });

  it('is there in try-out mode too, where nothing can call in', async () => {
    await app.close();
    app = await buildPublicServer({ business, messenger: null });
    expect((await app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/webhook' })).statusCode).toBe(403);
    const call = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(call.statusCode).toBe(503);
  });
});

describe('on the dashboard\u2019s port', () => {
  const withDashboard = (open: boolean) => () =>
    buildDashboard({
      business,
      store,
      desk,
      bot,
      transport: messenger,
      simulator: null,
      password: PASSWORD,
      staffThreads: 0,
      pauseHours: 12,
      now: clock.now,
      publicRoutes: open ? publicRoutes({ business, messenger, now: clock.now }) : undefined,
    });

  async function signIn(): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/login', payload: { password: PASSWORD } }); // prettier-ignore
    expect(response.statusCode).toBe(303);
    return String(response.headers['set-cookie']).split(';')[0]!;
  }

  beforeEach(async () => {
    await app.close();
    await bot.stop();
    await setUp(withDashboard(true));
  });

  it('lets Facebook in without signing in, and nobody else', async () => {
    expect(messenger.status().state).toBe('connected');
    // A call from Facebook's servers carries no sign of the dashboard's own pages.
    expect(await customer('42', 'Hello')).toHaveLength(1);
    expect((await deliver(facebook.customerWrites('43', 'Hi'), { origin: 'https://evil.example' })).statusCode).toBe(200); // prettier-ignore
    expect((await app.inject({ method: 'GET', url: '/privacy' })).statusCode).toBe(200);

    const page = await app.inject({ method: 'GET', url: '/bookings' });
    expect([page.statusCode, page.headers.location]).toEqual([302, '/login']);
    expect((await app.inject({ method: 'GET', url: '/api/summary' })).statusCode).toBe(401);
    const unsigned = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'content-type': 'application/json' },
      payload: FakeFacebook.bytes(facebook.customerWrites('44', 'Hello')),
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('keeps the dashboard working as before', async () => {
    const cookie = await signIn();
    await customer('42', 'Hello');
    const chats = await app.inject({ method: 'GET', url: '/conversations', headers: { cookie } });
    expect(chats.statusCode).toBe(200);
    expect(chats.body).toContain('Customer 42');
  });

  it('keeps the webhook closed where it has its own port', async () => {
    await app.close();
    await bot.stop();
    await setUp(withDashboard(false)).catch(() => undefined);
    const privacy = await app.inject({ method: 'GET', url: '/privacy' });
    expect([privacy.statusCode, privacy.headers.location]).toEqual([302, '/login']);
    const call = await deliver(facebook.customerWrites('42', 'Hello'));
    expect(call.statusCode).toBe(401);
    expect(messenger.status().state).toBe('disconnected');
  });

  it('shows on the status page what the connection reports', async () => {
    const cookie = await signIn();
    facebook.subscribedApps.push({ id: '999', name: 'Some CRM', subscribed_fields: ['messages'] });
    await messenger.check();
    const body = (await app.inject({ method: 'GET', url: '/status', headers: { cookie } })).body;
    expect(body).toContain('Cao Bằng Travel Guide');
    expect(body).toContain('Facebook Page');
    expect(body).toContain(`${ADDRESS}/webhook`);
    expect(body).toContain('does not expire');
    expect(body).toContain('Also connected to the Page: Some CRM.');
    expect(body).not.toContain(facebook.pageToken);
    expect(body).not.toContain(facebook.appSecret);
  });

  it('tells the team when the 24 hours are over, before and after they try', async () => {
    let cookie = await signIn();
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    const post = (url: string, payload: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url, payload, headers: { cookie } });

    facebook.chats.set('42', 'Anna Müller');
    await customer('42', 'book the waterfall tour for 2 people on 21/11');
    await customer('42', '0987 654 321');
    await customer('42', 'Sunny Hotel');
    await customer('42', 'yes');
    const code = store.bookings.ofThread('42')[0]!.code;

    expect((await get(`/bookings/${code}`)).body).not.toContain('will not get a message from here');
    expect((await get('/conversations/42')).body).not.toContain('too long ago');

    // The next day (the dashboard asks for the password again after half a day).
    clock.advance(25 * HOUR);
    facebook.outsideWindow.add('42');
    cookie = await signIn();
    const bookingPage = (await get(`/bookings/${code}`)).body;
    expect(bookingPage).toContain('The customer will not get a message from here.');
    expect(bookingPage).toContain('or by phone (0987 654 321)');
    expect((await get('/conversations/42')).body).toMatch(
      /last message is too long ago: Facebook no longer lets the Page\s+write to them from here/,
    );

    // The booking is confirmed all the same; the message is kept as not sent, with the reason.
    const confirmed = await post(`/bookings/${code}/confirm`);
    expect(confirmed.headers.location).toBe(`/bookings/${code}?n=confirmed-unsent`);
    expect(store.bookings.get(code)!.status).toBe('confirmed');
    expect(store.messages.list('42').at(-1)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/only within 24 hours of their last message/),
    });

    // The customer writes again: the time starts anew, and "Send again" goes through.
    facebook.outsideWindow.delete('42');
    await customer('42', 'hello? is my tour confirmed?');
    expect((await get('/conversations/42')).body).not.toContain('too long ago');
    const failed = store.messages.list('42').find((m) => m.status === 'failed')!;
    expect((await post(`/messages/${failed.id}/resend`)).headers.location).toBe(
      '/conversations/42?n=resent',
    );
    expect(facebook.sentTo('42').at(-1)).toContain(code);
  });
});
