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
      'a token that lacks a permission',
      {},
      (facebook) => (facebook.token.scopes = ['pages_messaging']),
      /The token lacks pages_manage_metadata\./,
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
    [
      'no address for Facebook to deliver to',
      { publicUrl: '' },
      () => undefined,
      /no address to deliver messages to, and PUBLIC_URL is not set/,
    ],
  ])('says what is wrong with %s', async (_what, options, prepare, expected) => {
    const { ok, text } = await report(options, prepare);
    expect(ok).toBe(false);
    expect(text).toMatch(expected);
    expect(text).toContain('NOT IN ORDER.');
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
    expect(text).toContain('None of them has the id in FB_PAGE_ID (123).');
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
