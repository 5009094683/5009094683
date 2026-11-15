import { createHmac } from 'node:crypto';

/*
  Stands in for Facebook's Graph API in the tests. It answers the calls the
  assistant makes the way Facebook's documentation describes them, keeps what
  was asked of it, and checks what Facebook checks: that the token is in the
  request header, that calls for the Page carry the proof made with the app
  secret, and that a webhook address answers before it is accepted.
*/

export interface FakeRequest {
  method: string;
  /** Without the version, e.g. "700000000000001/messages". */
  path: string;
  /** The address as it was called, to check that no secret is in it. */
  url: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  token: string;
}

export interface FakeSend {
  to: string;
  text: string;
  messagingType: string;
  tag: string | null;
  messageId: string;
}

interface Failure {
  method: string;
  path: RegExp;
  status: number;
  error: Record<string, unknown> | null;
  times: number;
}

export const ALL_PAGE_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks',
  'messaging_policy_enforcement',
  'messaging_handovers',
  'standby',
  'message_reads',
  'message_deliveries',
];

export class FakeFacebook {
  readonly version = 'v27.0';
  readonly appId = '555500001111';
  readonly appSecret = 'the-app-secret';
  readonly pageToken = 'EAA-page-token';
  readonly personToken = 'EAA-person-token';
  readonly page = { id: '700000000000001', name: 'Cao Bằng Travel Guide' };

  /** What Facebook knows of the Page's token. */
  token = {
    valid: true,
    type: 'PAGE' as 'PAGE' | 'USER',
    appId: this.appId,
    /** Seconds since 1970; 0 = never. */
    expiresAt: 0,
    scopes: [
      'pages_show_list',
      'pages_messaging',
      'pages_manage_metadata',
      'pages_read_engagement',
      'business_management',
    ],
  };

  /** The app's webhook for Pages, as registered. */
  subscription: { callback_url: string; fields: string[]; active: boolean } | null = null;
  /** The apps the Page is switched on for. */
  subscribedApps: Array<{ id: string; name: string; subscribed_fields: string[] }> = [];
  /** Field names Facebook accepts; narrowed by a test to play a refusal. */
  acceptedFields = new Set(ALL_PAGE_FIELDS);

  /** Plays Facebook calling the address before accepting it. */
  verifyCallback: (url: string, verifyToken: string) => Promise<boolean> = async () => true;

  /** People who wrote to the Page more than 24 hours ago. */
  outsideWindow = new Set<string>();
  /** The app is approved for the human agent tag. */
  humanAgentApproved = true;
  /** Profiles Facebook hands out, by id. */
  profiles = new Map<string, { name?: string; first_name?: string; last_name?: string }>();
  /** Names in the Page's own list of chats, by id. */
  chats = new Map<string, string>();

  readonly requests: FakeRequest[] = [];
  readonly sent: FakeSend[] = [];
  readonly actions: Array<{ to: string; action: string }> = [];
  private failures: Failure[] = [];
  private counter = 0;

  get appToken(): string {
    return `${this.appId}|${this.appSecret}`;
  }

  /** The next `times` calls matching method and path fail like this. `error: null` = unreachable. */
  failing(
    method: string,
    path: RegExp,
    error: Record<string, unknown> | null,
    times = 1,
    status = 400,
  ): void {
    this.failures.push({ method, path, status, error, times });
  }

  sentTo(id: string): string[] {
    return this.sent.filter((send) => send.to === id).map((send) => send.text);
  }

  calls(method: string, path: RegExp): FakeRequest[] {
    return this.requests.filter((request) => request.method === method && path.test(request.path));
  }

  // ------------------------------------------------------- as the network

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const path = url.pathname.replace(new RegExp(`^/${this.version}/`), '');
    const query = Object.fromEntries(url.searchParams);

    let body: Record<string, unknown> = {};
    const text = typeof init?.body === 'string' ? init.body : '';
    if (text !== '') {
      body = (headers.get('content-type') ?? '').includes('json')
        ? (JSON.parse(text) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(text));
    }
    const request: FakeRequest = { method, path, url: url.toString(), query, body, token };
    this.requests.push(request);

    const failure = this.failures.find((f) => f.method === method && f.path.test(path));
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.failures = this.failures.filter((f) => f !== failure);
      if (failure.error === null) {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      }
      return json(failure.status, { error: failure.error });
    }

    try {
      return json(200, await this.answer(request));
    } catch (error) {
      if (error instanceof Refusal) return json(error.status, { error: error.body });
      throw error;
    }
  };

  private async answer(request: FakeRequest): Promise<unknown> {
    const { method, path, query, body, token } = request;
    const asApp = () => {
      if (token !== this.appToken) {
        throw new Refusal(190, 'Error validating application. Invalid application secret');
      }
    };
    const asPage = () => {
      if (token !== this.pageToken || !this.token.valid) {
        throw new Refusal(190, 'Error validating access token: The session has been invalidated.');
      }
      this.proven(request);
    };

    if (method === 'GET' && path === 'debug_token') {
      asApp();
      if (
        query.input_token === this.personToken ||
        query.input_token === `long-${this.personToken}`
      ) {
        return {
          data: {
            app_id: this.appId,
            type: 'USER',
            application: 'Booking assistant',
            is_valid: true,
            // The token of a person lasts an hour or two, or two months once extended.
            expires_at: 1_800_000_000,
            user_id: '100000000000042',
            scopes: this.token.scopes,
          },
        };
      }
      const known = query.input_token === this.pageToken;
      if (!known || !this.token.valid) {
        return {
          data: {
            is_valid: false,
            scopes: [],
            error: { code: 190, message: 'Error validating access token: Session has expired.' },
          },
        };
      }
      return {
        data: {
          app_id: this.token.appId,
          type: this.token.type,
          application: 'Booking assistant',
          is_valid: true,
          expires_at: this.token.expiresAt,
          data_access_expires_at: 0,
          profile_id: this.token.type === 'PAGE' ? this.page.id : undefined,
          user_id: '100000000000042',
          scopes: this.token.scopes,
        },
      };
    }

    if (method === 'GET' && path === 'me') {
      if (token === this.personToken || token === `long-${this.personToken}`) {
        this.proven(request);
        return { id: '100000000000042', name: 'Thu Hien' };
      }
      asPage();
      return { id: this.page.id, name: this.page.name };
    }

    if (method === 'GET' && path === 'oauth/access_token') {
      asApp();
      if (query.client_secret !== this.appSecret || query.fb_exchange_token !== this.personToken) {
        throw new Refusal(190, 'Invalid OAuth access token.');
      }
      return {
        access_token: `long-${this.personToken}`,
        token_type: 'bearer',
        expires_in: 5184000,
      };
    }

    if (method === 'GET' && path === 'me/accounts') {
      if (token !== `long-${this.personToken}` && token !== this.personToken) {
        throw new Refusal(190, 'Invalid OAuth access token.');
      }
      this.proven(request);
      return {
        data: [
          {
            id: this.page.id,
            name: this.page.name,
            access_token: this.pageToken,
            tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'],
          },
        ],
      };
    }

    if (path === `${this.appId}/subscriptions`) {
      asApp();
      if (method === 'GET') {
        const s = this.subscription;
        return {
          data: s
            ? [
                {
                  object: 'page',
                  callback_url: s.callback_url,
                  active: s.active,
                  fields: s.fields.map((name) => ({ name, version: this.version })),
                },
              ]
            : [],
        };
      }
      const fields = this.fieldsIn(String(body.fields ?? ''));
      if (body.object !== 'page') throw new Refusal(100, '(#100) Invalid parameter', 400);
      const address = String(body.callback_url ?? '');
      if (!(await this.verifyCallback(address, String(body.verify_token ?? '')))) {
        throw new Refusal(
          2200,
          '(#2200) Callback verification failed with the following errors: HTTP Status Code = 403; HTTP Message = Forbidden',
        );
      }
      // Facebook adds to the fields already subscribed, it does not replace them.
      const before = this.subscription?.callback_url === address ? this.subscription.fields : [];
      this.subscription = {
        callback_url: address,
        fields: [...new Set([...before, ...fields])],
        active: true,
      };
      return { success: true };
    }

    if (path === `${this.page.id}/subscribed_apps`) {
      asPage();
      if (method === 'GET') return { data: this.subscribedApps };
      const fields = this.fieldsIn(String(body.subscribed_fields ?? ''));
      this.subscribedApps = [
        ...this.subscribedApps.filter((app) => app.id !== this.appId),
        { id: this.appId, name: 'Booking assistant', subscribed_fields: fields },
      ];
      return { success: true };
    }

    if (method === 'POST' && path === `${this.page.id}/messages`) {
      asPage();
      const to = String((body.recipient as { id?: unknown } | undefined)?.id ?? '');
      if (typeof body.sender_action === 'string') {
        if (body.message !== undefined) {
          throw new Refusal(
            100,
            'Cannot send both message and state at the same time.',
            400,
            2018014,
          );
        }
        this.actions.push({ to, action: body.sender_action });
        return { recipient_id: to };
      }
      const text = String((body.message as { text?: unknown } | undefined)?.text ?? '');
      if (text.length > 2000)
        throw new Refusal(
          100,
          '(#100) Length of param message[text] must be less than or equal to 2000',
          400,
        );
      const tag = typeof body.tag === 'string' ? body.tag : null;
      const tagged = body.messaging_type === 'MESSAGE_TAG' && tag === 'HUMAN_AGENT';
      if (this.outsideWindow.has(to) && !(tagged && this.humanAgentApproved)) {
        throw new Refusal(
          10,
          '(#10) This message is sent outside of allowed window. Learn more about the new policy here: https://developers.facebook.com/docs/messenger-platform/policy-overview',
          400,
          2018278,
        );
      }
      this.counter += 1;
      const messageId = `m_fake${this.counter}`;
      this.sent.push({ to, text, messagingType: String(body.messaging_type), tag, messageId });
      return { recipient_id: to, message_id: messageId };
    }

    if (method === 'GET' && path === `${this.page.id}/conversations`) {
      asPage();
      const name = this.chats.get(String(query.user_id));
      if (name === undefined) return { data: [] };
      return {
        data: [
          {
            id: 't_1',
            participants: {
              data: [
                { name, email: `${query.user_id}@facebook.com`, id: query.user_id },
                { name: this.page.name, email: `${this.page.id}@facebook.com`, id: this.page.id },
              ],
            },
          },
        ],
      };
    }

    if (method === 'GET' && /^\d+$/.test(path)) {
      asPage();
      const profile = this.profiles.get(path);
      if (!profile) {
        throw new Refusal(2018247, 'Insufficient permission to access user profile.', 403);
      }
      return { ...profile, id: path };
    }

    throw new Refusal(100, `Unsupported ${method} request to ${path}`, 400, 33);
  }

  /** Calls for a Page or a person must prove that the caller holds the app secret. */
  private proven(request: FakeRequest): void {
    const expected = createHmac('sha256', this.appSecret).update(request.token).digest('hex');
    if (request.query.appsecret_proof !== expected) {
      throw new Refusal(100, 'Invalid appsecret_proof provided in the API argument', 400);
    }
  }

  private fieldsIn(list: string): string[] {
    const fields = list
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
    const unknown = fields.filter((field) => !this.acceptedFields.has(field));
    if (unknown.length > 0 || fields.length === 0) {
      throw new Refusal(
        100,
        `(#100) Param fields must be one of the allowed values, got: ${unknown.join(',')}`,
        400,
      );
    }
    return fields;
  }

  // ------------------------------------------------- as the webhook caller

  private nextMid(): string {
    this.counter += 1;
    return `m_in${this.counter}`;
  }

  /** What Facebook delivers when a customer writes to the Page. */
  customerWrites(
    psid: string,
    text: string,
    extra: { mid?: string; attachments?: unknown[]; at?: number } = {},
  ): unknown {
    return this.delivery({
      sender: { id: psid },
      recipient: { id: this.page.id },
      timestamp: extra.at ?? 1_800_000_000_000,
      message: {
        mid: extra.mid ?? this.nextMid(),
        ...(text === '' ? {} : { text }),
        ...(extra.attachments ? { attachments: extra.attachments } : {}),
      },
    });
  }

  /** What Facebook delivers when a message leaves the Page: sent by an app, or typed in the inbox. */
  pageWrote(psid: string, text: string, appId: string | number, mid = this.nextMid()): unknown {
    return this.delivery({
      sender: { id: this.page.id },
      recipient: { id: psid },
      timestamp: 1_800_000_000_000,
      message: { is_echo: true, app_id: appId, mid, text },
    });
  }

  delivery(...events: unknown[]): unknown {
    return {
      object: 'page',
      entry: [{ id: this.page.id, time: 1_800_000_000_500, messaging: events }],
    };
  }

  /**
   * The bytes Facebook sends for a payload: JSON with every character outside
   * ASCII written as an escape and every slash escaped. The signature is made
   * over exactly these bytes.
   */
  static bytes(payload: unknown): string {
    return JSON.stringify(payload)
      .replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .replace(/\//g, '\\/');
  }

  sign(bytes: string, secret = this.appSecret): string {
    return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
  }
}

/** The id of Facebook's own inbox (Meta Business Suite), which marks what a person typed there. */
export const PAGE_INBOX_APP_ID = '263902037430900';

class Refusal extends Error {
  readonly body: Record<string, unknown>;
  constructor(
    code: number,
    message: string,
    readonly status = 400,
    subcode?: number,
  ) {
    super(message);
    this.body = {
      message,
      type: 'OAuthException',
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: 'AbCdEfGhIjK',
    };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
