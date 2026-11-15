import { timingSafeEqual } from 'node:crypto';
import {
  Graph,
  GraphError,
  explainGraphError,
  isOutsideWindow,
  isTokenRejected,
  isWorthRepeating,
} from './graph';
import type {
  IncomingMessage,
  SendOptions,
  Transport,
  TransportState,
  TransportStatus,
} from './types';

/*
  The connection to the Page's chat through Facebook's official interface, the
  Messenger Platform.

  Facebook delivers what customers write by calling this program (a
  "webhook"), and the program answers by calling Facebook with the Page's
  access token. On every start, and again every few minutes, it makes sure
  that Facebook has the right address on record and that the Page is switched
  on for the app, and repairs either by itself. Facebook switches a webhook
  off when the address did not answer for an hour.

  Everything the rest of the program knows of Facebook is in this file and in
  graph.ts.
*/

/** The path Facebook calls, under the public address. */
export const WEBHOOK_PATH = '/webhook';

/** What the assistant asks Facebook to report. */
export const WEBHOOK_FIELDS = [
  // What customers write.
  'messages',
  // What leaves the Page: how a reply typed by a person in the inbox is noticed.
  'message_echoes',
  // Buttons such as "Get started".
  'messaging_postbacks',
  // Facebook warning or restricting the Page.
  'messaging_policy_enforcement',
  // Another app (Meta Business AI, for one) holding a chat.
  'messaging_handovers',
  'standby',
] as const;

/** What the assistant cannot do without; the others add to what it notices. */
const ESSENTIAL_FIELDS = ['messages', 'message_echoes', 'messaging_postbacks'];

const NEEDED_PERMISSIONS = ['pages_messaging', 'pages_manage_metadata'];

/** How long after a customer's last message Facebook lets the Page write. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long it lets a person write, where the app is approved for the "human agent" tag. */
export const HUMAN_AGENT_WINDOW_MS = 7 * REPLY_WINDOW_MS;

/** Facebook takes at most this many characters in one message. */
const TEXT_LIMIT = 2000;

// Messenger's thumbs-up button sends one of these stickers.
const LIKE_STICKERS = new Set(['369239263222822', '369239343222814', '369239383222810']);

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_UNKNOWN_FOR_MS = 60 * 60 * 1000;

export interface MessengerLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export interface MessengerOptions {
  appId: string;
  appSecret: string;
  pageAccessToken: string;
  /** The Page the token must be for. '' = whichever Page the token belongs to. */
  pageId: string;
  /** The HTTPS address at which Facebook reaches this program, without a path. '' = not known. */
  publicUrl: string;
  /** The word Facebook repeats when it checks the address. '' = one made from the app secret. */
  verifyToken: string;
  /** The version of Facebook's interface, for example 'v27.0'. */
  graphVersion: string;
  /**
   * Send what a person of the team writes after the 24 hours with Facebook's
   * "human agent" tag, which allows 7 days. Facebook must have approved the
   * app for it.
   */
  humanAgentTag: boolean;
  /** How often the connection is looked over while it works. */
  checkEveryMs: number;
  /** Waits between attempts while it does not work. The last one repeats. */
  retryDelaysMs: number[];
  log: MessengerLog;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Replaced in tests. */
  fetch?: typeof globalThis.fetch;
}

type Given = Pick<MessengerOptions, 'appId' | 'appSecret' | 'pageAccessToken'>;

const DEFAULTS: Omit<MessengerOptions, keyof Given> = {
  pageId: '',
  publicUrl: '',
  verifyToken: '',
  graphVersion: 'v27.0',
  humanAgentTag: false,
  checkEveryMs: 10 * 60_000,
  retryDelaysMs: [15_000, 60_000, 2 * 60_000, 5 * 60_000],
  log: { info() {}, warn() {}, error() {} },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Something is wrong with the connection, already put into words for the team. */
class Problem extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function idIn(value: unknown): string | null {
  const id = record(value)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Cuts a long text into pieces Facebook takes, between paragraphs, lines, sentences or words. */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const [breaker, keep] of [
      ['\n\n', 0],
      ['\n', 0],
      ['. ', 1],
      [' ', 0],
    ] as const) {
      const at = window.lastIndexOf(breaker);
      if (at >= limit / 2) {
        cut = at + keep;
        break;
      }
    }
    if (cut === -1) {
      // One unbroken run of characters. Do not cut through a two-part character (an emoji).
      const last = window.charCodeAt(limit - 1);
      cut = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

export class MessengerTransport implements Transport {
  readonly name = 'messenger';
  readonly replyWindowMs = REPLY_WINDOW_MS;
  readonly staffReplyWindowMs: number;

  private readonly options: MessengerOptions;
  private readonly graph: Graph;
  private readonly verifyWord: string;
  private publicUrl: string;

  private onMessage: ((message: IncomingMessage) => void) | null = null;
  private running = false;
  private attempt = 0;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;

  private state: TransportState = 'stopped';
  private stateSince: number;
  private lastError: string | null = null;
  private lastMessageAt: number | null = null;

  private page: { id: string; name: string | null } | null = null;
  private tokenExpiresAt: number | null = null;
  /** What Facebook is asked to report. */
  private wanted: string[] = [...WEBHOOK_FIELDS];
  /** The address Facebook has on record, and what it reports there. */
  private webhook: { url: string; fields: string[] } | null = null;
  private otherApps: string[] = [];
  private standby: { count: number; lastAt: number } | null = null;
  private enforcement: { at: number; text: string } | null = null;
  private strangerPages = new Set<string>();
  private names = new Map<string, { name: string | null; until: number }>();

  constructor(options: Partial<MessengerOptions> & Given) {
    this.options = { ...DEFAULTS, ...options };
    this.graph = new Graph({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      version: this.options.graphVersion,
      fetch: this.options.fetch,
    });
    this.verifyWord = this.options.verifyToken || this.graph.derivedVerifyToken();
    this.publicUrl = this.options.publicUrl.replace(/\/+$/, '');
    this.staffReplyWindowMs = this.options.humanAgentTag ? HUMAN_AGENT_WINDOW_MS : REPLY_WINDOW_MS;
    this.stateSince = this.options.now();
  }

  async start(onMessage: (message: IncomingMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.running = true;
    this.failures = 0;
    await this.check();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.attempt += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setState('stopped');
  }

  /**
   * The public address has changed (a try-out tunnel gets a new one whenever
   * it is opened). Facebook is given the new one at once.
   */
  async setPublicUrl(url: string): Promise<void> {
    const next = url.replace(/\/+$/, '');
    if (next === this.publicUrl) return;
    this.publicUrl = next;
    if (this.running) await this.check();
  }

  status(): TransportStatus {
    const { options } = this;
    const details = [
      { label: 'Facebook app', value: `id ${options.appId}` },
      {
        label: 'Messages arrive at',
        value: this.webhook?.url ?? 'no address registered with Facebook yet',
      },
      {
        label: 'Access token',
        value:
          this.page === null
            ? 'not checked yet'
            : this.tokenExpiresAt === null
              ? 'does not expire'
              : `ends on ${day(this.tokenExpiresAt)}`,
      },
      {
        label: 'After 24 hours',
        value: options.humanAgentTag
          ? 'people of the team can still write from the dashboard, for 7 days (human agent tag)'
          : 'nothing can be sent from the dashboard; the team answers in Meta Business Suite',
      },
      { label: 'Interface', value: `Messenger Platform, Graph API ${options.graphVersion}` },
    ];

    const now = options.now();
    const notes: string[] = [];
    if (this.tokenExpiresAt !== null && this.tokenExpiresAt - now < 14 * DAY_MS) {
      notes.push(
        `The access token stops working on ${day(this.tokenExpiresAt)}. Create a new one before ` +
          'then ("pnpm fb:check --save-page-token" makes one that does not expire).',
      );
    }
    if (this.enforcement) {
      notes.push(`Facebook reported on ${day(this.enforcement.at)}: ${this.enforcement.text}`);
    }
    if (this.standby && now - this.standby.lastAt < DAY_MS) {
      const { count } = this.standby;
      notes.push(
        `${count} ${count === 1 ? 'message' : 'messages'} from customers arrived marked as ` +
          'belonging to another app, and the assistant left them alone. See "Other apps on the ' +
          'Page" in the README.',
      );
    }
    if (this.otherApps.length > 0) {
      notes.push(
        `Also connected to the Page: ${this.otherApps.join(', ')}. If one of them answers ` +
          'customers too, they get two answers.',
      );
    }
    const missing = this.webhook
      ? WEBHOOK_FIELDS.filter((field) => !this.webhook!.fields.includes(field))
      : [];
    if (missing.length > 0) {
      notes.push(
        `Facebook does not report these to the assistant: ${missing.join(', ')}. ` +
          (this.publicUrl === ''
            ? 'Set PUBLIC_URL and the assistant registers them itself.'
            : 'It answers customers all the same, but notices less of what else happens in the chats.'),
      );
    }

    return {
      state: this.state,
      since: this.stateSince,
      account: this.page ? { id: this.page.id, name: this.page.name, kind: 'page' } : null,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      details,
      notes,
    };
  }

  // ----------------------------------------------------------- connecting

  /**
   * Looks the connection over: the token, the address Facebook has on record
   * and the Page's subscription, and sets right what it can. Never throws:
   * trouble goes to the status, and another attempt follows.
   */
  async check(): Promise<void> {
    if (!this.running) return;
    const attempt = ++this.attempt;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state !== 'connected') this.setState('starting');

    try {
      await this.checkToken();
      await this.checkWebhook();
      await this.checkPageSubscription();
    } catch (error) {
      if (attempt !== this.attempt || !this.running) return;
      return this.fail(error);
    }
    if (attempt !== this.attempt || !this.running) return;

    if (this.state !== 'connected') {
      this.options.log.info(
        { page: this.page?.name ?? this.page?.id, address: this.webhook?.url },
        'Connected to Messenger',
      );
    }
    this.lastError = null;
    this.failures = 0;
    this.setState('connected');
    this.again(this.options.checkEveryMs);
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Problem ? error.message : explainGraphError(error);
    this.setState('disconnected');
    const delays = this.options.retryDelaysMs;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 60_000;
    this.failures += 1;
    this.options.log.error(
      { error: this.lastError, retryInSeconds: Math.round(delay / 1000) },
      'Not connected to Messenger',
    );
    this.again(delay);
  }

  private again(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delayMs);
    // Looking the connection over must not keep the program from stopping.
    this.timer.unref?.();
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateSince = this.options.now();
  }

  private async asApp<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (error) {
      throw new Problem(explainGraphError(error, 'app'), { cause: error });
    }
  }

  private async asPage<T>(call: Promise<T>): Promise<T> {
    try {
      return await call;
    } catch (error) {
      throw new Problem(explainGraphError(error, 'page'), { cause: error });
    }
  }

  private async checkToken(): Promise<void> {
    const { graph, options } = this;
    const info = await this.asApp(graph.lookUpToken(options.pageAccessToken));
    if (!info.valid) {
      throw new Problem(explainGraphError(new GraphError(info.problem ?? 'invalid', 400, 190)));
    }
    if (info.appId !== null && info.appId !== options.appId) {
      throw new Problem(
        `The access token was made for another Facebook app (id ${info.appId}), not for the app ` +
          `in FB_APP_ID (${options.appId}). Create the token in this app\u2019s dashboard.`,
      );
    }
    if (info.kind !== 'page') {
      throw new Problem(
        'FB_PAGE_ACCESS_TOKEN holds the token of a person, not of the Page. Run ' +
          '"pnpm fb:check --save-page-token": it turns it into a token of the Page that does ' +
          'not expire.',
      );
    }
    const lacking = NEEDED_PERMISSIONS.filter((name) => !info.permissions.includes(name));
    if (lacking.length > 0) {
      throw new Problem(
        `The access token lacks the permission ${lacking.join(' and ')}. Create it again in the ` +
          'app\u2019s dashboard, signed in as someone who manages the Page, and leave every ' +
          'permission ticked.',
      );
    }

    const me = await this.asPage(
      graph.get<{ id?: unknown; name?: unknown }>('me', options.pageAccessToken, {
        fields: 'id,name',
      }),
    );
    const id = idIn(me);
    if (id === null) throw new Problem('Facebook did not say which Page the access token is for.');
    if (options.pageId !== '' && options.pageId !== id) {
      throw new Problem(
        `The access token is for the Page with id ${id}, but FB_PAGE_ID names ${options.pageId}. ` +
          'Create the token for the right Page, or correct FB_PAGE_ID.',
      );
    }
    this.page = { id, name: typeof me.name === 'string' && me.name !== '' ? me.name : null };
    this.tokenExpiresAt = info.expiresAt;
  }

  private async checkWebhook(): Promise<void> {
    const { graph, options } = this;
    const wanted = this.publicUrl === '' ? null : `${this.publicUrl}${WEBHOOK_PATH}`;

    const listed = await this.asApp(
      graph.get<{ data?: unknown[] }>(`${options.appId}/subscriptions`, graph.appToken),
    );
    const current = (listed.data ?? []).map(record).find((entry) => entry?.object === 'page');
    const active = current !== undefined && current !== null && current.active !== false;
    const address = active && typeof current.callback_url === 'string' ? current.callback_url : '';
    const fields = active && Array.isArray(current.fields) ? current.fields.map(fieldName) : [];

    if (wanted === null) {
      if (address === '' || !fields.includes('messages')) {
        this.webhook = null;
        throw new Problem(
          'Facebook has no address to deliver the Page\u2019s messages to. Set PUBLIC_URL in .env ' +
            'to the HTTPS address under which this program is reachable from the internet, or ' +
            'start it with --tunnel to try it out.',
        );
      }
      this.webhook = { url: address, fields };
      return;
    }

    const complete = this.wanted.every((field) => fields.includes(field));
    if (address !== wanted || !complete) {
      try {
        await this.withFields((list) =>
          graph.postForm(`${options.appId}/subscriptions`, graph.appToken, {
            object: 'page',
            callback_url: wanted,
            verify_token: this.verifyWord,
            fields: list.join(','),
            include_values: true,
          }),
        );
      } catch (error) {
        this.webhook = address === '' ? null : { url: address, fields };
        if (error instanceof GraphError && error.reached && error.code !== 190) {
          // Facebook calls the address before it accepts it, and says what it got.
          throw new Problem(
            `Facebook did not accept ${wanted} as the address for the Page\u2019s messages: ` +
              `\u201c${error.message}\u201d. The address must be reachable from the internet over ` +
              'HTTPS and lead to the webhook port of this program.',
            { cause: error },
          );
        }
        throw new Problem(explainGraphError(error, 'app'), { cause: error });
      }
      options.log.info(
        { address: wanted, before: address || null },
        'Facebook now delivers the Page\u2019s messages to this address',
      );
    }
    this.webhook = { url: wanted, fields: [...this.wanted] };
  }

  private async checkPageSubscription(): Promise<void> {
    const { graph, options } = this;
    const page = this.page!;

    const listed = await this.asPage(
      graph.get<{ data?: unknown[] }>(`${page.id}/subscribed_apps`, options.pageAccessToken),
    );
    const apps = (listed.data ?? []).map(record).filter((app) => app !== null);
    const mine = apps.find((app) => idIn(app) === options.appId);
    const have = Array.isArray(mine?.subscribed_fields) ? mine.subscribed_fields.map(String) : [];

    if (!this.wanted.every((field) => have.includes(field))) {
      await this.asPage(
        this.withFields((list) =>
          graph.postForm(`${page.id}/subscribed_apps`, options.pageAccessToken, {
            subscribed_fields: list.join(','),
          }),
        ),
      );
      options.log.info(
        { page: page.name ?? page.id, before: have },
        mine
          ? 'The Page\u2019s subscription to the app was incomplete and has been renewed'
          : 'The Page is now switched on for the app',
      );
    }
    this.otherApps = apps
      .filter((app) => idIn(app) !== options.appId)
      .map((app) =>
        typeof app.name === 'string' && app.name !== '' ? app.name : `app ${idIn(app)}`,
      );
  }

  /**
   * Asks Facebook for everything the assistant can use, and settles for what
   * it cannot do without when Facebook does not accept the list.
   */
  private async withFields(send: (fields: string[]) => Promise<unknown>): Promise<void> {
    try {
      await send(this.wanted);
    } catch (error) {
      const refusedTheList = error instanceof GraphError && error.code === 100;
      if (!refusedTheList || this.wanted.length === ESSENTIAL_FIELDS.length) throw error;
      await send(ESSENTIAL_FIELDS);
      this.wanted = ESSENTIAL_FIELDS;
      this.options.log.warn(
        { refused: (error as GraphError).message },
        'Facebook did not accept the full list of things to report; the assistant goes on with the essential ones',
      );
    }
  }

  // ------------------------------------------------ what Facebook sends us

  /**
   * Facebook checks an address before it uses it: it calls it with a word of
   * our choosing and a number, and wants the number back. Returns that
   * number, or null when the call is not Facebook's.
   */
  answerToVerification(query: Record<string, unknown>): string | null {
    const mode = query['hub.mode'];
    const word = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode !== 'subscribe' || typeof word !== 'string' || typeof challenge !== 'string') {
      return null;
    }
    return sameText(word, this.verifyWord) ? challenge : null;
  }

  /** True when the bytes carry the signature Facebook makes with the app secret. */
  isSignedByFacebook(body: Buffer, signature: unknown): boolean {
    return typeof signature === 'string' && sameText(signature, this.graph.signatureOf(body));
  }

  /**
   * Takes in what Facebook delivered. The caller has checked the signature.
   * Returns false when it is not about a Page at all.
   */
  receive(payload: unknown): boolean {
    const body = record(payload);
    if (body?.object !== 'page' || !Array.isArray(body.entry)) return false;

    for (const raw of body.entry) {
      const entry = record(raw);
      if (!entry) continue;
      const pageId = entry.id === undefined ? null : String(entry.id);
      if (this.page && pageId !== null && pageId !== this.page.id) {
        // The app is switched on for another Page as well. Not ours to answer.
        if (!this.strangerPages.has(pageId)) {
          this.strangerPages.add(pageId);
          this.options.log.warn(
            { page: pageId },
            'Facebook delivers messages of another Page to this app; they are left alone',
          );
        }
        continue;
      }
      if (Array.isArray(entry.standby) && entry.standby.length > 0) this.onStandby(entry.standby);
      if (!Array.isArray(entry.messaging)) continue;
      for (const event of entry.messaging) {
        try {
          this.onEvent(record(event));
        } catch (error) {
          this.options.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'An event from Facebook could not be taken in',
          );
        }
      }
    }
    return true;
  }

  private onEvent(event: Record<string, unknown> | null): void {
    if (!event) return;
    const sender = idIn(event.sender);
    const recipient = idIn(event.recipient);
    const sentAt = Number(event.timestamp);
    const now = this.options.now();
    const timestamp = Number.isFinite(sentAt) && sentAt > 0 ? sentAt : now;

    const enforcement = record(event.policy_enforcement ?? event['policy-enforcement']);
    if (enforcement) return this.onEnforcement(enforcement, timestamp);

    const message = record(event.message);
    if (message) {
      if (sender === null || recipient === null) return;
      const messageId = typeof message.mid === 'string' ? message.mid : null;
      const text = typeof message.text === 'string' ? message.text : '';
      const { count, likeOnly } = countAttachments(message.attachments, text);

      if (message.is_echo === true) {
        // What left the Page. The assistant's own messages come back here too,
        // marked with this app's id; anything else was written by a person in
        // the Page's inbox, or by another app.
        if (String(message.app_id ?? '') === this.options.appId) return;
        if (text === '' && count === 0) return;
        this.lastMessageAt = now;
        return this.onMessage?.({
          threadId: recipient,
          senderId: sender,
          messageId,
          text,
          attachments: count,
          likeOnly: false,
          timestamp,
          fromSelf: true,
          isGroup: false,
        });
      }

      // A note Facebook's own tools leave when they pass a chat on, without a message in it.
      if (messageId === null && text === '' && count === 0) return;
      this.lastMessageAt = now;
      return this.onMessage?.({
        threadId: sender,
        senderId: sender,
        messageId,
        text,
        attachments: count,
        likeOnly,
        timestamp,
        fromSelf: false,
        isGroup: false,
      });
    }

    const postback = record(event.postback);
    if (postback && sender !== null) {
      // A button of the chat was pressed ("Get started", a menu entry). Taken
      // as if the customer had written what the button says.
      const title = typeof postback.title === 'string' ? postback.title.trim() : '';
      const payload = typeof postback.payload === 'string' ? postback.payload.trim() : '';
      const text = title || payload;
      if (text === '') return;
      this.lastMessageAt = now;
      return this.onMessage?.({
        threadId: sender,
        senderId: sender,
        // Facebook repeats a delivery that got no answer; the same press is the same message.
        messageId:
          typeof postback.mid === 'string' ? postback.mid : `postback.${sender}.${timestamp}`,
        text,
        attachments: 0,
        likeOnly: false,
        timestamp,
        fromSelf: false,
        isGroup: false,
      });
    }
    // Everything else (read and delivery marks, reactions, chats passed between apps) needs no answer.
  }

  private onStandby(events: unknown[]): void {
    // Messages in chats that another app holds. Facebook asks apps not to answer those.
    const fromCustomers = events
      .map(record)
      .filter(
        (event) => record(event?.message) !== null && record(event?.message)?.is_echo !== true,
      );
    if (fromCustomers.length === 0) return;
    const now = this.options.now();
    const recent = this.standby && now - this.standby.lastAt < DAY_MS ? this.standby.count : 0;
    if (recent === 0) {
      this.options.log.warn(
        {},
        'A customer\u2019s message arrived marked as belonging to another app; the assistant leaves such chats alone',
      );
    }
    this.standby = { count: recent + fromCustomers.length, lastAt: now };
  }

  private onEnforcement(enforcement: Record<string, unknown>, at: number): void {
    const action = typeof enforcement.action === 'string' ? enforcement.action : 'notice';
    const reason = typeof enforcement.reason === 'string' ? enforcement.reason.trim() : '';
    if (action === 'unblock') {
      this.enforcement = null;
      this.options.log.info({}, 'Facebook has lifted its restriction on the Page');
      return;
    }
    const text =
      action === 'block'
        ? `the Page is blocked from sending messages. ${reason}`
        : `a warning about the Page\u2019s messages. ${reason}`;
    this.enforcement = { at, text: text.trim() };
    this.options.log.error({ action, reason }, 'Facebook reported a problem with the Page');
  }

  // -------------------------------------------------- what we send Facebook

  private pageOrThrow(): { id: string; name: string | null } {
    if (!this.page) {
      throw new Error(
        this.lastError
          ? `Not connected to Facebook: ${this.lastError}`
          : 'Not connected to Facebook yet.',
      );
    }
    return this.page;
  }

  async sendText(
    threadId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<{ messageId: string | null }> {
    const page = this.pageOrThrow();
    let messageId: string | null = null;
    for (const part of splitText(text)) {
      messageId = await this.sendPart(page.id, threadId, part, options.byPerson === true);
    }
    return { messageId };
  }

  private async sendPart(
    pageId: string,
    threadId: string,
    text: string,
    byPerson: boolean,
  ): Promise<string | null> {
    const base = { recipient: { id: threadId }, message: { text } };
    const answer = { ...base, messaging_type: 'RESPONSE' };
    try {
      return await this.deliver(pageId, answer);
    } catch (error) {
      if (isOutsideWindow(error) && byPerson && this.options.humanAgentTag) {
        // Facebook allows a person 7 days where it allows a program 24 hours.
        try {
          return await this.deliver(pageId, {
            ...base,
            messaging_type: 'MESSAGE_TAG',
            tag: 'HUMAN_AGENT',
          });
        } catch (second) {
          throw this.sendFailure(second);
        }
      }
      throw this.sendFailure(error);
    }
  }

  /** Hands one message to Facebook, repeating only where Facebook itself said it did not go through. */
  private async deliver(pageId: string, body: Record<string, unknown>): Promise<string | null> {
    const { graph, options } = this;
    for (let tries = 0; ; tries += 1) {
      try {
        const sent = await graph.post<{ message_id?: unknown }>(
          `${pageId}/messages`,
          options.pageAccessToken,
          body,
        );
        return typeof sent.message_id === 'string' ? sent.message_id : null;
      } catch (error) {
        if (tries >= 2 || !isWorthRepeating(error)) throw error;
        await options.sleep(500 * (tries + 1));
      }
    }
  }

  private sendFailure(error: unknown): Error {
    const explained = explainGraphError(error, 'page');
    if (isTokenRejected(error) && this.running) {
      // Nothing can be sent any more: say so on the dashboard at once, not at the next check.
      this.attempt += 1;
      this.fail(new Problem(explained));
    }
    return new Error(explained, { cause: error });
  }

  private async act(threadId: string, action: 'mark_seen' | 'typing_on' | 'typing_off') {
    const page = this.pageOrThrow();
    await this.graph.post(`${page.id}/messages`, this.options.pageAccessToken, {
      recipient: { id: threadId },
      sender_action: action,
    });
  }

  markRead(threadId: string): Promise<void> {
    return this.act(threadId, 'mark_seen');
  }

  setTyping(threadId: string, typing: boolean): Promise<void> {
    return this.act(threadId, typing ? 'typing_on' : 'typing_off');
  }

  async nameOf(userId: string): Promise<string | null> {
    const page = this.page;
    if (!page) return null;
    if (userId === page.id) return page.name;
    const now = this.options.now();
    const known = this.names.get(userId);
    if (known && known.until > now) return known.name;

    const name = (await this.nameFromProfile(userId)) ?? (await this.nameFromChat(page.id, userId));
    this.names.set(userId, {
      name,
      until: name === null ? now + NAME_UNKNOWN_FOR_MS : Number.POSITIVE_INFINITY,
    });
    return name;
  }

  /** Facebook hands profiles out to apps it has approved for them. */
  private async nameFromProfile(userId: string): Promise<string | null> {
    try {
      const profile = await this.graph.get<Record<string, unknown>>(
        userId,
        this.options.pageAccessToken,
        { fields: 'name,first_name,last_name' },
      );
      const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
      const name = text(profile.name) || `${text(profile.first_name)} ${text(profile.last_name)}`;
      return name.trim() || null;
    } catch {
      return null;
    }
  }

  /** The Page's own list of chats names who it is talking to. */
  private async nameFromChat(pageId: string, userId: string): Promise<string | null> {
    try {
      const chats = await this.graph.get<{ data?: unknown[] }>(
        `${pageId}/conversations`,
        this.options.pageAccessToken,
        { platform: 'messenger', user_id: userId, fields: 'participants' },
      );
      for (const chat of chats.data ?? []) {
        const people = record(record(chat)?.participants)?.data;
        for (const person of Array.isArray(people) ? people : []) {
          const name = record(person)?.name;
          if (idIn(person) === userId && typeof name === 'string' && name.trim() !== '') {
            return name.trim();
          }
        }
      }
    } catch {
      // No name, then; the assistant asks the customer for it.
    }
    return null;
  }
}

/** Compares without giving away, by the time it takes, how much of a guess was right. */
function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Facebook lists subscribed fields as names, or as objects with a name. */
function fieldName(field: unknown): string {
  const name = record(field)?.name;
  return typeof name === 'string' ? name : String(field);
}

/**
 * How many things were sent along with a message, and whether it is nothing
 * but the thumbs-up button. The preview Facebook makes of a link written in
 * the text is not something the customer sent.
 */
function countAttachments(value: unknown, text: string): { count: number; likeOnly: boolean } {
  const list = (Array.isArray(value) ? value : []).map(record).filter((item) => item !== null);
  const sent = text === '' ? list : list.filter((item) => item.type !== 'fallback');
  const isLike = (item: Record<string, unknown>) =>
    LIKE_STICKERS.has(String(record(item.payload)?.sticker_id ?? ''));
  // For a while Facebook sent a sticker twice, as a sticker and as an image.
  const likeOnly = text === '' && list.length > 0 && list.every(isLike);
  return { count: likeOnly ? 1 : sent.length, likeOnly };
}
