import { createHmac } from 'node:crypto';

/*
  Calls to Facebook's official interface (the Graph API), and its errors put
  into words the team can act on.

  The token a call is made with travels in a request header, never in the
  address. Nothing here writes a token or the app secret into a log line or an
  error message. Two calls hand Facebook a secret as a parameter because its
  interface asks for it that way (looking a token up, and extending one); they
  are only made over the encrypted connection to Facebook.
*/

export interface GraphOptions {
  appId: string;
  appSecret: string;
  /** The version of Facebook's interface to speak, for example 'v27.0'. */
  version: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Replaced in tests. */
  fetch?: typeof globalThis.fetch;
}

export type GraphQuery = Record<string, string | number | boolean | undefined>;

export interface TokenInfo {
  valid: boolean;
  /** Why it is not valid, in Facebook's words. */
  problem: string | null;
  kind: 'page' | 'person' | 'other';
  /** The app the token was made for. */
  appId: string | null;
  ownerId: string | null;
  /** Null: it does not expire. */
  expiresAt: number | null;
  /** When Facebook stops handing data out on it unless its owner signs in to the app again. */
  dataAccessExpiresAt: number | null;
  permissions: string[];
}

interface ErrorBody {
  message?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  is_transient?: unknown;
  fbtrace_id?: unknown;
}

export class GraphError extends Error {
  constructor(
    message: string,
    /** The HTTP status; 0 when Facebook was not reached at all. */
    readonly status: number,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
    /** Facebook says the same request may work a moment later. */
    readonly transient = false,
    /** What to quote to Facebook's support. */
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** Facebook answered. False means the request may or may not have arrived. */
  get reached(): boolean {
    return this.status !== 0;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class Graph {
  readonly appId: string;
  readonly version: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GraphOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.version = options.version;
    this.baseUrl = (options.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The token with which the app speaks for itself, not for a Page or a person. */
  get appToken(): string {
    return `${this.appId}|${this.appSecret}`;
  }

  get<T>(path: string, token: string, query: GraphQuery = {}): Promise<T> {
    return this.request<T>('GET', path, token, query);
  }

  /** Posts a JSON document, as the interface for sending messages takes it. */
  post<T>(path: string, token: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      'POST',
      path,
      token,
      {},
      {
        type: 'application/json',
        text: JSON.stringify(body),
      },
    );
  }

  /** Posts plain form fields, as the interfaces for settings take them. */
  postForm<T>(path: string, token: string, fields: GraphQuery): Promise<T> {
    const form = new URLSearchParams();
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) form.set(name, String(value));
    }
    return this.request<T>(
      'POST',
      path,
      token,
      {},
      {
        type: 'application/x-www-form-urlencoded',
        text: form.toString(),
      },
    );
  }

  /** What Facebook knows of an access token: whose it is, what it may do, when it ends. */
  async lookUpToken(token: string): Promise<TokenInfo> {
    const answer = await this.get<{ data?: Record<string, unknown> }>(
      'debug_token',
      this.appToken,
      { input_token: token },
    );
    const data = answer.data ?? {};
    const failure = data.error as { message?: unknown } | undefined;
    const expires = typeof data.expires_at === 'number' ? data.expires_at : 0;
    const dataAccess =
      typeof data.data_access_expires_at === 'number' ? data.data_access_expires_at : 0;
    return {
      valid: data.is_valid === true,
      problem: typeof failure?.message === 'string' ? failure.message : null,
      kind: data.type === 'PAGE' ? 'page' : data.type === 'USER' ? 'person' : 'other',
      appId: data.app_id === undefined ? null : String(data.app_id),
      // For the token of a Page, the Page; for the token of a person, the person.
      ownerId:
        data.profile_id !== undefined
          ? String(data.profile_id)
          : data.user_id !== undefined
            ? String(data.user_id)
            : null,
      expiresAt: expires > 0 ? expires * 1000 : null,
      dataAccessExpiresAt: dataAccess > 0 ? dataAccess * 1000 : null,
      permissions: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
    };
  }

  /** Turns the short-lived token of a person into one that lasts about two months. */
  async extendToken(token: string): Promise<string> {
    const answer = await this.get<{ access_token?: unknown }>('oauth/access_token', this.appToken, {
      grant_type: 'fb_exchange_token',
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: token,
    });
    if (typeof answer.access_token !== 'string' || answer.access_token === '') {
      throw new GraphError('Facebook returned no token', 200);
    }
    return answer.access_token;
  }

  /** The signature Facebook puts on what it sends to the webhook, for the same bytes. */
  signatureOf(payload: Buffer | string): string {
    return `sha256=${createHmac('sha256', this.appSecret).update(payload).digest('hex')}`;
  }

  /** The word Facebook is given to repeat when it checks the webhook address, unless one is set. */
  derivedVerifyToken(): string {
    return createHmac('sha256', this.appSecret).update('webhook-verify-token').digest('hex');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    query: GraphQuery,
    body?: { type: string; text: string },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${this.version}/${path.replace(/^\/+/, '')}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    // Proves to Facebook that a call made with a Page's or a person's token
    // comes from the holder of the app secret, and not from someone who got
    // hold of the token alone.
    if (token !== this.appToken) {
      url.searchParams.set(
        'appsecret_proof',
        createHmac('sha256', this.appSecret).update(token).digest('hex'),
      );
    }

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': body.type } : {}),
        },
        body: body?.text,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new GraphError(notReached(error, this.timeoutMs), 0);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const failure = (parsed as { error?: ErrorBody } | undefined)?.error;
    if (failure && typeof failure === 'object') {
      throw new GraphError(
        typeof failure.message === 'string' ? failure.message : 'Facebook reported an error',
        response.status,
        typeof failure.code === 'number' ? failure.code : null,
        typeof failure.error_subcode === 'number' ? failure.error_subcode : null,
        failure.is_transient === true,
        typeof failure.fbtrace_id === 'string' ? failure.fbtrace_id : null,
      );
    }
    if (!response.ok || parsed === undefined) {
      throw new GraphError(
        `Facebook answered with HTTP status ${response.status} and no explanation`,
        response.status,
        null,
        null,
        response.status >= 500,
      );
    }
    return parsed as T;
  }
}

function notReached(error: unknown, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `no answer within ${Math.round(timeoutMs / 1000)} seconds`;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error instanceof Error ? error.message : 'the connection failed';
}

// ------------------------------------------------------------ what went wrong

const is = (error: GraphError, code: number, ...subcodes: number[]) =>
  error.code === code && (subcodes.length === 0 || subcodes.includes(error.subcode ?? -1));

/** Facebook only lets the Page write within a time of the customer's last message, and it is over. */
export function isOutsideWindow(error: unknown): boolean {
  return error instanceof GraphError && is(error, 10, 2018278, 2534022, 2018065);
}

/** The access token is no longer accepted; nothing works until a new one is set. */
export function isTokenRejected(error: unknown): boolean {
  return error instanceof GraphError && error.code === 190;
}

/** Facebook answered that it had a problem of its own: the request did not go through, and may next time. */
export function isWorthRepeating(error: unknown): boolean {
  if (!(error instanceof GraphError) || !error.reached) return false;
  return error.transient || error.code === 1 || error.code === 2 || error.status >= 500;
}

const ONLY_ROLES = /not admins, developers or testers/i;

/**
 * Says in plain words what went wrong and what to do about it. `speakingAs`
 * tells whose credentials the failed call used.
 */
export function explainGraphError(error: unknown, speakingAs: 'page' | 'app' = 'page'): string {
  if (!(error instanceof GraphError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!error.reached) return `Facebook could not be reached (${error.message}).`;

  if (error.code === 190) {
    return speakingAs === 'app'
      ? 'Facebook does not accept the app id and app secret. Compare FB_APP_ID and FB_APP_SECRET ' +
          'in .env with "App settings > Basic" in the app\u2019s dashboard.'
      : 'Facebook no longer accepts the Page\u2019s access token: it has expired, or the access was ' +
          'withdrawn (a changed Facebook password ends it too). Create a new token in the app\u2019s ' +
          'dashboard under "Messenger API Settings", put it into .env as FB_PAGE_ACCESS_TOKEN and ' +
          'start the assistant again.';
  }
  if (isOutsideWindow(error)) {
    return (
      'Facebook lets the Page write to a customer only within 24 hours of their last message, ' +
      'and that time is over for this chat. Answer from the Page\u2019s inbox in Meta Business ' +
      'Suite, where a person has 7 days, or reach the customer by phone.'
    );
  }
  if (
    is(error, 10, 2018108) ||
    error.code === 551 ||
    error.subcode === 1545041 ||
    error.code === 1545041
  ) {
    return (
      'This person cannot receive messages from the Page right now: they may have blocked the ' +
      'Page or closed their account.'
    );
  }
  if (is(error, 10, 1893063) || error.code === 368) {
    return (
      'Facebook has restricted the Page from sending messages for a while, for activity it holds ' +
      'against its messaging rules. The Page\u2019s Support Inbox says why.'
    );
  }
  if (is(error, 10, 2018300) || is(error, 100, 2534037)) {
    return (
      'Another app has this chat at the moment (Meta Business AI, for example), and Facebook ' +
      'refused the message. See "Other apps on the Page" in the README.'
    );
  }
  if (error.code === 2018321 || error.subcode === 2018321) {
    return (
      'Messenger is taking this customer through the Page\u2019s own automatic questions and ' +
      'answers; nothing can be sent until that is over.'
    );
  }
  if (is(error, 200, 2018028) || (error.code === 200 && ONLY_ROLES.test(error.message))) {
    return (
      'Facebook lets this app write only to people who have a role on it (administrators, ' +
      'developers, testers): the app is still in development, or its pages_messaging permission ' +
      'is not approved for everyone yet. See "Opening the assistant to all customers" in the README.'
    );
  }
  if (is(error, 100, 2018001)) {
    return (
      'Facebook knows nobody with this id on this Page. A person has an id only after writing ' +
      'to the Page, and it differs from Page to Page.'
    );
  }
  if ([4, 17, 32, 613, 80006].includes(error.code ?? -1)) {
    return (
      'Facebook is holding messages back because too many were sent in a short time. ' +
      'Try again in a few minutes.'
    );
  }
  if (error.code === 10 || error.code === 200 || error.code === 3 || error.code === 299) {
    return (
      `Facebook refused for lack of permission: \u201c${error.message}\u201d. The access token needs ` +
      'the permissions pages_messaging and pages_manage_metadata, given by someone who manages ' +
      'the Page.'
    );
  }
  if (isWorthRepeating(error)) {
    return 'Facebook had a problem of its own. Try again in a moment.';
  }
  const numbers = [error.code, error.subcode].filter((n) => n !== null).join('/');
  return `Facebook refused: \u201c${error.message}\u201d${numbers ? ` (error ${numbers})` : ''}.`;
}
