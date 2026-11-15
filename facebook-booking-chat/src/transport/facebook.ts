import {
  type Session,
  type SessionCookie,
  SessionError,
  describeSession,
  loadSession,
  saveSession,
} from './session';
import type { IncomingMessage, Transport, TransportState, TransportStatus } from './types';

/*
  The connection to Facebook Messenger through an unofficial client library
  (ws3-fca), which signs in with the cookies of a browser session and talks
  to Messenger the way the website does.

  Everything the rest of the program knows of that library is in this file.
  The parts of its interface used here are written out below, so that a change
  in the library shows up as a failing test rather than as silence.
*/

export interface FcaAttachment {
  type?: string;
  ID?: string | number;
  stickerID?: string | number;
}

export interface FcaEvent {
  type?: string;
  senderID?: string | number;
  threadID?: string | number;
  messageID?: string;
  body?: string;
  attachments?: FcaAttachment[];
  timestamp?: string | number;
  isGroup?: boolean;
}

export interface FcaApi {
  getCurrentUserID(): string | number;
  getAppState?: () => unknown;
  listenMqtt(
    callback: (error: unknown, event?: FcaEvent) => void,
  ): Promise<{ stop?: () => void } | undefined> | { stop?: () => void } | undefined;
  sendMessageMqtt?: (message: string, threadId: string) => Promise<unknown>;
  sendMessage?: (
    message: string,
    threadId: string,
    replyTo?: string,
    isSingleUser?: boolean,
  ) => Promise<{ messageID?: string } | null | undefined>;
  markAsRead?: (threadId: string) => Promise<unknown>;
  markAsReadAll?: () => Promise<unknown>;
  getBotInitialData?: () => Promise<unknown>;
  sendTypingIndicator?: (typing: boolean, threadId: string) => Promise<unknown>;
  getUserInfo?: (userId: string) => Promise<{ name?: string } | null | undefined>;
  ctx?: { mqttClient?: { connected?: boolean } };
}

export interface FcaModule {
  login(
    credentials: { appState: Array<{ key: string; value: string }> },
    options: Record<string, unknown>,
    callback: (error: unknown, api?: FcaApi) => void,
  ): unknown;
}

export interface FacebookLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface FacebookOptions {
  /** The file with the cookies of the signed-in browser session. */
  sessionFile: string;
  /**
   * How messages are sent: over the live Messenger connection ('mqtt', what
   * the library's own examples use) or by a web request ('http'). If sending
   * fails with one, try the other.
   */
  sendVia: 'mqtt' | 'http';
  /** The User-Agent of the browser the session was exported from. '' = the library's own. */
  userAgent: string;
  /** How often the cookies, as Facebook renews them, are written back to the file. 0 = never. */
  saveSessionEveryMs: number;
  /** Waits between attempts to sign in again after the connection is lost. The last one repeats. */
  retryDelaysMs: number[];
  /** A connection that stays down this long is given up and set up anew. */
  stallMs: number;
  log: FacebookLog;
  now: () => number;
  /** Loads the client library. Replaced in tests. */
  loadClient: () => Promise<FcaModule>;
}

const DEFAULTS: Omit<FacebookOptions, 'sessionFile'> = {
  sendVia: 'mqtt',
  userAgent: '',
  saveSessionEveryMs: 6 * 60 * 60 * 1000,
  retryDelaysMs: [15_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000],
  stallMs: 3 * 60_000,
  log: { info() {}, warn() {}, error() {} },
  now: () => Date.now(),
  loadClient: async () => {
    const module = (await import('ws3-fca')) as unknown as FcaModule & { default?: FcaModule };
    return typeof module.login === 'function' ? module : module.default!;
  },
};

const LOGIN_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 30_000;
const WATCH_EVERY_MS = 3_000;

// Messenger's thumbs-up button sends one of these stickers.
const LIKE_STICKERS = new Set(['369239263222822', '369239343222814', '369239383222810']);

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} got no answer from Facebook`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Says in plain words what went wrong, whatever shape the library threw. */
export function explain(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const detail = typeof record.error === 'string' ? record.error : '';
  const all = `${message} ${detail}`.toLowerCase();

  // What the library reports when Facebook answers a signed-in request as if
  // nobody were signed in: with the cookies withdrawn, or with a login page.
  const signedOut = ['retrieving userid', 'sequence id', 'not logged in', 'appstate', 'checkpoint'];
  if (signedOut.some((sign) => all.includes(sign))) {
    return (
      'Facebook did not accept the session: it has expired or was signed out, or Facebook wants ' +
      'the account checked first. Open Facebook in the browser, complete anything it asks for, ' +
      'then export a fresh session file and replace the old one.'
    );
  }
  if (record.type === 'stop_listen' || all.includes('connection refused')) {
    return 'Facebook refused the Messenger connection.';
  }
  if (message && message !== '[object Object]') return message;
  if (detail) return detail;
  return 'Facebook answered with an error the client library does not explain.';
}

export class FacebookTransport implements Transport {
  readonly name = 'facebook';

  private readonly options: FacebookOptions;
  private onMessage: ((message: IncomingMessage) => void) | null = null;
  private running = false;

  private api: FcaApi | null = null;
  private listener: { stop?: () => void } | null = null;
  private session: Session | null = null;
  private userId: string | null = null;
  private accountName: string | null = null;

  private state: TransportState = 'stopped';
  private stateSince: number;
  private lastError: string | null = null;
  private lastMessageAt: number | null = null;
  private failures = 0;
  private downSince: number | null = null;
  private lastSavedAt = 0;

  private watchTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;

  constructor(options: Partial<FacebookOptions> & Pick<FacebookOptions, 'sessionFile'>) {
    this.options = { ...DEFAULTS, ...options };
    this.stateSince = this.options.now();
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.running = true;
    this.failures = 0;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.persistSession();
    this.tearDown();
    this.setState('stopped');
  }

  status(): TransportStatus {
    return {
      state: this.state,
      since: this.stateSince,
      account:
        this.userId === null
          ? null
          : {
              id: this.userId,
              name: this.accountName,
              kind: this.session?.pageId ? 'page' : 'profile',
            },
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
    };
  }

  // ----------------------------------------------------------- connecting

  /** Signs in and starts listening. Never throws: trouble goes to the status and a retry. */
  private async connect(): Promise<void> {
    if (!this.running) return;
    const attempt = ++this.attempt;
    this.tearDown();
    this.setState('starting');
    try {
      const session = loadSession(this.options.sessionFile);
      const client = await this.options.loadClient();
      const api = await this.signIn(client, session);
      if (!this.running || attempt !== this.attempt) return;

      // On its first connection the library marks every chat as read and
      // loads the profile page to print a greeting. Neither is wanted here:
      // unread marks belong to the team, and the fewer requests the better.
      api.markAsReadAll = async () => undefined;
      api.getBotInitialData = async () => ({});

      this.api = api;
      this.session = session;
      this.userId = String(api.getCurrentUserID());
      this.options.log.info({ account: describeSession(session) }, 'Signed in to Facebook');

      const listener = await api.listenMqtt((error, event) => this.onEvent(attempt, error, event));
      this.listener = listener ?? null;
      this.downSince = this.options.now();
      this.watchTimer = setInterval(() => this.watch(attempt), WATCH_EVERY_MS);
      this.watch(attempt);
      void this.learnOwnName(attempt);
    } catch (error) {
      if (attempt === this.attempt) this.fail(error);
    }
  }

  private signIn(client: FcaModule, session: Session): Promise<FcaApi> {
    const options: Record<string, unknown> = {
      // Report this account's own messages too: that is how a reply typed by
      // a person in Messenger is noticed.
      selfListen: true,
      listenEvents: false,
      autoMarkRead: false,
      autoMarkDelivery: false,
      autoReconnect: true,
      updatePresence: false,
      online: true,
      logging: false,
    };
    if (this.options.userAgent) options.userAgent = this.options.userAgent;
    const appState = session.cookies.map(({ key, value }) => ({ key, value }));

    const signedIn = new Promise<FcaApi>((resolve, reject) => {
      const done = (error: unknown, api?: FcaApi) => {
        if (error || !api) reject(error ?? new Error('The client library returned nothing'));
        else resolve(api);
      };
      try {
        Promise.resolve(client.login({ appState }, options, done)).catch(reject);
      } catch (error) {
        reject(error);
      }
    });
    return withTimeout(signedIn, LOGIN_TIMEOUT_MS, 'Signing in');
  }

  /** Follows the live connection, which the library sets up and repairs by itself. */
  private watch(attempt: number): void {
    if (attempt !== this.attempt || !this.running || !this.api) return;
    const now = this.options.now();
    const connected = this.api.ctx?.mqttClient?.connected === true;

    if (connected) {
      this.downSince = null;
      if (this.state !== 'connected') {
        this.setState('connected');
        this.lastError = null;
        this.failures = 0;
        this.options.log.info({}, 'Connected to Messenger');
      }
      const { saveSessionEveryMs } = this.options;
      if (saveSessionEveryMs > 0 && now - this.lastSavedAt >= saveSessionEveryMs) {
        this.persistSession();
      }
      return;
    }

    this.downSince ??= now;
    if (this.state === 'connected') this.setState('starting');
    if (now - this.downSince >= this.options.stallMs) {
      this.fail(new Error('The Messenger connection could not be set up.'));
    }
  }

  private fail(error: unknown): void {
    this.lastError = explain(error);
    this.tearDown();
    this.setState('disconnected');
    if (!this.running) return;

    const delays = this.options.retryDelaysMs;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 60_000;
    this.failures += 1;
    this.options.log.error(
      { error: this.lastError, retryInSeconds: Math.round(delay / 1000) },
      'Not connected to Facebook',
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private tearDown(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    try {
      this.listener?.stop?.();
    } catch {
      // Already closed.
    }
    this.listener = null;
    this.api = null;
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateSince = this.options.now();
  }

  private persistSession(): void {
    const api = this.api;
    if (!api?.getAppState || this.options.saveSessionEveryMs <= 0) return;
    try {
      const jar = api.getAppState();
      const cookies: SessionCookie[] = [];
      for (const entry of Array.isArray(jar) ? jar : []) {
        // The library hands out cookie objects; their JSON form has key and value.
        const plain = JSON.parse(JSON.stringify(entry)) as Partial<SessionCookie>;
        if (typeof plain.key !== 'string' || typeof plain.value !== 'string') continue;
        if (cookies.some((cookie) => cookie.key === plain.key)) continue;
        cookies.push({
          key: plain.key,
          value: plain.value,
          domain: plain.domain,
          path: plain.path,
        });
      }
      saveSession(this.options.sessionFile, cookies);
      this.lastSavedAt = this.options.now();
    } catch (error) {
      this.options.log.warn({ error: explain(error) }, 'The session file could not be renewed');
    }
  }

  private async learnOwnName(attempt: number): Promise<void> {
    const name = this.userId === null ? null : await this.nameOf(this.userId);
    if (attempt === this.attempt && name) this.accountName = name;
  }

  // ------------------------------------------------------------- messages

  private onEvent(attempt: number, error: unknown, event?: FcaEvent): void {
    if (attempt !== this.attempt || !this.running) return;
    if (error) {
      const type = (error as { type?: unknown }).type;
      if (type === 'parse_error') {
        // One message the library could not read; the connection is fine.
        this.options.log.warn({}, 'A Messenger event could not be read and was skipped');
        return;
      }
      return this.fail(error);
    }
    if (!event || (event.type !== 'message' && event.type !== 'message_reply')) return;
    if (event.threadID === undefined || event.senderID === undefined) return;

    const attachments = event.attachments ?? [];
    const text = typeof event.body === 'string' ? event.body : '';
    const only = attachments.length === 1 ? attachments[0] : undefined;
    const likeOnly =
      text.trim() === '' &&
      only?.type === 'sticker' &&
      LIKE_STICKERS.has(String(only.stickerID ?? only.ID ?? ''));
    const sentAt = Number(event.timestamp);
    const now = this.options.now();
    this.lastMessageAt = now;

    this.onMessage?.({
      threadId: String(event.threadID),
      senderId: String(event.senderID),
      messageId: typeof event.messageID === 'string' ? event.messageID : null,
      text,
      attachments: attachments.length,
      likeOnly,
      timestamp: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : now,
      fromSelf: String(event.senderID) === this.userId,
      isGroup: event.isGroup === true,
    });
  }

  private connectedApi(): FcaApi {
    if (!this.api || this.state !== 'connected') {
      throw new Error(
        this.lastError
          ? `Not connected to Facebook: ${this.lastError}`
          : 'Not connected to Facebook yet.',
      );
    }
    return this.api;
  }

  async sendText(threadId: string, text: string): Promise<{ messageId: string | null }> {
    const api = this.connectedApi();
    try {
      if (this.options.sendVia === 'http') {
        if (!api.sendMessage) throw new Error('The client library cannot send by web request.');
        // The last argument says the chat is with one person, which is all the assistant answers.
        const sent = await withTimeout(
          api.sendMessage(text, threadId, undefined, true),
          CALL_TIMEOUT_MS,
          'Sending the message',
        );
        return { messageId: typeof sent?.messageID === 'string' ? sent.messageID : null };
      }
      if (!api.sendMessageMqtt) throw new Error('The client library cannot send over Messenger.');
      await withTimeout(
        api.sendMessageMqtt(text, threadId),
        CALL_TIMEOUT_MS,
        'Sending the message',
      );
      return { messageId: null };
    } catch (error) {
      throw new Error(explain(error), { cause: error });
    }
  }

  async markRead(threadId: string): Promise<void> {
    const api = this.connectedApi();
    if (api.markAsRead)
      await withTimeout(api.markAsRead(threadId), CALL_TIMEOUT_MS, 'Marking as read');
  }

  async setTyping(threadId: string, typing: boolean): Promise<void> {
    const api = this.connectedApi();
    if (api.sendTypingIndicator) {
      await withTimeout(api.sendTypingIndicator(typing, threadId), CALL_TIMEOUT_MS, 'Typing sign');
    }
  }

  async nameOf(userId: string): Promise<string | null> {
    const api = this.api;
    if (!api?.getUserInfo) return null;
    try {
      const info = await withTimeout(api.getUserInfo(userId), CALL_TIMEOUT_MS, 'Looking up a name');
      const name = typeof info?.name === 'string' ? info.name.trim() : '';
      // The library's stand-in when Facebook gives no name.
      return name === '' || name === 'Facebook User' ? null : name;
    } catch {
      return null;
    }
  }
}
