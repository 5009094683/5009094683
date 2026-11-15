import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Graph, explainGraphError } from '../transport/graph';
import { saveEnvValue } from './facebook-report';
import { PERMISSIONS, pageTokenOf } from './page-token';

/*
  Connects the Page by signing in with Facebook: behind "pnpm fb:connect".

  It serves a small page on this computer with one button, which leads to
  Facebook's own sign-in page, asking for exactly the permissions the
  assistant needs. The person who manages the Page presses "Continue" there,
  Facebook sends the browser back to this computer with a code, and the code
  is turned into a token of the Page that does not expire and saved in .env.
  No token has to be copied by hand, and none is shown.

  The page is at a short address (http://localhost:3402), so that it can be
  opened in whichever browser is signed in to Facebook.

  The address Facebook sends the browser back to is on this computer too.
  Facebook allows that for an app in development; for a published app the
  address has to be added under "Valid OAuth Redirect URIs" in the app's
  Facebook Login settings.
*/

export const CALLBACK_PATH = '/facebook/connected';

export interface ConnectOptions {
  appId: string;
  appSecret: string;
  graphVersion: string;
  /** The Page to connect, where the person manages several. '' = the only one. */
  pageId: string;
  /** The .env file the token is saved in. */
  envFile: string;
  /** The port on this computer for the page with the button, and for the way back from Facebook. */
  port: number;
  timeoutMs: number;
  say: (line?: string) => void;
  /** Shows the page with the button: called with its address once it is being served. */
  open: (url: string) => void;
  /** Replaced in tests. */
  fetch?: typeof globalThis.fetch;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, lines: string[], button?: { href: string; label: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1c1e21}
h1{font-size:1.4rem}a.button{display:inline-block;background:#0866ff;color:#fff;font-weight:600;
text-decoration:none;padding:.65rem 1.1rem;border-radius:8px}</style></head>
<body><h1>${escape(title)}</h1>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}${
    button
      ? `<p><a class="button" href="${escape(button.href)}">${escape(button.label)}</a></p>`
      : ''
  }</body></html>`;
}

function sameText(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns true when a token of the Page was saved. */
export async function connectFacebook(options: ConnectOptions): Promise<boolean> {
  const { say } = options;
  const graph = new Graph({
    appId: options.appId,
    appSecret: options.appSecret,
    version: options.graphVersion,
    fetch: options.fetch,
  });
  const state = randomBytes(24).toString('hex');
  const start = `http://localhost:${options.port}`;
  const redirectUri = `${start}${CALLBACK_PATH}`;
  const signIn = new URL(`https://www.facebook.com/${options.graphVersion}/dialog/oauth`);
  signIn.search = new URLSearchParams({
    client_id: options.appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: PERMISSIONS.join(','),
  }).toString();
  // The names this computer goes by. A page elsewhere that points a name of
  // its own at this computer is not let in.
  const ownNames = ['localhost', '127.0.0.1', '[::1]'].map((name) => `${name}:${options.port}`);

  let finish!: (ok: boolean) => void;
  const finished = new Promise<boolean>((resolve) => (finish = resolve));

  /** Works the code into a saved token, and says how it went: [worked, title, lines]. */
  const complete = async (code: string): Promise<[boolean, string, string[]]> => {
    try {
      const person = await graph.exchangeCode(code, redirectUri);
      const result = await pageTokenOf(graph, person, options.pageId);
      if (result.pages.length > 0) {
        say('Pages this person manages and shared with the app:');
        for (const candidate of result.pages) say(`  - ${candidate.name}, id ${candidate.id}`);
      }
      if (!result.ok) {
        say(`NOT CONNECTED. ${result.problem}`);
        return [false, 'Not connected', [result.problem, 'You can close this tab.']];
      }
      saveEnvValue(options.envFile, 'FB_PAGE_ACCESS_TOKEN', result.page.token);
      const lasts =
        result.info.expiresAt === null
          ? 'It does not expire.'
          : `It ends on ${new Date(result.info.expiresAt).toISOString().slice(0, 10)}.`;
      say(`Connected "${result.page.name}" (id ${result.page.id}).`);
      say(`A token of the Page is saved in ${options.envFile}. ${lasts}`);
      say(`It may: ${result.info.permissions.join(', ')}.`);
      say('Start the assistant (again) for it to be used: pnpm start');
      return [
        true,
        `Connected: ${result.page.name}`,
        ['The booking assistant can now answer for this Page.', 'You can close this tab.'],
      ];
    } catch (error) {
      const why = explainGraphError(error, 'app');
      say(`NOT CONNECTED. ${why}`);
      return [false, 'Not connected', [why, 'You can close this tab.']];
    }
  };

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (
      status: number,
      title: string,
      lines: string[],
      button?: { href: string; label: string },
    ) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      response.end(page(title, lines, button));
    };
    const url = new URL(request.url ?? '/', start);
    if (request.method !== 'GET' || !ownNames.includes(request.headers.host ?? '')) {
      return send(404, 'Not found', []);
    }
    if (url.pathname === '/') {
      return send(
        200,
        'Connect the Facebook Page',
        [
          'The booking assistant needs your leave to read and answer the chats of your Facebook Page.',
          'Press the button and, on Facebook, press \u201cContinue\u201d on each step. Sign in as ' +
            'someone who manages the Page, leave every permission switched on, and choose the ' +
            'Page when Facebook asks which ones to share.',
          'What Facebook hands back stays on this computer.',
        ],
        { href: signIn.toString(), label: 'Continue with Facebook' },
      );
    }
    if (url.pathname !== CALLBACK_PATH) return send(404, 'Not found', []);

    // Only the browser that went to Facebook from the button comes back with this word.
    if (!sameText(url.searchParams.get('state') ?? '', state)) {
      return send(400, 'Not connected', [
        'This page was not reached from the button of "pnpm fb:connect". Start the command again.',
      ]);
    }
    const code = url.searchParams.get('code');
    if (code === null) {
      const reason = url.searchParams.get('error_description') ?? 'Facebook returned no code.';
      const cancelled = url.searchParams.get('error') === 'access_denied';
      say(
        cancelled
          ? 'NOT CONNECTED. The sign-in was cancelled in the browser.'
          : `NOT CONNECTED. Facebook answered: ${reason}`,
      );
      send(200, 'Not connected', [
        cancelled ? 'You cancelled the sign-in.' : reason,
        'Start "pnpm fb:connect" again to try once more. You can close this tab.',
      ]);
      return finish(false);
    }
    const [ok, title, lines] = await complete(code);
    send(200, title, lines);
    finish(ok);
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    answer(request, response).catch(() => {
      response.writeHead(500).end();
      finish(false);
    });
  };
  const listeners: Server[] = [];
  const listenOn = (host: string) =>
    new Promise<void>((resolve, reject) => {
      const listener = createServer(handle);
      listener.once('error', reject);
      listener.listen(options.port, host, () => {
        listeners.push(listener);
        resolve();
      });
    });
  try {
    await listenOn('127.0.0.1');
  } catch (error) {
    say(
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `NOT CONNECTED. Port ${options.port} on this computer is in use. Is "pnpm fb:connect" already running?`
        : `NOT CONNECTED. Port ${options.port} could not be opened: ${(error as Error).message}`,
    );
    return false;
  }
  // "localhost" may mean ::1 to the browser. Where the computer has no such address, one is enough.
  await listenOn('::1').catch(() => undefined);

  say('Open this address in a browser in which you are signed in to Facebook as someone who');
  say('manages the Page, and press "Continue with Facebook" there:');
  say();
  say(`  ${start}`);
  say();
  say('On Facebook, press "Continue" on each step. Leave every permission switched on, and');
  say('choose the Page when Facebook asks which ones to share.');
  say();
  say(`Waiting for you to finish (${Math.round(options.timeoutMs / 60_000)} minutes at most)...`);
  options.open(start);

  const timer = setTimeout(() => {
    say('NOT CONNECTED. Nothing came back from the browser in time.');
    say('If Facebook showed an error instead of its sign-in page, note what it said: it names');
    say('what is missing in the app\u2019s settings.');
    finish(false);
  }, options.timeoutMs);
  const ok = await finished;
  clearTimeout(timer);
  for (const listener of listeners) {
    listener.close();
    listener.closeAllConnections();
  }
  return ok;
}
