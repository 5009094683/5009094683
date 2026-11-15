import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeFacebook } from '../../test/fake-facebook';
import { WEBHOOK_FIELDS } from '../transport/messenger';
import { type ReportOptions, reportOnFacebook, saveEnvValue } from './facebook-report';

const ADDRESS = 'https://assistant.example.com';

async function report(
  options: Partial<ReportOptions> = {},
  prepare?: (facebook: FakeFacebook) => void,
) {
  const facebook = new FakeFacebook();
  prepare?.(facebook);
  const lines: string[] = [];
  const ok = await reportOnFacebook({
    appId: facebook.appId,
    appSecret: facebook.appSecret,
    pageAccessToken: facebook.pageToken,
    pageId: '',
    graphVersion: facebook.version,
    publicUrl: ADDRESS,
    saveTokenTo: null,
    say: (line = '') => lines.push(line),
    fetch: facebook.fetch,
    ...options,
  });
  return { ok, text: lines.join('\n'), facebook };
}

function envFile(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'fbchat-env-')), '.env');
  writeFileSync(file, content);
  return file;
}

describe('pnpm fb:check', () => {
  it('reports values that are in order, before the assistant has ever run', async () => {
    const { ok, text, facebook } = await report();
    expect(ok).toBe(true);
    expect(text).toContain('Facebook accepts the app id and the app secret.');
    expect(text).toContain('Page:         Cao Bằng Travel Guide, id 700000000000001');
    expect(text).toContain('Token ends:   never');
    expect(text).toContain('Permissions:  pages_show_list, pages_messaging, pages_manage_metadata');
    expect(text).toContain('On record:    nothing yet');
    expect(text).toContain(`PUBLIC_URL:   ${ADDRESS}`);
    expect(text).toContain(
      'The assistant registers the address in PUBLIC_URL with Facebook when it starts.',
    );
    expect(text).toContain(
      'The Page is not switched on for the app yet; the assistant does that when it starts.',
    );
    expect(text).toContain('Everything the assistant needs is in order.');

    // It looks, and changes nothing.
    expect(facebook.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(text).not.toContain(facebook.pageToken);
    expect(text).not.toContain(facebook.appSecret);
  });

  it('reports what Facebook has on record once the assistant has run', async () => {
    const { ok, text } = await report({}, (facebook) => {
      facebook.subscription = {
        callback_url: `${ADDRESS}/webhook`,
        fields: [...WEBHOOK_FIELDS],
        active: true,
      };
      facebook.subscribedApps = [
        {
          id: facebook.appId,
          name: 'Booking assistant',
          subscribed_fields: ['messages', 'message_echoes'],
        },
        { id: '999', name: 'Some CRM', subscribed_fields: ['messages'] },
      ];
    });
    expect(ok).toBe(true);
    expect(text).toContain(`On record:    ${ADDRESS}/webhook`);
    expect(text).toContain('It reports:   messages, message_echoes, messaging_postbacks');
    expect(text).toContain('The address on record is the one in PUBLIC_URL.');
    expect(text).toContain('The Page is switched on for the app (messages, message_echoes).');
    expect(text).toContain('Also connected to the Page: Some CRM.');
  });

  it.each<[string, Partial<ReportOptions>, (facebook: FakeFacebook) => void, RegExp]>([
    ['a wrong app secret', { appSecret: 'wrong' }, () => undefined, /FB_APP_ID and FB_APP_SECRET/],
    [
      'a token Facebook does not accept',
      {},
      (facebook) => (facebook.token.valid = false),
      /does not accept the access token/,
    ],
    [
      'a token of another app',
      {},
      (facebook) => (facebook.token.appId = '999'),
      /made for another Facebook app \(id 999\)/,
    ],
    [
      'a token that may not answer chats',
      {},
      (facebook) => (facebook.token.scopes = ['pages_manage_metadata', 'pages_show_list']),
      /The token lacks pages_messaging, without which the Page\u2019s chats can be neither read nor answered\. Make a new one in the app\u2019s dashboard: under "Messenger API Settings", press "Generate"/,
    ],
    [
      'a token that ends',
      {},
      (facebook) => (facebook.token.expiresAt = 1_800_000_000),
      /Token ends: {3}2027-01-15[\s\S]*The token ends on that day, and the assistant with it/,
    ],
    [
      'another Page than the one named',
      { pageId: '123' },
      () => undefined,
      /FB_PAGE_ID names another Page \(123\)/,
    ],
  ])('says what is wrong with %s', async (_what, options, prepare, expected) => {
    const { ok, text } = await report(options, prepare);
    expect(ok).toBe(false);
    expect(text).toMatch(expected);
    expect(text).toContain('NOT IN ORDER.');
  });

  it('says what is left to a person with the token the app\u2019s dashboard makes', async () => {
    // As a real one showed: it may answer chats and nothing else.
    const { ok, text, facebook } = await report({}, (f) => {
      f.token.scopes = FakeFacebook.DASHBOARD_TOKEN_SCOPES;
    });
    expect(ok).toBe(true);
    // Facebook does not tell such a token the Page's name outright, and this Page has had no
    // chat that would name it; the id is known from the token itself.
    expect(text).toContain(
      'Page:         (Facebook does not tell this token the name), id 700000000000001',
    );
    expect(text).toContain('Permissions:  pages_messaging, public_profile');
    expect(text).toContain(
      'This token may answer chats, but may not switch the Page on for the app',
    );
    expect(text).toContain(
      'press \u201cAdd Subscriptions\u201d next to the Page; tick messages, messaging_postbacks and message_echoes, and press Confirm.',
    );
    expect(text).not.toContain('fb:connect');
    // The address is the app's to register, and is looked at as before.
    expect(text).toContain('On record:    nothing yet');
    // What Facebook refuses such a token is not asked.
    expect(text).toContain(
      'Whether the Page is switched on for the app cannot be seen with this token (see 1).',
    );
    expect(facebook.calls('GET', /subscribed_apps$/)).toHaveLength(0);
    expect(text).toContain(
      'The assistant can run with these values. Left for you, once: "Add Subscriptions" in the',
    );
    expect(text).not.toContain('NOT IN ORDER');
  });

  it('names the Page from its list of chats where the token is not told the name', async () => {
    const { ok, text } = await report({}, (f) => {
      f.token.scopes = FakeFacebook.DASHBOARD_TOKEN_SCOPES;
      f.chats.set('42', 'Anna Müller');
    });
    expect(ok).toBe(true);
    expect(text).toContain('Page:         Cao Bằng Travel Guide, id 700000000000001');
    // Who the Page talks to is nobody's business here.
    expect(text).not.toContain('Anna');
  });

  it('says how the address gets registered where none is set yet', async () => {
    const { ok, text } = await report({ publicUrl: '' });
    expect(ok).toBe(true);
    expect(text).toContain('PUBLIC_URL:   (not set)');
    expect(text).toContain(
      'The assistant registers its address when it starts: with "pnpm start --tunnel"',
    );
  });

  it('says what to do about the token of a person, and changes nothing unasked', async () => {
    const file = envFile('FB_PAGE_ACCESS_TOKEN=EAA-person-token\n');
    const { ok, text, facebook } = await report({ pageAccessToken: 'EAA-person-token' });
    expect(ok).toBe(false);
    expect(text).toContain('The access token is the token of a person, not of a Page.');
    expect(text).toContain('- Cao Bằng Travel Guide, id 700000000000001');
    expect(text).toContain('"pnpm fb:check --save-page-token"');
    expect(readFileSync(file, 'utf8')).toBe('FB_PAGE_ACCESS_TOKEN=EAA-person-token\n');
    expect(text).not.toContain(facebook.pageToken);
  });

  it('turns the token of a person into a lasting token of the Page and saves it', async () => {
    const file = envFile(
      '# settings\nDASHBOARD_PASSWORD=keep me\nFB_PAGE_ACCESS_TOKEN=EAA-person-token\nFB_APP_ID=555500001111\n',
    );
    const { ok, text, facebook } = await report({
      pageAccessToken: 'EAA-person-token',
      saveTokenTo: file,
    });
    expect(ok).toBe(true);
    expect(text).toContain(`Saved a token of the Page "Cao Bằng Travel Guide" in ${file}`);
    expect(text).toContain('Token ends:   never');
    expect(readFileSync(file, 'utf8')).toBe(
      `# settings\nDASHBOARD_PASSWORD=keep me\nFB_PAGE_ACCESS_TOKEN=${facebook.pageToken}\nFB_APP_ID=555500001111\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The Page's token was made from the extended token of the person: that is what makes it last.
    expect(facebook.calls('GET', /^me\/accounts$/)[0]!.token).toBe('long-EAA-person-token');
    expect(text).not.toContain(facebook.pageToken);
  });

  it('asks which Page when the person named another', async () => {
    const { ok, text } = await report({
      pageAccessToken: 'EAA-person-token',
      pageId: '123',
      saveTokenTo: envFile(''),
    });
    expect(ok).toBe(false);
    expect(text).toContain('None of the Pages has the id in FB_PAGE_ID (123).');
  });
});

describe('writing a value into .env', () => {
  it('replaces the line that sets it, and leaves the rest', () => {
    const file = envFile('A=1\nTOKEN=old\n# TOKEN=commented\nB=2\n');
    saveEnvValue(file, 'TOKEN', 'new$1&value');
    expect(readFileSync(file, 'utf8')).toBe('A=1\nTOKEN=new$1&value\n# TOKEN=commented\nB=2\n');
  });

  it('adds the line when there is none', () => {
    const file = envFile('A=1');
    saveEnvValue(file, 'TOKEN', 'value');
    expect(readFileSync(file, 'utf8')).toBe('A=1\nTOKEN=value\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
