import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { Graph, explainGraphError } from '../transport/graph';
import { saveEnvValue } from './facebook-report';
import { type PageAccount, PERMISSIONS, checkPage, lastingPagesOf } from './page-token';

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

  The address Facebook sends the browser back to is on this computer too
  (http://localhost:3402/facebook/connected), and Facebook only sends a
  browser to an address the app's settings name: it has to be listed under
  "Facebook Login for Business > Settings > Valid OAuth Redirect URIs". With
  that list empty, as an app has it at first, Facebook answers "The domain of
  this URL isn't included in the app's domains" in place of its sign-in page.

  NOT CARRIED THROUGH AGAINST FACEBOOK. With the one real app this was tried
  on, a published one with an empty list, Facebook refused as above, and the
  list was left as it was. The steps after Facebook's page are tested against
  a stand-in only. Whether Facebook takes an address without HTTPS for a
  published app, where its "Enforce HTTPS" is on, is not known either. The
  way that has been run for real is the token from the app's dashboard.
*/

export const CALLBACK_PATH = '/facebook/connected';
/** Where the person lands who picked one of several Pages. */
export const CHOICE_PATH = '/facebook/page';

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

function page(
  title: string,
  lines: string[],
  buttons: Array<{ href: string; label: string }> = [],
): string {
  const links = buttons.map(
    (button) =>
      `<p><a class="button" href="${escape(button.href)}">${escape(button.label)}</a></p>`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1c1e21}
h1{font-size:1.4rem}a.button{display:inline-block;background:#0866ff;color:#fff;font-weight:600;
text-decoration:none;padding:.65rem 1.1rem;border-radius:8px}</style></head>
<body><h1>${escape(title)}</h1>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}${links.join('')}</body></html>`;
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

  /** What the browser is shown next, and whether the command is done: true, false, or not yet. */
  interface Step {
    done: boolean | null;
    title: string;
    lines: string[];
    buttons?: Array<{ href: string; label: string }>;
  }
  const failed = (why: string): Step => {
    say(`NOT CONNECTED. ${why}`);
    return { done: false, title: 'Not connected', lines: [why, 'You can close this tab.'] };
  };

  /** Several Pages were shared and none is named: the person picks one in the browser. */
  let toChooseFrom: PageAccount[] = [];
  let chooser: Step | null = null;

  /** Saves the token of the Page, where the assistant can run on it. */
  const connect = async (chosen: PageAccount, pages: PageAccount[]): Promise<Step> => {
    const result = await checkPage(graph, chosen, pages);
    if (!result.ok) return failed(result.problem);
    saveEnvValue(options.envFile, 'FB_PAGE_ACCESS_TOKEN', result.page.token);
    const lasts =
      result.info.expiresAt === null
        ? 'It does not expire.'
        : `It ends on ${new Date(result.info.expiresAt).toISOString().slice(0, 10)}.`;
    say(`Connected "${result.page.name}" (id ${result.page.id}).`);
    say(`A token of the Page is saved in ${options.envFile}. ${lasts}`);
    say(`It may: ${result.info.permissions.join(', ')}.`);
    say('Start the assistant (again) for it to be used: pnpm start');
    return {
      done: true,
      title: `Connected: ${result.page.name}`,
      lines: ['The booking assistant can now answer for this Page.', 'You can close this tab.'],
    };
  };

  /** Works the code Facebook handed back into the Pages the person shared, and on to a saved token. */
  const complete = async (code: string): Promise<Step> => {
    try {
      const person = await graph.exchangeCode(code, redirectUri);
      const pages = await lastingPagesOf(graph, person);
      if (pages.length === 0) {
        return failed(
          'This person manages no Page that the app was given access to. Sign in again and ' +
            'choose the Page when Facebook asks which ones to share.',
        );
      }
      say('Pages this person manages and shared with the app:');
      for (const candidate of pages) say(`  - ${candidate.name}, id ${candidate.id}`);

      if (options.pageId !== '') {
        const named = pages.find((candidate) => candidate.id === options.pageId);
        return named
          ? await connect(named, pages)
          : failed(`None of the Pages has the id in FB_PAGE_ID (${options.pageId}).`);
      }
      if (pages.length === 1) return await connect(pages[0]!, pages);

      toChooseFrom = pages;
      say('Choose in the browser which of them the assistant answers for.');
      chooser = {
        done: null,
        title: 'Which Page should the assistant answer for?',
        lines: ['You shared several Pages. Choose the one whose chats the assistant answers.'],
        buttons: pages.map((candidate) => ({
          href: `${start}${CHOICE_PATH}?page=${encodeURIComponent(candidate.id)}&state=${state}`,
          label: candidate.name || `Page ${candidate.id}`,
        })),
      };
      return chooser;
    } catch (error) {
      return failed(explainGraphError(error, 'app'));
    }
  };

  const choose = async (pageId: string): Promise<Step | null> => {
    const chosen = toChooseFrom.find((candidate) => candidate.id === pageId);
    if (!chosen) return null;
    try {
      return await connect(chosen, toChooseFrom);
    } catch (error) {
      return failed(explainGraphError(error, 'app'));
    }
  };

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const send = (
      status: number,
      title: string,
      lines: string[],
      buttons: Array<{ href: string; label: string }> = [],
    ) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      response.end(page(title, lines, buttons));
    };
    const show = (step: Step) => {
      send(200, step.title, step.lines, step.buttons);
      if (step.done !== null) finish(step.done);
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
        [{ href: signIn.toString(), label: 'Continue with Facebook' }],
      );
    }
    if (url.pathname !== CALLBACK_PATH && url.pathname !== CHOICE_PATH) {
      return send(404, 'Not found', []);
    }
    // Only the browser that went to Facebook from the button comes back with this word.
    if (!sameText(url.searchParams.get('state') ?? '', state)) {
      return send(400, 'Not connected', [
        'This page was not reached from the button of "pnpm fb:connect". Start the command again.',
      ]);
    }

    if (url.pathname === CHOICE_PATH) {
      const step = await choose(url.searchParams.get('page') ?? '');
      if (step) return show(step);
      return send(400, 'Not connected', ['That Page was not among the ones shared.']);
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
    // Facebook's code is good for one use: a page loaded twice is shown the choice again, not an error.
    if (chooser) return show(chooser);
    show(await complete(code));
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
  say('The app must allow the address Facebook sends the browser back to; the README says where');
  say(`("Connecting the Page"). It is: ${redirectUri}`);
  say();
  say(`Waiting for you to finish (${Math.round(options.timeoutMs / 60_000)} minutes at most)...`);
  options.open(start);

  const timer = setTimeout(() => {
    say('NOT CONNECTED. Nothing came back from the browser in time.');
    say(
      'If Facebook showed "The domain of this URL isn\u2019t included in the app\u2019s domains" in',
    );
    say('place of its sign-in page, the app does not allow the address the browser is sent back');
    say(`to. It is: ${redirectUri}`);
    say('and belongs under "Facebook Login for Business > Settings > Valid OAuth Redirect URIs"');
    say(
      'in the app\u2019s dashboard. The README has the other way to connect the Page, which needs',
    );
    say('none of this.');
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
