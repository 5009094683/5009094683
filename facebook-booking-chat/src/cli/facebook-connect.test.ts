import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFacebook } from '../../test/fake-facebook';
import { type ConnectOptions, connectFacebook } from './facebook-connect';

/*
  The browser, Facebook's sign-in page and the person pressing "Continue" on
  it are played by the test: it loads the page with the button, follows the
  button's address as far as Facebook, and calls the address Facebook would
  send the browser back to.
*/

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Visit {
  status: number;
  body: string;
}

/** What the person does at Facebook: by default, signs in and presses Continue. */
type Person = (signIn: URL, facebook: FakeFacebook, visit: (query: string) => Promise<Visit>) => Promise<void>; // prettier-ignore

const pressesContinue: Person = async (signIn, facebook, visit) => {
  await visit(`code=${facebook.signInCode}&state=${signIn.searchParams.get('state')}`);
};

const unescape = (html: string) =>
  html.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));

async function connect(
  person: Person = pressesContinue,
  options: Partial<ConnectOptions> = {},
  prepare?: (facebook: FakeFacebook) => void,
) {
  const facebook = new FakeFacebook();
  prepare?.(facebook);
  const port = options.port ?? (await freePort());
  const envFile = join(mkdtempSync(join(tmpdir(), 'fbchat-connect-')), '.env');
  writeFileSync(envFile, '# settings\nFB_APP_ID=555500001111\nFB_PAGE_ACCESS_TOKEN=old-token\nDASHBOARD_PASSWORD=keep me\n'); // prettier-ignore
  const lines: string[] = [];
  const visits: Visit[] = [];
  const seen: { opened: string[]; startPage: string; signIn: URL | null } = {
    opened: [],
    startPage: '',
    signIn: null,
  };
  let inTheBrowser: Promise<void> = Promise.resolve();

  const ok = await connectFacebook({
    appId: facebook.appId,
    appSecret: facebook.appSecret,
    graphVersion: facebook.version,
    pageId: '',
    envFile,
    port,
    timeoutMs: 3000,
    say: (line = '') => lines.push(line),
    fetch: facebook.fetch,
    open: (address) => {
      seen.opened.push(address);
      inTheBrowser = (async () => {
        // The page with the button, and where the button leads.
        seen.startPage = await (await fetch(address)).text();
        const href = /<a class="button" href="([^"]+)"/.exec(seen.startPage)![1]!;
        const signIn = new URL(unescape(href));
        seen.signIn = signIn;
        // Facebook sends the browser back to the address the sign-in named.
        const back = signIn.searchParams.get('redirect_uri')!;
        facebook.signInRedirect = back;
        const visit = async (query: string) => {
          const response = await fetch(`${back}?${query}`);
          const visited = { status: response.status, body: await response.text() };
          visits.push(visited);
          return visited;
        };
        await person(signIn, facebook, visit);
      })();
    },
    ...options,
  });
  await inTheBrowser;
  return { ok, text: lines.join('\n'), facebook, envFile, visits, port, ...seen };
}

describe('pnpm fb:connect', () => {
  it('signs in with Facebook and saves a lasting token of the Page', async () => {
    const { ok, text, facebook, envFile, visits, signIn, port, opened, startPage } =
      await connect();
    expect(ok).toBe(true);

    // A page on this computer, at a short address, with one button.
    expect(opened).toEqual([`http://localhost:${port}`]);
    expect(text).toContain(`  http://localhost:${port}`);
    expect(startPage).toContain('<h1>Connect the Facebook Page</h1>');
    expect(startPage).toContain('>Continue with Facebook</a>');

    // The button leads to Facebook's own sign-in page, asking for what the assistant needs and no more.
    expect(`${signIn!.origin}${signIn!.pathname}`).toBe(
      'https://www.facebook.com/v27.0/dialog/oauth',
    );
    expect(Object.fromEntries(signIn!.searchParams)).toMatchObject({
      client_id: facebook.appId,
      redirect_uri: `http://localhost:${port}/facebook/connected`,
      response_type: 'code',
      scope: 'pages_messaging,pages_manage_metadata,pages_show_list,business_management',
    });
    expect(signIn!.searchParams.get('state')).toMatch(/^[0-9a-f]{48}$/);
    expect(signIn!.toString()).not.toContain(facebook.appSecret);

    expect(readFileSync(envFile, 'utf8')).toBe(
      `# settings\nFB_APP_ID=555500001111\nFB_PAGE_ACCESS_TOKEN=${facebook.pageToken}\nDASHBOARD_PASSWORD=keep me\n`,
    );
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    // The Page's token was made from the person's extended token: that is what makes it last.
    expect(facebook.calls('GET', /^me\/accounts$/)[0]!.token).toBe('long-EAA-person-token');

    expect(text).toContain('Connected "Cao Bằng Travel Guide" (id 700000000000001).');
    expect(text).toContain(`A token of the Page is saved in ${envFile}. It does not expire.`);
    expect(text).toContain('It may: pages_show_list, pages_messaging, pages_manage_metadata');
    expect(visits).toEqual([
      expect.objectContaining({
        status: 200,
        body: expect.stringContaining('<h1>Connected: Cao Bằng Travel Guide</h1>'),
      }),
    ]);
    // No token is shown: not in the terminal, and not in the browser.
    const shown = `${text}\n${startPage}\n${visits.map((visit) => visit.body).join('\n')}`;
    for (const secret of [facebook.pageToken, facebook.personToken, facebook.appSecret]) {
      expect(shown).not.toContain(secret);
    }
  });

  it('takes no visit that did not come from its own button', async () => {
    const { ok, visits, envFile, facebook } = await connect(async (signIn, facebook, visit) => {
      // Someone else's link to this computer, with a code of their own.
      const forged = await visit(`code=${facebook.signInCode}&state=guessed`);
      expect(forged.status).toBe(400);
      expect((await visit('code=x')).status).toBe(400);
      // The command keeps waiting, and the real visit still works.
      await pressesContinue(signIn, facebook, visit);
    });
    expect(ok).toBe(true);
    expect(visits.map((visit) => visit.status)).toEqual([400, 400, 200]);
    expect(readFileSync(envFile, 'utf8')).toContain(`FB_PAGE_ACCESS_TOKEN=${facebook.pageToken}`);
    expect(facebook.calls('GET', /^oauth\/access_token$/).filter((r) => r.query.code)).toHaveLength(1); // prettier-ignore
  });

  it('shows its pages only under this computer\u2019s own names', async () => {
    // A page elsewhere can point a name of its own at this computer, to read the button's address.
    const asked: Array<[string, number]> = [];
    const askAs = (port: number, host: string, path: string) =>
      new Promise<void>((resolve, reject) => {
        get({ host: '127.0.0.1', port, path, headers: { host } }, (response) => {
          response.resume();
          asked.push([host, response.statusCode ?? 0]);
          resolve();
        }).on('error', reject);
      });
    const { ok } = await connect(async (signIn, facebook, visit) => {
      const port = Number(new URL(signIn.searchParams.get('redirect_uri')!).port);
      await askAs(port, `evil.example:${port}`, '/');
      await askAs(port, 'evil.example', `/facebook/connected?code=x&state=${signIn.searchParams.get('state')}`); // prettier-ignore
      await askAs(port, `127.0.0.1:${port}`, '/');
      await pressesContinue(signIn, facebook, visit);
    });
    expect(ok).toBe(true);
    expect(asked.map(([, status]) => status)).toEqual([404, 404, 200]);
  });

  it('says so when the sign-in is cancelled, and leaves .env alone', async () => {
    const { ok, text, envFile, visits } = await connect(async (signIn, _facebook, visit) => {
      await visit(
        `error=access_denied&error_reason=user_denied&error_description=Permissions+error.&state=${signIn.searchParams.get('state')}`,
      );
    });
    expect(ok).toBe(false);
    expect(text).toContain('NOT CONNECTED. The sign-in was cancelled in the browser.');
    expect(visits[0]!.body).toContain('You cancelled the sign-in.');
    expect(readFileSync(envFile, 'utf8')).toContain('FB_PAGE_ACCESS_TOKEN=old-token');
  });

  it.each<[string, Partial<ConnectOptions>, (facebook: FakeFacebook) => void, RegExp]>([
    [
      'no Page was shared with the app',
      {},
      (facebook) => (facebook.sharedNoPage = true),
      /manages no Page that the app was given access to/,
    ],
    [
      'the Page named is not among them',
      { pageId: '123' },
      () => undefined,
      /None of the Pages has the id in FB_PAGE_ID \(123\)/,
    ],
    [
      'the person may not answer the Page\u2019s messages',
      {},
      (facebook) => (facebook.tasks = ['ANALYZE', 'ADVERTISE']),
      /On "Cao Bằng Travel Guide" this person may not answer messages/,
    ],
    [
      'a permission was switched off at Facebook',
      {},
      (facebook) => (facebook.token.scopes = FakeFacebook.DASHBOARD_TOKEN_SCOPES),
      /Facebook did not grant pages_manage_metadata\. Sign in again and leave every permission switched on/,
    ],
    [
      'Facebook does not take the code',
      {},
      (facebook) => (facebook.signInCode = 'another-code'),
      /NOT CONNECTED\. Facebook refused: \u201cThis authorization code has been used\.\u201d/,
    ],
    [
      'the app secret is wrong',
      { appSecret: 'not-the-secret' },
      () => undefined,
      /NOT CONNECTED\. Facebook refused: \u201cError validating client secret\.\u201d/,
    ],
  ])('says what is missing when %s', async (_what, options, prepare, expected) => {
    const { ok, text, envFile, visits } = await connect(
      async (signIn, _facebook, visit) => {
        await visit(`code=code-from-facebook&state=${signIn.searchParams.get('state')}`);
      },
      options,
      prepare,
    );
    expect(ok).toBe(false);
    expect(text).toMatch(expected);
    expect(visits[0]!.body).toContain('Not connected');
    expect(readFileSync(envFile, 'utf8')).toContain('FB_PAGE_ACCESS_TOKEN=old-token');
  });

  it('lets the person pick the Page, where several were shared', async () => {
    const seen: Array<{ status: number; body: string }> = [];
    const load = async (address: string) => {
      const response = await fetch(address);
      const page = { status: response.status, body: await response.text() };
      seen.push(page);
      return page;
    };
    const { ok, text, envFile, facebook, visits } = await connect(
      async (signIn, facebook, visit) => {
        const query = `code=${facebook.signInCode}&state=${signIn.searchParams.get('state')}`;
        const choice = await visit(query);
        expect(choice.body).toContain('<h1>Which Page should the assistant answer for?</h1>');
        // One button for each Page, by name.
        const buttons = [...choice.body.matchAll(/<a class="button" href="([^"]+)">([^<]+)<\/a>/g)];
        expect(buttons.map((button) => button[2])).toEqual([
          'Cao Bằng Travel Guide',
          'Another Page',
        ]);

        // Loaded again, the page shows the same choice; Facebook's code is not handed in twice.
        expect((await visit(query)).body).toContain('Which Page should the assistant answer for?');
        // A Page that was not shared, or a visit without the word of the sign-in, is not taken.
        const back = signIn.searchParams.get('redirect_uri')!.replace('/connected', '/page');
        expect((await load(`${back}?page=999&state=${signIn.searchParams.get('state')}`)).status).toBe(400); // prettier-ignore
        expect((await load(`${back}?page=800000000000002&state=guessed`)).status).toBe(400);

        await load(unescape(buttons[1]![1]!));
      },
      {},
      (f) => (f.otherPages = [{ id: '800000000000002', name: 'Another Page' }]),
    );
    expect(ok).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      status: 200,
      body: expect.stringContaining('<h1>Connected: Another Page</h1>'),
    });
    expect(text).toContain('Choose in the browser which of them the assistant answers for.');
    expect(text).toContain('Connected "Another Page" (id 800000000000002).');
    // The token of the Page that was picked, and of no other.
    expect(readFileSync(envFile, 'utf8')).toContain(
      'FB_PAGE_ACCESS_TOKEN=EAA-token-of-800000000000002\n',
    );
    expect(facebook.calls('GET', /^oauth\/access_token$/).filter((r) => r.query.code)).toHaveLength(1); // prettier-ignore
    for (const page of [...visits, ...seen]) expect(page.body).not.toContain('EAA-token-of');
  });

  it('connects the Page that is named, where several were shared', async () => {
    const { ok, envFile, facebook } = await connect(
      pressesContinue,
      { pageId: '700000000000001' },
      (f) => (f.otherPages = [{ id: '800000000000002', name: 'Another Page' }]),
    );
    expect(ok).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain(`FB_PAGE_ACCESS_TOKEN=${facebook.pageToken}`);
  });

  it('gives up when nobody comes', async () => {
    const { ok, text } = await connect(pressesContinue, { timeoutMs: 60, open: () => undefined });
    expect(ok).toBe(false);
    expect(text).toContain('NOT CONNECTED. Nothing came back from the browser in time.');
  });

  it('says when its port on this computer is taken', async () => {
    const port = await freePort();
    const squatter = createServer().listen(port, '127.0.0.1');
    await new Promise((resolve) => squatter.once('listening', resolve));
    const { ok, text } = await connect(pressesContinue, { port });
    squatter.close();
    expect(ok).toBe(false);
    expect(text).toContain(`NOT CONNECTED. Port ${port} on this computer is in use.`);
  });
});
