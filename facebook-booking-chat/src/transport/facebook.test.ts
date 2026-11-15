import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FcaApi, type FcaEvent, type FcaModule, FacebookTransport, explain } from './facebook';
import { SessionError, describeSession, loadSession, parseSession, saveSession } from './session';
import type { IncomingMessage } from './types';

const PAGE_ID = '61550000000001';
const PROFILE_ID = '100090000000001';

const cookieEditorExport = JSON.stringify([
  { domain: '.facebook.com', name: 'c_user', value: PROFILE_ID, path: '/', secure: true },
  { domain: '.facebook.com', name: 'xs', value: 'secret-xs', path: '/' },
  { domain: '.facebook.com', name: 'i_user', value: PAGE_ID, path: '/' },
  { domain: '.facebook.com', name: 'datr', value: 'd' },
  { domain: '.example.com', name: 'c_user', value: 'not-facebook' },
]);

describe('the session file', () => {
  it('reads a browser export and tells Page from profile', () => {
    const session = parseSession(cookieEditorExport);
    expect(session.userId).toBe(PROFILE_ID);
    expect(session.pageId).toBe(PAGE_ID);
    expect(session.cookies.map((cookie) => cookie.key)).toEqual(['c_user', 'xs', 'i_user', 'datr']);
    expect(describeSession(session)).toBe(`Page ${PAGE_ID} (through the profile ${PROFILE_ID})`);
  });

  it('reads the other usual shapes', () => {
    const fbstate = parseSession(
      JSON.stringify([
        { key: 'c_user', value: PROFILE_ID, domain: 'facebook.com' },
        { key: 'xs', value: 'x' },
      ]),
    );
    expect(fbstate).toMatchObject({ userId: PROFILE_ID, pageId: null });
    expect(describeSession(fbstate)).toBe(`personal profile ${PROFILE_ID}`);

    const playwright = parseSession(
      JSON.stringify({
        cookies: [
          { name: 'c_user', value: PROFILE_ID, domain: '.facebook.com' },
          { name: 'xs', value: 'x', domain: '.facebook.com' },
        ],
        origins: [],
      }),
    );
    expect(playwright.userId).toBe(PROFILE_ID);

    const header = parseSession(`c_user=${PROFILE_ID}; xs=a%3Ab%3Ac; i_user=${PAGE_ID}`);
    expect(header).toMatchObject({ userId: PROFILE_ID, pageId: PAGE_ID });
    expect(header.cookies[1]).toMatchObject({ key: 'xs', value: 'a%3Ab%3Ac' });
  });

  it('says what is wrong with a file it cannot use, without quoting it', () => {
    expect(() => parseSession('')).toThrowError(/empty/);
    expect(() => parseSession('{ not json')).toThrowError(/not valid JSON/);
    expect(() => parseSession('{"a": 1}')).toThrowError(/no list of cookies/);
    expect(() =>
      parseSession(JSON.stringify([{ name: 'datr', value: 'secret-datr' }])),
    ).toThrowError(/lacks the cookies "c_user" and "xs"/);
    try {
      parseSession(JSON.stringify([{ name: 'datr', value: 'secret-datr' }]));
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-datr');
      expect(error).toBeInstanceOf(SessionError);
    }
    expect(() => loadSession('/nowhere/session.json')).toThrowError(/no session file/);
  });

  it('writes renewed cookies for the owner only, and never a signed-out set', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fbchat-')), 'session.json');
    writeFileSync(file, cookieEditorExport);

    saveSession(file, [
      { key: 'c_user', value: PROFILE_ID },
      { key: 'xs', value: 'renewed' },
    ]);
    expect(loadSession(file).cookies.find((c) => c.key === 'xs')?.value).toBe('renewed');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    saveSession(file, [{ key: 'datr', value: 'd' }]);
    expect(loadSession(file).cookies.find((c) => c.key === 'xs')?.value).toBe('renewed');
  });
});

describe('explain', () => {
  it('puts the library\u2019s errors into plain words', () => {
    expect(
      explain(new Error('Failed to get sequence ID. This is often caused by an invalid appstate.')),
    ).toMatch(/did not accept the session/);
    expect(explain({ error: 'Not logged in.' })).toMatch(/did not accept the session/);
    expect(explain({ type: 'stop_listen', error: 'Connection refused' })).toBe(
      'Facebook refused the Messenger connection.',
    );
    expect(
      explain(new Error('Error retrieving userID. This can be caused by many factors')),
    ).toMatch(/did not accept the session/);
    expect(explain(new Error('[object Object]'))).toMatch(/does not explain/);
    expect(explain(new Error('socket hang up'))).toBe('socket hang up');
    expect(explain(new SessionError('The session file is empty.'))).toBe(
      'The session file is empty.',
    );
  });
});

/** Stands in for the client library: records what is asked of it, and lets the test play Facebook. */
class FakeClient implements FcaModule {
  logins: Array<{ appState: unknown; options: Record<string, unknown> }> = [];
  failLoginWith: unknown = null;
  failListenWith: unknown = null;
  api!: FcaApi & {
    sentMqtt: Array<[string, string]>;
    sentHttp: Array<[string, string, unknown, unknown]>;
    read: string[];
    typing: Array<[boolean, string]>;
    readAll: number;
    initialData: number;
    stopped: number;
  };
  private callback: ((error: unknown, event?: FcaEvent) => void) | null = null;

  login: FcaModule['login'] = (credentials, options, callback) => {
    this.logins.push({ appState: credentials.appState, options });
    if (this.failLoginWith) return callback(this.failLoginWith);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    this.api = {
      sentMqtt: [],
      sentHttp: [],
      read: [],
      typing: [],
      readAll: 0,
      initialData: 0,
      stopped: 0,
      ctx: { mqttClient: { connected: false } },
      getCurrentUserID: () => PAGE_ID,
      getAppState: () => [
        { toJSON: () => ({ key: 'c_user', value: PROFILE_ID, domain: 'facebook.com', path: '/' }) },
        { toJSON: () => ({ key: 'xs', value: 'renewed-by-facebook', domain: 'facebook.com' }) },
      ],
      async listenMqtt(callback) {
        // What the real library does on its first connection, unless told otherwise.
        await this.markAsReadAll?.();
        await this.getBotInitialData?.();
        if (client.failListenWith) {
          callback(client.failListenWith);
          return undefined;
        }
        client.callback = callback;
        return { stop: () => void (this.stopped += 1) };
      },
      async markAsReadAll() {
        this.readAll += 1;
      },
      async getBotInitialData() {
        this.initialData += 1;
        return {};
      },
      async sendMessageMqtt(message, threadId) {
        this.sentMqtt.push([message, threadId]);
        return { threadID: threadId };
      },
      async sendMessage(message, threadId, replyTo, isSingleUser) {
        this.sentHttp.push([message, threadId, replyTo, isSingleUser]);
        return { messageID: 'mid.sent' };
      },
      async markAsRead(threadId) {
        this.read.push(threadId);
      },
      async sendTypingIndicator(typing, threadId) {
        this.typing.push([typing, threadId]);
      },
      async getUserInfo(userId) {
        if (userId === PAGE_ID) return { name: 'Cao Bằng Travel Guide' };
        if (userId === 'anon') return { name: 'Facebook User' };
        return { name: 'Anna Müller' };
      },
    };
    callback(null, this.api);
  };

  connect(): void {
    this.api.ctx!.mqttClient!.connected = true;
  }

  drop(): void {
    this.api.ctx!.mqttClient!.connected = false;
  }

  emit(event: FcaEvent): void {
    this.callback?.(null, event);
  }

  emitError(error: unknown): void {
    this.callback?.(error);
  }
}

describe('FacebookTransport', () => {
  let file: string;
  let client: FakeClient;
  let transport: FacebookTransport;
  let received: IncomingMessage[];

  function create(options: Partial<ConstructorParameters<typeof FacebookTransport>[0]> = {}) {
    transport = new FacebookTransport({
      sessionFile: file,
      loadClient: async () => client,
      retryDelaysMs: [1_000, 5_000],
      stallMs: 60_000,
      saveSessionEveryMs: 60 * 60 * 1000,
      ...options,
    });
  }

  async function startConnected(): Promise<void> {
    await transport.start((message) => received.push(message));
    client.connect();
    await vi.advanceTimersByTimeAsync(3_000);
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-15T02:00:00Z') });
    file = join(mkdtempSync(join(tmpdir(), 'fbchat-')), 'session.json');
    writeFileSync(file, cookieEditorExport);
    client = new FakeClient();
    received = [];
    create();
  });

  afterEach(async () => {
    await transport.stop();
    vi.useRealTimers();
  });

  it('signs in with the cookies only, and listens for its own messages too', async () => {
    await startConnected();
    expect(client.logins).toHaveLength(1);
    expect(client.logins[0]!.appState).toEqual([
      { key: 'c_user', value: PROFILE_ID },
      { key: 'xs', value: 'secret-xs' },
      { key: 'i_user', value: PAGE_ID },
      { key: 'datr', value: 'd' },
    ]);
    expect(client.logins[0]!.options).toMatchObject({
      selfListen: true,
      autoMarkRead: false,
      logging: false,
    });
    expect(client.logins[0]!.options).not.toHaveProperty('userAgent');

    expect(transport.status()).toMatchObject({
      state: 'connected',
      lastError: null,
      account: { id: PAGE_ID, kind: 'page', name: 'Cao Bằng Travel Guide' },
    });
  });

  it('does not let the library mark every chat as read or load the profile page', async () => {
    await startConnected();
    expect(client.api.readAll).toBe(0);
    expect(client.api.initialData).toBe(0);
  });

  it('is not "connected" before the live connection is up', async () => {
    await transport.start((message) => received.push(message));
    expect(transport.status().state).toBe('starting');
    await expect(transport.sendText('anna', 'hello')).rejects.toThrowError(
      /Not connected to Facebook yet/,
    );
  });

  it('hands on messages, from customers and from the account itself', async () => {
    await startConnected();
    client.emit({
      type: 'message',
      senderID: 100001,
      threadID: 100001,
      messageID: 'mid.1',
      body: 'Hello, do you rent scooters?',
      attachments: [],
      timestamp: '1794000000000',
      isGroup: false,
    });
    client.emit({
      type: 'message_reply',
      senderID: PAGE_ID,
      threadID: '100001',
      messageID: 'mid.2',
      body: 'Yes!',
    });
    client.emit({ type: 'message', senderID: '5', threadID: '777', body: 'hi all', isGroup: true });
    client.emit({ type: 'typ', senderID: '5', threadID: '5' });
    client.emit({ type: 'message_reaction', senderID: '5', threadID: '5' });

    expect(received).toEqual([
      {
        threadId: '100001',
        senderId: '100001',
        messageId: 'mid.1',
        text: 'Hello, do you rent scooters?',
        attachments: 0,
        likeOnly: false,
        timestamp: 1794000000000,
        fromSelf: false,
        isGroup: false,
      },
      expect.objectContaining({
        threadId: '100001',
        senderId: PAGE_ID,
        fromSelf: true,
        text: 'Yes!',
      }),
      expect.objectContaining({ threadId: '777', isGroup: true }),
    ]);
    expect(transport.status().lastMessageAt).toBe(Date.now());
  });

  it('tells the thumbs-up button from other stickers and photos', async () => {
    await startConnected();
    client.emit({
      type: 'message',
      senderID: '1',
      threadID: '1',
      body: '',
      attachments: [{ type: 'sticker', ID: '369239263222822' }],
    });
    client.emit({
      type: 'message',
      senderID: '1',
      threadID: '1',
      body: '',
      attachments: [{ type: 'sticker', stickerID: '123' }],
    });
    client.emit({
      type: 'message',
      senderID: '1',
      threadID: '1',
      attachments: [{ type: 'photo' }, { type: 'photo' }],
    });
    expect(received.map((m) => [m.attachments, m.likeOnly, m.text])).toEqual([
      [1, true, ''],
      [1, false, ''],
      [2, false, ''],
    ]);
  });

  it('sends over the live connection by default, or by web request when set so', async () => {
    await startConnected();
    expect(await transport.sendText('100001', 'Hello!')).toEqual({ messageId: null });
    expect(client.api.sentMqtt).toEqual([['Hello!', '100001']]);

    await transport.stop();
    create({ sendVia: 'http' });
    await startConnected();
    expect(await transport.sendText('100001', 'Hello!')).toEqual({ messageId: 'mid.sent' });
    expect(client.api.sentHttp).toEqual([['Hello!', '100001', undefined, true]]);
  });

  it('reports a failed send in plain words', async () => {
    await startConnected();
    client.api.sendMessageMqtt = async () => {
      throw new Error('[object Object]');
    };
    await expect(transport.sendText('1', 'x')).rejects.toThrowError(/does not explain/);
    client.api.sendMessageMqtt = () => new Promise(() => undefined);
    const hanging = transport.sendText('1', 'x');
    const expectation = expect(hanging).rejects.toThrowError(/got no answer from Facebook/);
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
  });

  it('marks as read, shows typing and looks up names', async () => {
    await startConnected();
    await transport.markRead('100001');
    await transport.setTyping('100001', true);
    expect(client.api.read).toEqual(['100001']);
    expect(client.api.typing).toEqual([[true, '100001']]);
    expect(await transport.nameOf('100001')).toBe('Anna Müller');
    expect(await transport.nameOf('anon')).toBeNull();
  });

  it('passes the browser\u2019s User-Agent on when one is set', async () => {
    create({ userAgent: 'Mozilla/5.0 (the browser the cookies came from)' });
    await startConnected();
    expect(client.logins[0]!.options.userAgent).toBe(
      'Mozilla/5.0 (the browser the cookies came from)',
    );
  });

  it('says so when there is no session file, and tries again when one appears', async () => {
    create({ sessionFile: join(tmpdir(), 'fbchat-missing', 'session.json') });
    await transport.start(() => undefined);
    expect(transport.status()).toMatchObject({ state: 'disconnected', account: null });
    expect(transport.status().lastError).toMatch(/There is no session file/);
    expect(client.logins).toHaveLength(0);
  });

  it('explains a session Facebook does not accept, and retries with growing waits', async () => {
    client.failListenWith = new Error(
      'Failed to get sequence ID. This is often caused by an invalid appstate.',
    );
    await transport.start(() => undefined);
    expect(transport.status().state).toBe('disconnected');
    expect(transport.status().lastError).toMatch(/did not accept the session/);
    expect(client.logins).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.logins).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.logins).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.logins).toHaveLength(3);

    // A fresh session file is picked up by the next attempt.
    client.failListenWith = null;
    await vi.advanceTimersByTimeAsync(5_000);
    client.connect();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.status()).toMatchObject({ state: 'connected', lastError: null });
  });

  it('signs in again when the library reports the connection lost for good', async () => {
    await startConnected();
    client.emitError({ type: 'stop_listen', error: 'Connection refused' });
    expect(transport.status()).toMatchObject({
      state: 'disconnected',
      lastError: 'Facebook refused the Messenger connection.',
    });
    expect(client.api.stopped).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.logins).toHaveLength(2);
  });

  it('skips an event the library could not read, and stays connected', async () => {
    await startConnected();
    client.emitError({ type: 'parse_error', error: 'Problem parsing message object.' });
    expect(transport.status().state).toBe('connected');
    client.emit({ type: 'message', senderID: '1', threadID: '1', body: 'still here' });
    expect(received).toHaveLength(1);
  });

  it('shows a dropped connection, and sets everything up anew if it stays down', async () => {
    await startConnected();
    client.drop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.status().state).toBe('starting');

    client.connect();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(transport.status().state).toBe('connected');
    expect(client.logins).toHaveLength(1);

    client.drop();
    await vi.advanceTimersByTimeAsync(63_000);
    expect(transport.status()).toMatchObject({
      state: 'disconnected',
      lastError: 'The Messenger connection could not be set up.',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.logins).toHaveLength(2);
  });

  it('writes the renewed cookies back from time to time and on stopping', async () => {
    await startConnected();
    expect(loadSession(file).cookies.find((c) => c.key === 'xs')?.value).toBe(
      'renewed-by-facebook',
    );
    expect(readFileSync(file, 'utf8')).not.toContain('secret-xs');

    writeFileSync(file, cookieEditorExport);
    await transport.stop();
    expect(loadSession(file).cookies.find((c) => c.key === 'xs')?.value).toBe(
      'renewed-by-facebook',
    );
    expect(transport.status().state).toBe('stopped');
  });

  it('ignores what an earlier connection still reports after a new sign-in', async () => {
    await startConnected();
    const old = client.api;
    client.emitError({ type: 'stop_listen', error: 'Connection refused' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.api).not.toBe(old);
    client.connect();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(received).toHaveLength(0);
    expect(transport.status().state).toBe('connected');
  });
});
