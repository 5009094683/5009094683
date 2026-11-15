import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Graph, type TokenInfo, explainGraphError } from '../transport/graph';
import { WEBHOOK_FIELDS, WEBHOOK_PATH } from '../transport/messenger';

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

interface PageAccount {
  id: string;
  name: string;
  token: string;
  tasks: string[];
}

const NEEDED = ['pages_messaging', 'pages_manage_metadata'];
const USEFUL = ['pages_read_engagement', 'pages_show_list', 'business_management'];

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
        'copied whole. Create a new one in the app\u2019s dashboard under "Messenger API Settings" ' +
        'and put it into .env as FB_PAGE_ACCESS_TOKEN.',
    );
    return false;
  }
  if (info.appId !== null && info.appId !== options.appId) {
    trouble(
      `The access token was made for another Facebook app (id ${info.appId}). Create it in the ` +
        `dashboard of the app ${options.appId}.`,
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
    trouble('The access token is neither of a Page nor of a person. Create one for the Page.');
    return false;
  }

  let page: { id: string; name: string };
  try {
    const me = await graph.get<{ id?: unknown; name?: unknown }>('me', token, {
      fields: 'id,name',
    });
    page = { id: String(me.id ?? ''), name: typeof me.name === 'string' ? me.name : '' };
  } catch (error) {
    trouble(explainGraphError(error, 'page'));
    return false;
  }
  say(`  Page:         ${page.name || '(no name given)'}, id ${page.id}`);
  if (options.pageId !== '' && options.pageId !== page.id) {
    trouble(`FB_PAGE_ID names another Page (${options.pageId}). Correct it, or leave it empty.`);
  }
  if (info.expiresAt === null) {
    say('  Token ends:   never');
  } else {
    say(`  Token ends:   ${day(info.expiresAt)}`);
    trouble(
      'The token ends on that day, and the assistant with it. Create the token in the app\u2019s ' +
        'dashboard under "Messenger API Settings" (those do not end), or put the token of a ' +
        'person who manages the Page into .env and run "pnpm fb:check --save-page-token".',
    );
  }
  const lacking = NEEDED.filter((name) => !info.permissions.includes(name));
  const wished = USEFUL.filter((name) => !info.permissions.includes(name));
  say(`  Permissions:  ${info.permissions.join(', ') || '(none)'}`);
  if (lacking.length > 0) {
    trouble(
      `The token lacks ${lacking.join(' and ')}. Create it again, signed in as someone who ` +
        'manages the Page, and leave every permission ticked.',
    );
  } else if (wished.length > 0) {
    say(`  (Not granted, and not needed to answer customers: ${wished.join(', ')}.)`);
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
      trouble(
        'Facebook has no address to deliver messages to, and PUBLIC_URL is not set. Set it to ' +
          'the HTTPS address of this program, or start with "pnpm start --tunnel" to try it out.',
      );
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
  try {
    const listed = await graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${page.id}/subscribed_apps`,
      token,
    );
    const apps = listed.data ?? [];
    const mine = apps.find((app) => String(app.id) === options.appId);
    if (mine) {
      const fields = Array.isArray(mine.subscribed_fields) ? mine.subscribed_fields : [];
      say(`  The Page is switched on for the app (${fields.join(', ') || 'no fields'}).`);
    } else {
      say('  The Page is not switched on for the app yet; the assistant does that when it starts.');
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

  say();
  say('4. Who can write to the assistant');
  say('  While the app is in development, Facebook passes on only the messages of people who');
  say('  have a role on the app (administrators, developers, testers). For everyone else, see');
  say('  "Opening the assistant to all customers" in the README.');

  say();
  say(
    ok
      ? 'Everything the assistant needs is in order. Start it with "pnpm start" (or ' +
          '"pnpm start --tunnel" to try it from this computer).'
      : 'Not everything is in order; see above.',
  );
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
  try {
    // A token of the Page made from a long-lived token of the person does not expire.
    const saving = options.saveTokenTo !== null;
    const lasting = saving ? await graph.extendToken(personToken) : personToken;
    const listed = await graph.get<{ data?: Array<Record<string, unknown>> }>(
      'me/accounts',
      lasting,
      { fields: saving ? 'id,name,tasks,access_token' : 'id,name,tasks', limit: 100 },
    );
    const pages: PageAccount[] = (listed.data ?? []).map((entry) => ({
      id: String(entry.id ?? ''),
      name: String(entry.name ?? ''),
      token: String(entry.access_token ?? ''),
      tasks: Array.isArray(entry.tasks) ? entry.tasks.map(String) : [],
    }));
    if (pages.length === 0) {
      say('  NOT IN ORDER. This person manages no Page that the app was given access to. Create');
      say('  the token again and choose the Page when Facebook asks which ones to share.');
      return null;
    }
    say('  Pages this person manages and shared with the app:');
    for (const page of pages) say(`    - ${page.name}, id ${page.id}`);

    const chosen =
      options.pageId !== ''
        ? pages.find((page) => page.id === options.pageId)
        : pages.length === 1
          ? pages[0]
          : undefined;
    if (!chosen) {
      say(
        options.pageId !== ''
          ? `  NOT IN ORDER. None of them has the id in FB_PAGE_ID (${options.pageId}).`
          : '  NOT IN ORDER. Say which one the assistant answers for: set FB_PAGE_ID in .env to its id.',
      );
      return null;
    }
    if (!chosen.tasks.includes('MESSAGING') || !chosen.tasks.includes('MODERATE')) {
      say(`  NOT IN ORDER. On "${chosen.name}" this person may not answer messages. Someone with`);
      say('  full access to the Page has to create the token.');
      return null;
    }
    if (options.saveTokenTo === null) {
      say('  NOT IN ORDER. The assistant needs a token of the Page. Run');
      say(
        '  "pnpm fb:check --save-page-token": it makes one that does not expire and saves it in .env.',
      );
      return null;
    }
    const info = await graph.lookUpToken(chosen.token);
    saveEnvValue(options.saveTokenTo, 'FB_PAGE_ACCESS_TOKEN', chosen.token);
    say(`  Saved a token of the Page "${chosen.name}" in ${options.saveTokenTo}, in place of the`);
    say('  person\u2019s token.');
    return { token: chosen.token, info };
  } catch (error) {
    say(`  NOT IN ORDER. ${explainGraphError(error, 'page')}`);
    return null;
  }
}
