import { afterEach, describe, expect, it } from 'vitest';
import { FakeFacebook, PAGE_INBOX_APP_ID } from '../../test/fake-facebook';
import { TestClock } from '../../test/helpers';
import { type MessengerOptions, MessengerTransport, WEBHOOK_FIELDS, splitText } from './messenger';
import type { IncomingMessage } from './types';

const ADDRESS = 'https://assistant.example.com';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ESSENTIAL = ['messages', 'message_echoes', 'messaging_postbacks'];

const running: MessengerTransport[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((transport) => transport.stop()));
});

function setUp(
  options: Partial<MessengerOptions> = {},
  prepare?: (facebook: FakeFacebook) => void,
) {
  const facebook = new FakeFacebook();
  prepare?.(facebook);
  const clock = new TestClock();
  const received: IncomingMessage[] = [];
  const logged: Array<{ level: string; message: string; details: object }> = [];
  const write = (level: string) => (details: object, message: string) => {
    logged.push({ level, message, details });
  };
  const transport = new MessengerTransport({
    appId: facebook.appId,
    appSecret: facebook.appSecret,
    pageAccessToken: facebook.pageToken,
    publicUrl: ADDRESS,
    graphVersion: facebook.version,
    fetch: facebook.fetch,
    now: clock.now,
    sleep: async () => undefined,
    log: { info: write('info'), warn: write('warn'), error: write('error') },
    // No second look by itself while a test runs.
    checkEveryMs: HOUR,
    retryDelaysMs: [HOUR],
    ...options,
  });
  running.push(transport);
  return {
    facebook,
    clock,
    transport,
    received,
    logged,
    start: () => transport.start((message) => received.push(message)),
  };
}

async function connected(
  options: Partial<MessengerOptions> = {},
  prepare?: (facebook: FakeFacebook) => void,
) {
  const all = setUp(options, prepare);
  await all.start();
  expect(all.transport.status().lastError).toBeNull();
  return all;
}

const detail = (transport: MessengerTransport, label: string) =>
  transport.status().details?.find((entry) => entry.label === label)?.value;

describe('connecting', () => {
  it('gives Facebook its address and switches the Page on for the app', async () => {
    const { facebook, transport, start } = setUp();
    expect(transport.status()).toMatchObject({ state: 'stopped', account: null });
    await start();

    expect(transport.status()).toMatchObject({
      state: 'connected',
      account: { id: facebook.page.id, name: 'Cao Bằng Travel Guide', kind: 'page' },
      lastError: null,
      notes: [],
    });
    expect(facebook.subscription).toEqual({
      callback_url: `${ADDRESS}/webhook`,
      fields: [...WEBHOOK_FIELDS],
      active: true,
    });
    expect(facebook.subscribedApps).toEqual([
      { id: facebook.appId, name: 'Booking assistant', subscribed_fields: [...WEBHOOK_FIELDS] },
    ]);
    expect(detail(transport, 'Messages arrive at')).toBe(`${ADDRESS}/webhook`);
    expect(detail(transport, 'Access token')).toBe('does not expire');
    expect(detail(transport, 'Facebook app')).toBe(`id ${facebook.appId}`);
  });

  it('answers Facebook\u2019s check of the address with the word it registered', async () => {
    const { facebook, transport } = await connected();
    const word = facebook.calls('POST', /subscriptions$/)[0]!.body.verify_token;
    const ask = (query: Record<string, unknown>) => transport.answerToVerification(query);

    expect(
      ask({ 'hub.mode': 'subscribe', 'hub.verify_token': word, 'hub.challenge': '1158201444' }),
    ).toBe('1158201444');
    expect(
      ask({ 'hub.mode': 'subscribe', 'hub.verify_token': 'a guess', 'hub.challenge': '1' }),
    ).toBeNull();
    expect(ask({ 'hub.mode': 'unsubscribe', 'hub.verify_token': word, 'hub.challenge': '1' })).toBe(
      null,
    );
    expect(ask({ 'hub.mode': 'subscribe', 'hub.verify_token': word })).toBeNull();
    expect(ask({})).toBeNull();
  });

  it('uses the word from the settings when one is set', async () => {
    const { facebook, transport } = await connected({ verifyToken: 'my own word' });
    expect(facebook.calls('POST', /subscriptions$/)[0]!.body.verify_token).toBe('my own word');
    expect(
      transport.answerToVerification({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my own word',
        'hub.challenge': '7',
      }),
    ).toBe('7');
  });

  it('changes nothing at Facebook when everything is in place', async () => {
    const { facebook, transport } = await connected();
    const posts = () => facebook.requests.filter((request) => request.method === 'POST').length;
    const before = posts();
    await transport.check();
    await transport.check();
    expect(posts()).toBe(before);
    expect(transport.status().state).toBe('connected');
  });

  it('gives Facebook the new address when it changes', async () => {
    const { facebook, transport, logged } = await connected();
    await transport.setPublicUrl('https://calm-river-12.trycloudflare.com/');
    expect(facebook.subscription?.callback_url).toBe(
      'https://calm-river-12.trycloudflare.com/webhook',
    );
    expect(detail(transport, 'Messages arrive at')).toBe(
      'https://calm-river-12.trycloudflare.com/webhook',
    );
    expect(logged.at(-1)).toMatchObject({
      level: 'info',
      details: {
        address: 'https://calm-river-12.trycloudflare.com/webhook',
        before: `${ADDRESS}/webhook`,
      },
    });
  });

  it('repairs what Facebook switched off', async () => {
    const { facebook, transport } = await connected();
    // Facebook drops the Page's subscription when the address did not answer for an hour.
    facebook.subscribedApps = [];
    facebook.subscription!.active = false;
    await transport.check();
    expect(facebook.subscription).toMatchObject({
      active: true,
      callback_url: `${ADDRESS}/webhook`,
    });
    expect(facebook.subscribedApps[0]).toMatchObject({ id: facebook.appId });
    expect(transport.status().state).toBe('connected');

    // A Page subscription that lost a field is renewed whole.
    facebook.subscribedApps[0]!.subscribed_fields = ['messages'];
    await transport.check();
    expect(facebook.subscribedApps[0]!.subscribed_fields).toEqual([...WEBHOOK_FIELDS]);
  });

  it.each<[string, Partial<MessengerOptions>, (facebook: FakeFacebook) => void, RegExp]>([
    [
      'a wrong app secret',
      { appSecret: 'not-the-secret' },
      () => undefined,
      /does not accept the app id and app secret.*FB_APP_SECRET/,
    ],
    [
      'a token Facebook no longer accepts',
      {},
      (facebook) => (facebook.token.valid = false),
      /no longer accepts the Page\u2019s access token.*FB_PAGE_ACCESS_TOKEN/,
    ],
    [
      'the token of a person',
      {},
      (facebook) => (facebook.token.type = 'USER'),
      /token of a person, not of the Page.*pnpm fb:check --save-page-token/,
    ],
    [
      'a token made for another app',
      {},
      (facebook) => (facebook.token.appId = '999'),
      /made for another Facebook app \(id 999\)/,
    ],
    [
      'a token without the permission to answer',
      {},
      (facebook) => (facebook.token.scopes = ['pages_show_list', 'pages_manage_metadata']),
      /lacks the permission pages_messaging\./,
    ],
    [
      'a token for another Page than the one named',
      { pageId: '123' },
      () => undefined,
      /is for the Page with id 700000000000001, but FB_PAGE_ID names 123/,
    ],
    [
      'an address Facebook cannot reach',
      {},
      (facebook) => (facebook.verifyCallback = async () => false),
      /did not accept https:\/\/assistant\.example\.com\/webhook .*#2200.*reachable from the internet/,
    ],
    [
      'no address at all',
      { publicUrl: '' },
      () => undefined,
      /no address to deliver the Page\u2019s messages to\. Set PUBLIC_URL.*--tunnel/,
    ],
    [
      'a Facebook that cannot be reached',
      {},
      (facebook) => facebook.failing('GET', /^debug_token$/, null),
      /^Facebook could not be reached \(ENOTFOUND\)\.$/,
    ],
  ])('says what is wrong with %s', async (_what, options, prepare, expected) => {
    const { transport, start, logged } = setUp(options, prepare);
    await start();
    const status = transport.status();
    expect(status.state).toBe('disconnected');
    expect(status.lastError).toMatch(expected);
    expect(logged.at(-1)).toMatchObject({ level: 'error', message: 'Not connected to Messenger' });
  });

  it('never puts the token or the secret into what it says or logs', async () => {
    const { facebook, transport, start, logged } = setUp({}, (f) => (f.token.valid = false));
    await start();
    const said = JSON.stringify([transport.status(), logged]);
    expect(said).not.toContain(facebook.pageToken);
    expect(said).not.toContain(facebook.appSecret);
  });

  it('tries again by itself and connects once the trouble is over', async () => {
    const { facebook, transport, start } = setUp({ retryDelaysMs: [10] });
    facebook.failing('GET', /^debug_token$/, null, 2);
    await start();
    expect(transport.status().state).toBe('disconnected');
    await expect
      .poll(() => transport.status().state, { timeout: 2000, interval: 5 })
      .toBe('connected');
    expect(transport.status().lastError).toBeNull();
  });

  it('works with an address someone entered in Facebook\u2019s dashboard by hand', async () => {
    const { facebook, transport } = await connected({ publicUrl: '' }, (f) => {
      f.subscription = {
        callback_url: 'https://proxy.example.com/hook',
        fields: ['messages', 'messaging_postbacks'],
        active: true,
      };
    });
    expect(transport.status().state).toBe('connected');
    expect(facebook.calls('POST', /subscriptions$/)).toHaveLength(0);
    expect(facebook.subscription?.callback_url).toBe('https://proxy.example.com/hook');
    expect(facebook.subscribedApps[0]).toMatchObject({ id: facebook.appId });
    expect(detail(transport, 'Messages arrive at')).toBe('https://proxy.example.com/hook');
    expect(transport.status().notes?.join(' ')).toMatch(
      /does not report these to the assistant: message_echoes, messaging_policy_enforcement, messaging_handovers, standby\. Set PUBLIC_URL/,
    );
  });

  it('goes on with the essential reports when Facebook does not take the whole list', async () => {
    const { facebook, transport, logged } = await connected({}, (f) => {
      f.acceptedFields = new Set(ESSENTIAL);
    });
    expect(transport.status().state).toBe('connected');
    expect(facebook.subscription?.fields).toEqual(ESSENTIAL);
    expect(facebook.subscribedApps[0]!.subscribed_fields).toEqual(ESSENTIAL);
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
    expect(transport.status().notes?.join(' ')).toMatch(/It answers customers all the same/);

    // And does not ask again at every look.
    const posts = facebook.requests.filter((request) => request.method === 'POST').length;
    await transport.check();
    expect(facebook.requests.filter((request) => request.method === 'POST')).toHaveLength(posts);
  });

  it('points out other apps on the Page, and a token that is about to end', async () => {
    const { clock, transport } = await connected({}, (f) => {
      f.subscribedApps = [{ id: '999', name: 'Some CRM', subscribed_fields: ['messages'] }];
      f.token.expiresAt = Math.round((Date.parse('2026-11-15T02:00:00Z') + 5 * DAY) / 1000);
    });
    expect(clock.now()).toBe(Date.parse('2026-11-15T02:00:00Z'));
    const notes = transport.status().notes!.join('\n');
    expect(notes).toMatch(/Also connected to the Page: Some CRM\. If one of them answers/);
    expect(notes).toMatch(/The access token stops working on 2026-11-20\./);
    expect(detail(transport, 'Access token')).toBe('ends on 2026-11-20');
  });

  it('stops looking when it is stopped', async () => {
    const { facebook, transport } = await connected({ checkEveryMs: 5 });
    await transport.stop();
    const calls = facebook.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(facebook.requests).toHaveLength(calls);
    expect(transport.status().state).toBe('stopped');
  });
});

describe('what Facebook delivers', () => {
  it('knows Facebook\u2019s signature from anyone else\u2019s', async () => {
    const { facebook, transport } = await connected();
    const bytes = FakeFacebook.bytes(facebook.customerWrites('42', 'Xin chào, cho mình hỏi'));
    const body = Buffer.from(bytes);

    expect(transport.isSignedByFacebook(body, facebook.sign(bytes))).toBe(true);
    expect(transport.isSignedByFacebook(Buffer.from(`${bytes} `), facebook.sign(bytes))).toBe(
      false,
    );
    expect(transport.isSignedByFacebook(body, facebook.sign(bytes, 'guessed-secret'))).toBe(false);
    expect(transport.isSignedByFacebook(body, facebook.sign(bytes).slice(0, -1))).toBe(false);
    expect(transport.isSignedByFacebook(body, undefined)).toBe(false);
    expect(transport.isSignedByFacebook(body, [facebook.sign(bytes)])).toBe(false);
  });

  it('takes in what a customer writes', async () => {
    const { facebook, transport, received, clock } = await connected();
    const delivery = facebook.customerWrites('42', 'Cho mình thuê 2 xe từ ngày 20/11', {
      mid: 'm_abc',
      at: 1_799_999_000_000,
    });
    expect(transport.receive(delivery)).toBe(true);
    expect(received).toEqual([
      {
        threadId: '42',
        senderId: '42',
        messageId: 'm_abc',
        text: 'Cho mình thuê 2 xe từ ngày 20/11',
        attachments: 0,
        likeOnly: false,
        timestamp: 1_799_999_000_000,
        fromSelf: false,
        isGroup: false,
      },
    ]);
    expect(transport.status().lastMessageAt).toBe(clock.now());
  });

  it('counts what was sent along, and knows the thumbs-up', async () => {
    const { facebook, transport, received } = await connected();
    const image = { type: 'image', payload: { url: 'https://cdn.example/photo.jpg' } };
    const preview = { type: 'fallback', payload: { url: 'https://youtu.be/x', title: 'A video' } };
    const like = { type: 'sticker', payload: { url: 'https://cdn.example/like.png', sticker_id: 369239263222822 } }; // prettier-ignore
    const likeAsImage = { type: 'image', payload: { url: 'https://cdn.example/like.png', sticker_id: 369239263222822 } }; // prettier-ignore
    const cat = { type: 'sticker', payload: { url: 'https://cdn.example/cat.png', sticker_id: 1234 } }; // prettier-ignore

    const take = (text: string, attachments: unknown[]) => {
      transport.receive(facebook.customerWrites('42', text, { attachments }));
      const { attachments: count, likeOnly } = received.at(-1)!;
      return { count, likeOnly, text: received.at(-1)!.text };
    };

    expect(take('', [image])).toEqual({ count: 1, likeOnly: false, text: '' });
    expect(take('my passport', [image, image])).toMatchObject({ count: 2 });
    // The preview Facebook makes of a link in the text is nothing the customer sent.
    expect(take('see https://youtu.be/x', [preview])).toMatchObject({ count: 0, likeOnly: false });
    // A shared link without words is.
    expect(take('', [preview])).toMatchObject({ count: 1 });
    expect(take('', [like])).toEqual({ count: 1, likeOnly: true, text: '' });
    // For a while Facebook sent a sticker twice, as a sticker and as an image.
    expect(take('', [like, likeAsImage])).toEqual({ count: 1, likeOnly: true, text: '' });
    expect(take('', [cat])).toEqual({ count: 1, likeOnly: false, text: '' });
    expect(take('ok', [like])).toMatchObject({ count: 1, likeOnly: false });
  });

  it('leaves its own messages alone and reports what a person typed in the inbox', async () => {
    const { facebook, transport, received } = await connected();
    // The assistant's own message comes back marked with this app's id, as a number or as text.
    transport.receive(
      facebook.pageWrote('42', 'Hello! I am the booking assistant.', facebook.appId),
    );
    transport.receive(facebook.pageWrote('42', 'From which date?', Number(facebook.appId)));
    expect(received).toHaveLength(0);

    transport.receive(
      facebook.pageWrote('42', 'Hi, Hien here. Let me check.', PAGE_INBOX_APP_ID, 'm_x'),
    );
    expect(received).toEqual([
      expect.objectContaining({
        threadId: '42',
        senderId: facebook.page.id,
        messageId: 'm_x',
        text: 'Hi, Hien here. Let me check.',
        fromSelf: true,
      }),
    ]);
  });

  it('takes a pressed button as what it says', async () => {
    const { facebook, transport, received } = await connected();
    const press = {
      sender: { id: '42' },
      recipient: { id: facebook.page.id },
      timestamp: 1_800_000_000_123,
      postback: { title: 'Get Started', payload: 'GET_STARTED' },
    };
    transport.receive(facebook.delivery(press));
    // Facebook repeats a delivery that got no answer in time: the same press, the same id.
    transport.receive(facebook.delivery(press));
    expect(received.map((message) => [message.text, message.messageId, message.fromSelf])).toEqual([
      ['Get Started', 'postback.42.1800000000123', false],
      ['Get Started', 'postback.42.1800000000123', false],
    ]);

    transport.receive(
      facebook.delivery({ ...press, postback: { mid: 'm_p', payload: 'PRICES', title: '' } }),
    );
    expect(received.at(-1)).toMatchObject({ text: 'PRICES', messageId: 'm_p' });
  });

  it('leaves alone what is not for it to answer', async () => {
    const { facebook, transport, received, logged } = await connected();
    const page = facebook.page.id;
    const from = (extra: object) => ({ sender: { id: '42' }, recipient: { id: page }, timestamp: 1, ...extra }); // prettier-ignore

    // Not about a Page at all.
    expect(transport.receive({ object: 'instagram', entry: [] })).toBe(false);
    expect(transport.receive('nonsense')).toBe(false);
    expect(transport.receive(null)).toBe(false);

    // Marks that a message was read or delivered, reactions, a chat passed between apps.
    expect(
      transport.receive(
        facebook.delivery(
          from({ read: { watermark: 1 } }),
          from({ delivery: { mids: ['m_1'], watermark: 1 } }),
          from({ reaction: { mid: 'm_1', action: 'react', emoji: '\u2764' } }),
          from({ pass_thread_control: { new_owner_app_id: '1', previous_owner_app_id: '2' } }),
          // A note Facebook's own tools leave when they pass a chat on, without a message.
          from({
            message: { admin_text: 'Customer wants to buy', handoff_reason: 'purchase_intent' },
          }),
          // Things that cannot be read at all.
          null,
          { message: { mid: 'm_2', text: 'no sender' } },
          from({ message: { is_echo: true, app_id: 1, mid: 'm_3' } }),
        ),
      ),
    ).toBe(true);
    expect(received).toHaveLength(0);

    // Messages of another Page the app is switched on for.
    const stranger = {
      object: 'page',
      entry: [{ id: '888', time: 1, messaging: [{ ...from({ message: { mid: 'm_4', text: 'hi' } }), recipient: { id: '888' } }] }], // prettier-ignore
    };
    transport.receive(stranger);
    transport.receive(stranger);
    expect(received).toHaveLength(0);
    expect(logged.filter((entry) => entry.message.includes('another Page'))).toHaveLength(1);
  });

  it('does not answer chats that another app holds, and says so on the status page', async () => {
    const { facebook, transport, received, clock } = await connected();
    const held = {
      object: 'page',
      entry: [
        {
          id: facebook.page.id,
          time: 1,
          standby: [
            { sender: { id: '42' }, recipient: { id: facebook.page.id }, message: { mid: 'm_s1', text: 'hello?' } }, // prettier-ignore
            { sender: { id: facebook.page.id }, recipient: { id: '42' }, message: { mid: 'm_s2', text: 'Hi!', is_echo: true, app_id: 1 } }, // prettier-ignore
          ],
        },
      ],
    };
    expect(transport.receive(held)).toBe(true);
    transport.receive(held);
    expect(received).toHaveLength(0);
    expect(transport.status().notes).toEqual([
      expect.stringMatching(
        /^2 messages from customers arrived marked as belonging to another app/,
      ),
    ]);

    clock.advance(DAY + 1);
    expect(transport.status().notes).toEqual([]);
  });

  it('passes on a warning or a block from Facebook', async () => {
    const { facebook, transport, logged } = await connected();
    const notice = (action: string, reason?: string) =>
      facebook.delivery({
        recipient: { id: facebook.page.id },
        timestamp: Date.parse('2026-11-14T10:00:00Z'),
        policy_enforcement: { action, reason },
      });

    transport.receive(notice('block', 'The bot violated our Platform Policies.'));
    expect(transport.status().notes).toEqual([
      'Facebook reported on 2026-11-14: the Page is blocked from sending messages. The bot violated our Platform Policies.',
    ]);
    expect(logged.at(-1)).toMatchObject({ level: 'error' });

    transport.receive(notice('warning', 'Slow down.'));
    expect(transport.status().notes![0]).toMatch(
      /a warning about the Page\u2019s messages\. Slow down\./,
    );

    transport.receive(notice('unblock'));
    expect(transport.status().notes).toEqual([]);
  });

  it('takes in the rest of a delivery when one part of it cannot be handled', async () => {
    const { facebook, transport, logged } = await connected();
    const seen: string[] = [];
    await transport.stop();
    await transport.start((message) => {
      if (message.text === 'boom') throw new Error('the database is busy');
      seen.push(message.text);
    });
    const one = (text: string) => ({
      sender: { id: '42' },
      recipient: { id: facebook.page.id },
      timestamp: 1,
      message: { mid: `m_${text}`, text },
    });
    expect(transport.receive(facebook.delivery(one('first'), one('boom'), one('third')))).toBe(
      true,
    );
    expect(seen).toEqual(['first', 'third']);
    expect(logged.at(-1)).toMatchObject({
      level: 'error',
      details: { error: 'the database is busy' },
    });
  });
});

describe('sending', () => {
  it('answers through the Page, as a response to the customer', async () => {
    const { facebook, transport } = await connected();
    const sent = await transport.sendText('42', 'Xin chào anh/chị!');
    expect(sent).toEqual({ messageId: 'm_fake1' });
    expect(facebook.sent).toEqual([
      {
        to: '42',
        text: 'Xin chào anh/chị!',
        messagingType: 'RESPONSE',
        tag: null,
        messageId: 'm_fake1',
      },
    ]);
    const request = facebook.calls('POST', /messages$/)[0]!;
    expect(request.path).toBe(`${facebook.page.id}/messages`);
    expect(request.token).toBe(facebook.pageToken);
    expect(request.url).not.toContain(facebook.pageToken);
  });

  it('shows that it has read, and that it is writing', async () => {
    const { facebook, transport } = await connected();
    await transport.markRead('42');
    await transport.setTyping('42', true);
    await transport.setTyping('42', false);
    expect(facebook.actions).toEqual([
      { to: '42', action: 'mark_seen' },
      { to: '42', action: 'typing_on' },
      { to: '42', action: 'typing_off' },
    ]);
  });

  it('sends a long text in pieces Facebook takes', async () => {
    const { facebook, transport } = await connected();
    const paragraph = 'The tour starts at the office at 8:00 and ends there at 17:00. '.repeat(20);
    const text = [paragraph, paragraph, paragraph, paragraph].map((p) => p.trim()).join('\n\n');
    expect(text.length).toBeGreaterThan(4000);

    const sent = await transport.sendText('42', text);
    const parts = facebook.sentTo('42');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 2000)).toBe(true);
    expect(parts.join('\n\n')).toBe(text);
    expect(sent.messageId).toBe(facebook.sent.at(-1)!.messageId);
  });

  it('says in plain words when the 24 hours are over', async () => {
    const { facebook, transport } = await connected();
    facebook.outsideWindow.add('42');
    await expect(transport.sendText('42', 'Your booking is confirmed.')).rejects.toThrowError(
      /^Facebook lets the Page write to a customer only within 24 hours of their last message, and that time is over for this chat\. Answer from the Page\u2019s inbox in Meta Business Suite, where a person has 7 days, or reach the customer by phone\.$/,
    );
    // Not even a person's message goes out tagged without Facebook's approval being set.
    await expect(transport.sendText('42', 'Hello', { byPerson: true })).rejects.toThrowError(
      /24 hours/,
    );
    expect(facebook.sent).toHaveLength(0);
    expect(transport.staffReplyWindowMs).toBe(DAY);
    expect(transport.replyWindowMs).toBe(DAY);
  });

  it('lets a person write for 7 days where the app is approved for it', async () => {
    const { facebook, transport } = await connected({ humanAgentTag: true });
    expect(transport.staffReplyWindowMs).toBe(7 * DAY);
    expect(transport.replyWindowMs).toBe(DAY);
    facebook.outsideWindow.add('42');

    await transport.sendText('42', 'Sorry for the wait, your booking is confirmed.', {
      byPerson: true,
    });
    expect(facebook.sent).toEqual([
      expect.objectContaining({ to: '42', messagingType: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }),
    ]);
    // Within the 24 hours nothing is tagged.
    await transport.sendText('43', 'Hello', { byPerson: true });
    expect(facebook.sent.at(-1)).toMatchObject({ to: '43', messagingType: 'RESPONSE', tag: null });

    // The assistant's own answers are never sent as a person's.
    await expect(transport.sendText('42', 'An automatic answer')).rejects.toThrowError(/24 hours/);
    // And where Facebook has not approved the app after all, it says so.
    facebook.humanAgentApproved = false;
    await expect(transport.sendText('42', 'Hello again', { byPerson: true })).rejects.toThrowError(
      /24 hours/,
    );
    expect(facebook.sent).toHaveLength(2);
  });

  it('tries again where Facebook had a problem of its own, and only there', async () => {
    const { facebook, transport } = await connected();
    const temporary = { message: 'An unexpected error has occurred.', code: 2, is_transient: true };

    facebook.failing('POST', /messages$/, temporary, 2, 500);
    await transport.sendText('42', 'first');
    expect(facebook.sentTo('42')).toEqual(['first']);
    expect(facebook.calls('POST', /messages$/)).toHaveLength(3);

    facebook.failing('POST', /messages$/, temporary, 3, 500);
    await expect(transport.sendText('42', 'second')).rejects.toThrowError(
      'Facebook had a problem of its own. Try again in a moment.',
    );
    expect(facebook.calls('POST', /messages$/)).toHaveLength(6);

    // Unanswered: the message may have arrived, so it is not sent a second time.
    facebook.failing('POST', /messages$/, null);
    await expect(transport.sendText('42', 'third')).rejects.toThrowError(
      'Facebook could not be reached (ENOTFOUND).',
    );
    expect(facebook.calls('POST', /messages$/)).toHaveLength(7);
    expect(facebook.sentTo('42')).toEqual(['first']);
  });

  it('shows on the dashboard at once when the token is no longer accepted', async () => {
    const { facebook, transport } = await connected();
    facebook.token.valid = false;
    await expect(transport.sendText('42', 'hello')).rejects.toThrowError(
      /no longer accepts the Page\u2019s access token/,
    );
    expect(transport.status()).toMatchObject({
      state: 'disconnected',
      lastError: expect.stringMatching(/no longer accepts the Page\u2019s access token/),
    });
  });

  it('explains who can be written to while the app is in development', async () => {
    const { facebook, transport } = await connected();
    facebook.failing('POST', /messages$/, {
      message:
        '(#200) Cannot message users who are not admins, developers or testers of the app until pages_messaging permission is reviewed and the app is live.',
      code: 200,
      error_subcode: 2018028,
    });
    await expect(transport.sendText('42', 'hello')).rejects.toThrowError(
      /only to people who have a role on it.*Opening the assistant to all customers/,
    );
  });

  it('cannot send before it knows the Page, and says why', async () => {
    const { transport, start } = setUp({}, (f) => (f.token.valid = false));
    await expect(transport.sendText('42', 'hello')).rejects.toThrowError(
      'Not connected to Facebook yet.',
    );
    await start();
    await expect(transport.sendText('42', 'hello')).rejects.toThrowError(
      /^Not connected to Facebook: Facebook no longer accepts the Page\u2019s access token/,
    );
    await expect(transport.markRead('42')).rejects.toThrowError(/Not connected to Facebook/);
    expect(await transport.nameOf('42')).toBeNull();
  });

  it('can still send when only the address for incoming messages is missing', async () => {
    const { facebook, transport, start } = setUp({ publicUrl: '' });
    await start();
    expect(transport.status().state).toBe('disconnected');
    await transport.sendText('42', 'A reply typed in the dashboard');
    expect(facebook.sentTo('42')).toEqual(['A reply typed in the dashboard']);
  });
});

describe('cutting a long text', () => {
  it('leaves a text that fits as it is', () => {
    expect(splitText('Hello')).toEqual(['Hello']);
    expect(splitText('  Hello\n')).toEqual(['Hello']);
    expect(splitText('')).toEqual([]);
    expect(splitText('x'.repeat(2000))).toHaveLength(1);
  });

  it('cuts between paragraphs, then lines, then sentences, then words', () => {
    expect(splitText('aaaa aaaa\n\nbbbb bbbb', 12)).toEqual(['aaaa aaaa', 'bbbb bbbb']);
    expect(splitText('aaaa aaaa\nbbbb bbbb', 12)).toEqual(['aaaa aaaa', 'bbbb bbbb']);
    expect(splitText('Aaaa aaa. Bbbb bbb.', 12)).toEqual(['Aaaa aaa.', 'Bbbb bbb.']);
    expect(splitText('aaaa aaaa bbbb bbbb', 12)).toEqual(['aaaa aaaa', 'bbbb bbbb']);
  });

  it('cuts an unbroken text where it must, never through a character', () => {
    expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    const parts = splitText('\u{1F600}'.repeat(8), 5);
    expect(parts.join('')).toBe('\u{1F600}'.repeat(8));
    expect(parts.every((part) => part.length <= 5 && !/^[\udc00-\udfff]/.test(part))).toBe(true);
  });
});

describe('names', () => {
  it('asks Facebook for the profile, then the Page\u2019s own list of chats', async () => {
    const { facebook, transport } = await connected();
    facebook.profiles.set('42', { name: 'Anna Müller' });
    facebook.profiles.set('43', { first_name: 'Trần', last_name: 'Thị Lan' });
    facebook.chats.set('44', 'Nguyễn Văn Nam');

    expect(await transport.nameOf('42')).toBe('Anna Müller');
    expect(await transport.nameOf('43')).toBe('Trần Thị Lan');
    // Facebook hands profiles out only to apps it has approved for them; the chat list names people too.
    expect(await transport.nameOf('44')).toBe('Nguyễn Văn Nam');
    expect(facebook.calls('GET', /conversations$/)[0]!.query).toMatchObject({
      platform: 'messenger',
      user_id: '44',
    });
    expect(await transport.nameOf(facebook.page.id)).toBe('Cao Bằng Travel Guide');
  });

  it('remembers a name, and does not keep asking for one it cannot get', async () => {
    const { facebook, transport, clock } = await connected();
    facebook.profiles.set('42', { name: 'Anna Müller' });
    const lookups = () => facebook.calls('GET', /^\d+$|conversations$/).length;

    await transport.nameOf('42');
    await transport.nameOf('42');
    expect(lookups()).toBe(1);

    expect(await transport.nameOf('45')).toBeNull();
    expect(await transport.nameOf('45')).toBeNull();
    expect(lookups()).toBe(3);

    // Later the person may be known: asked again after an hour.
    clock.advance(HOUR + 1);
    facebook.chats.set('45', 'Lê Minh');
    expect(await transport.nameOf('45')).toBe('Lê Minh');
  });
});
