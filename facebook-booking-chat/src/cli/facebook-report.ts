import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Graph, GraphError, type TokenInfo, explainGraphError } from '../transport/graph';
import {
  ANSWER_PERMISSION,
  BY_HAND,
  MANAGE_PERMISSION,
  WEBHOOK_FIELDS,
  WEBHOOK_PATH,
} from '../transport/messenger';
import { pageTokenOf, pagesOf } from './page-token';

/*
  Looks at the Facebook values in .env and at what Facebook has on record for
  them, and says in plain words what is in order and what is not. Behind
  "pnpm fb:check". It never prints a token or the app secret.
*/

export interface ReportOptions {
  appId: string;
  appSecret: string;
  pageAccessToken: string;
  /** '' = whichever Page the token is for. */
  pageId: string;
  graphVersion: string;
  /** '' = not set. */
  publicUrl: string;
  /**
   * The .env file to write a lasting token of the Page into, when the one in
   * it is the token of a person. Null: change nothing.
   */
  saveTokenTo: string | null;
  say: (line?: string) => void;
  /** Replaced in tests. */
  fetch?: typeof globalThis.fetch;
}

const HOW_TO_CONNECT =
  'Run "pnpm fb:connect": it signs in with Facebook in the browser and saves a token of the ' +
  'Page with every permission the assistant needs.';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Puts `NAME=value` into an .env file, in place of the line that sets it now. For its owner only. */
export function saveEnvValue(file: string, name: string, value: string): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = `${name}=${value}`;
  const present = new RegExp(`^${name}=.*$`, 'm');
  const next = present.test(text)
    ? text.replace(present, () => line)
    : `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

/** Returns true when everything the assistant needs is in order. */
export async function reportOnFacebook(options: ReportOptions): Promise<boolean> {
  const { say } = options;
  const graph = new Graph({
    appId: options.appId,
    appSecret: options.appSecret,
    version: options.graphVersion,
    fetch: options.fetch,
  });
  let ok = true;
  const trouble = (line: string) => {
    ok = false;
    say(`  NOT IN ORDER. ${line}`);
  };

  say(`Facebook app:   id ${options.appId}`);
  say(`Interface:      Graph API ${options.graphVersion}`);

  // ------------------------------------------------- app id, secret, token
  say();
  say('1. App id, app secret and access token');
  let token = options.pageAccessToken;
  let info: TokenInfo;
  try {
    info = await graph.lookUpToken(token);
  } catch (error) {
    trouble(explainGraphError(error, 'app'));
    return false;
  }
  say('  Facebook accepts the app id and the app secret.');
  if (!info.valid) {
    trouble(
      'Facebook does not accept the access token: it has expired, was withdrawn, or was not ' +
        `copied whole. ${HOW_TO_CONNECT}`,
    );
    return false;
  }
  if (info.appId !== null && info.appId !== options.appId) {
    trouble(
      `The access token was made for another Facebook app (id ${info.appId}), not for the app ` +
        `${options.appId}. ${HOW_TO_CONNECT}`,
    );
    return false;
  }

  if (info.kind === 'person') {
    say('  The access token is the token of a person, not of a Page.');
    const replaced = await pageTokenFor(graph, token, options);
    if (replaced === null) return false;
    token = replaced.token;
    info = replaced.info;
  } else if (info.kind !== 'page') {
    trouble(`The access token is neither of a Page nor of a person. ${HOW_TO_CONNECT}`);
    return false;
  }

  const pageId = info.ownerId ?? '';
  // Facebook tells the Page's name only to a token with a permission the assistant can do without.
  let pageName = '';
  try {
    const me = await graph.get<{ name?: unknown }>('me', token, { fields: 'name' });
    pageName = typeof me.name === 'string' ? me.name : '';
  } catch (error) {
    if (!(error instanceof GraphError) || !error.reached || error.code === 190) {
      trouble(explainGraphError(error, 'page'));
      return false;
    }
  }
  say(
    `  Page:         ${pageName || '(Facebook does not tell this token the name)'}, id ${pageId}`,
  );
  if (options.pageId !== '' && options.pageId !== pageId) {
    trouble(`FB_PAGE_ID names another Page (${options.pageId}). Correct it, or leave it empty.`);
  }
  if (info.expiresAt === null) {
    say('  Token ends:   never');
  } else {
    say(`  Token ends:   ${day(info.expiresAt)}`);
    trouble(`The token ends on that day, and the assistant with it. ${HOW_TO_CONNECT}`);
  }
  say(`  Permissions:  ${info.permissions.join(', ') || '(none)'}`);
  if (!info.permissions.includes(ANSWER_PERMISSION)) {
    trouble(
      `The token lacks ${ANSWER_PERMISSION}, without which the Page\u2019s chats can be neither ` +
        `read nor answered. ${HOW_TO_CONNECT}`,
    );
    say();
    say('Not everything is in order; see above.');
    return false;
  }
  const canManage = info.permissions.includes(MANAGE_PERMISSION);
  if (!canManage) {
    say('  This token may answer chats, but may not switch the Page on for the app (a token made');
    say(
      '  by "Generate" in the app\u2019s dashboard is of this kind). That step is then yours, once:',
    );
    say(`  ${BY_HAND}.`);
    say('  Or run "pnpm fb:connect": the assistant then does it itself, and keeps it in order.');
  }

  // ------------------------------------------------------------- webhook
  say();
  say('2. Where Facebook delivers the Page\u2019s messages (the webhook)');
  const wanted = options.publicUrl === '' ? null : `${options.publicUrl}${WEBHOOK_PATH}`;
  try {
    const listed = await graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${options.appId}/subscriptions`,
      graph.appToken,
    );
    const current = (listed.data ?? []).find((entry) => entry.object === 'page');
    const address = typeof current?.callback_url === 'string' ? current.callback_url : '';
    const fields = Array.isArray(current?.fields)
      ? current.fields.map((field) =>
          typeof field === 'object' && field !== null
            ? String((field as { name?: unknown }).name)
            : String(field),
        )
      : [];
    if (address === '') {
      say('  On record:    nothing yet');
    } else {
      say(`  On record:    ${address}${current?.active === false ? '  (switched off)' : ''}`);
      say(`  It reports:   ${fields.join(', ') || '(nothing)'}`);
    }
    say(`  PUBLIC_URL:   ${options.publicUrl || '(not set)'}`);
    if (wanted === null && address === '') {
      say(
        '  The assistant registers its address when it starts: with "pnpm start --tunnel" to try',
      );
      say('  it out, or with PUBLIC_URL set to the HTTPS address of this program.');
    } else if (wanted !== null && address !== wanted) {
      say('  The assistant registers the address in PUBLIC_URL with Facebook when it starts.');
    } else if (wanted !== null) {
      const missing = WEBHOOK_FIELDS.filter((field) => !fields.includes(field));
      say(
        missing.length === 0
          ? '  The address on record is the one in PUBLIC_URL.'
          : `  The assistant adds what is missing when it starts: ${missing.join(', ')}.`,
      );
    }
  } catch (error) {
    trouble(explainGraphError(error, 'app'));
  }

  // --------------------------------------------------- Page subscription
  say();
  say('3. The Page and the app');
  if (!canManage) {
    say('  Whether the Page is switched on for the app cannot be seen with this token (see 1).');
    say('  It is, once a message to the Page gets an answer.');
  } else {
    try {
      const listed = await graph.get<{ data?: Array<Record<string, unknown>> }>(
        `${pageId}/subscribed_apps`,
        token,
      );
      const apps = listed.data ?? [];
      const mine = apps.find((app) => String(app.id) === options.appId);
      if (mine) {
        const fields = Array.isArray(mine.subscribed_fields) ? mine.subscribed_fields : [];
        say(`  The Page is switched on for the app (${fields.join(', ') || 'no fields'}).`);
      } else {
        say(
          '  The Page is not switched on for the app yet; the assistant does that when it starts.',
        );
      }
      const others = apps.filter((app) => String(app.id) !== options.appId);
      if (others.length > 0) {
        const names = others.map((app) => String(app.name ?? `app ${String(app.id)}`));
        say(`  Also connected to the Page: ${names.join(', ')}.`);
        say('  If one of them answers customers too, they get two answers.');
      }
    } catch (error) {
      trouble(explainGraphError(error, 'page'));
    }
  }

  say();
  say('4. Who can write to the assistant');
  say('  While the app is in development, Facebook passes on only the messages of people who');
  say('  have a role on the app (administrators, developers, testers). For everyone else, see');
  say('  "Opening the assistant to all customers" in the README.');

  say();
  const howToStart =
    'Start it with "pnpm start" (or "pnpm start --tunnel" to try it from this computer).';
  if (!ok) say('Not everything is in order; see above.');
  else if (canManage) say(`Everything the assistant needs is in order. ${howToStart}`);
  else {
    say('The assistant can run with these values. Left for you, once: "Add Subscriptions" in the');
    say(`app\u2019s dashboard (see 1). ${howToStart}`);
  }
  return ok;
}

/**
 * Turns the token of a person into a lasting token of the Page they manage,
 * and saves it when asked to. Returns null when it could not, having said why.
 */
async function pageTokenFor(
  graph: Graph,
  personToken: string,
  options: ReportOptions,
): Promise<{ token: string; info: TokenInfo } | null> {
  const { say } = options;
  const list = (pages: Array<{ id: string; name: string }>) => {
    if (pages.length === 0) return;
    say('  Pages this person manages and shared with the app:');
    for (const page of pages) say(`    - ${page.name}, id ${page.id}`);
  };
  try {
    if (options.saveTokenTo === null) {
      list(await pagesOf(graph, personToken, false));
      say('  NOT IN ORDER. The assistant needs a token of the Page. Run');
      say(
        '  "pnpm fb:check --save-page-token": it makes one that does not expire and saves it in .env.',
      );
      return null;
    }
    const result = await pageTokenOf(graph, personToken, options.pageId);
    list(result.pages);
    if (!result.ok) {
      say(`  NOT IN ORDER. ${result.problem}`);
      return null;
    }
    saveEnvValue(options.saveTokenTo, 'FB_PAGE_ACCESS_TOKEN', result.page.token);
    say(`  Saved a token of the Page "${result.page.name}" in ${options.saveTokenTo}, in place of`);
    say('  the person\u2019s token.');
    return { token: result.page.token, info: result.info };
  } catch (error) {
    say(`  NOT IN ORDER. ${explainGraphError(error, 'page')}`);
    return null;
  }
}
