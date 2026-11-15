import { describe, expect, it } from 'vitest';
import { SettingsError, readSettings } from './settings';

const given = {
  DASHBOARD_PASSWORD: 'correct horse',
  FB_APP_ID: '2639642633127339',
  FB_APP_SECRET: '0123456789abcdef',
  FB_PAGE_ACCESS_TOKEN: 'EAAexample',
};

const failure = (env: Record<string, string>, argv: string[] = []): string => {
  try {
    readSettings(env, argv);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    return (error as Error).message;
  }
  throw new Error('the settings were accepted');
};

describe('settings', () => {
  it('needs the password and three values from Facebook, and nothing else', () => {
    expect(readSettings(given, [])).toMatchObject({
      demo: false,
      tunnel: false,
      connection: 'messenger',
      facebook: {
        appId: '2639642633127339',
        appSecret: '0123456789abcdef',
        pageAccessToken: 'EAAexample',
        pageId: '',
        verifyToken: '',
        graphVersion: 'v27.0',
        humanAgentTag: false,
      },
      publicUrl: '',
      webhook: { host: '127.0.0.1', port: 3401 },
      dashboard: { host: '127.0.0.1', port: 3400, password: 'correct horse' },
    });
  });

  it('says which values from Facebook are missing, and where each is found', () => {
    const message = failure({ DASHBOARD_PASSWORD: 'correct horse', FB_APP_ID: '2639642633127339' });
    expect(message).toContain('To connect to Facebook, .env still needs:');
    expect(message).toContain('- FB_APP_SECRET: in the app\u2019s dashboard: App settings > Basic');
    expect(message).toContain(
      '- FB_PAGE_ACCESS_TOKEN: in the app\u2019s dashboard: Use cases > Messenger',
    );
    expect(message).not.toContain('- FB_APP_ID');
    expect(message).toContain('pnpm demo');
    // A line left empty in .env is a value not set.
    expect(failure({ ...given, FB_APP_SECRET: '' })).toContain('- FB_APP_SECRET');
    expect(failure({ ...given, FB_PAGE_ACCESS_TOKEN: '   ' })).toContain('- FB_PAGE_ACCESS_TOKEN');
  });

  it('needs nothing from Facebook to try the assistant out', () => {
    const settings = readSettings({}, ['--demo', '--tunnel']);
    expect(settings).toMatchObject({
      demo: true,
      tunnel: false,
      connection: 'simulator',
      businessFile: 'config/business.demo.ts',
      dashboard: { password: 'demo' },
    });
    expect(readSettings({ ...given, CHAT_CONNECTION: 'simulator' }, []).connection).toBe(
      'simulator',
    );
  });

  it('still asks for a password of some length', () => {
    expect(failure({ ...given, DASHBOARD_PASSWORD: 'short' })).toContain('DASHBOARD_PASSWORD');
  });

  it('takes the public address with HTTPS only, and tidies it', () => {
    const url = (value: string) => readSettings({ ...given, PUBLIC_URL: value }, []).publicUrl;
    expect(url('https://assistant.example.com')).toBe('https://assistant.example.com');
    expect(url('https://assistant.example.com/')).toBe('https://assistant.example.com');
    expect(url('  https://Example.com/booking/  ')).toBe('https://example.com/booking');
    expect(failure({ ...given, PUBLIC_URL: 'http://assistant.example.com' })).toContain(
      'PUBLIC_URL must begin with https://',
    );
    expect(failure({ ...given, PUBLIC_URL: 'assistant.example.com' })).toContain(
      'PUBLIC_URL is not an address',
    );
  });

  it('drops the spaces that come along when a token is pasted', () => {
    const settings = readSettings({ ...given, FB_PAGE_ACCESS_TOKEN: '  EAAexample \n' }, []);
    expect(settings.facebook.pageAccessToken).toBe('EAAexample');
  });

  it('reads the options for trying out and for answering after 24 hours', () => {
    const settings = readSettings(
      {
        ...given,
        FB_HUMAN_AGENT_TAG: 'yes',
        FB_GRAPH_VERSION: 'v26.0',
        FB_PAGE_ID: '700000000000001',
        FB_VERIFY_TOKEN: 'a word',
        WEBHOOK_PORT: '8080',
        WEBHOOK_HOST: '0.0.0.0',
        STAFF_THREAD_IDS: '111, 222',
      },
      ['--tunnel'],
    );
    expect(settings).toMatchObject({
      tunnel: true,
      facebook: {
        humanAgentTag: true,
        graphVersion: 'v26.0',
        pageId: '700000000000001',
        verifyToken: 'a word',
      },
      webhook: { host: '0.0.0.0', port: 8080 },
      staffThreadIds: ['111', '222'],
    });
  });

  it('names the value that cannot be used', () => {
    expect(failure({ ...given, FB_APP_ID: 'my-app' })).toContain('FB_APP_ID: is a number');
    expect(failure({ ...given, FB_GRAPH_VERSION: '27' })).toContain(
      'FB_GRAPH_VERSION: looks like v27.0',
    );
    expect(failure({ ...given, WEBHOOK_PORT: '99999' })).toContain('WEBHOOK_PORT');
    expect(failure({ ...given, FB_HUMAN_AGENT_TAG: 'maybe' })).toContain('FB_HUMAN_AGENT_TAG');
    expect(failure({ ...given, CHAT_CONNECTION: 'facebook' })).toContain('CHAT_CONNECTION');
  });
});
