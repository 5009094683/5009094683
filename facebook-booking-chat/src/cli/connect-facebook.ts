/*
  Connects the Page by signing in with Facebook, instead of copying a token:

    pnpm fb:connect              opens a page with a "Continue with Facebook" button in the browser
    pnpm fb:connect --no-open    only prints the page's address (http://localhost:3402), to open
                                 in whichever browser is signed in to Facebook

  It needs FB_APP_ID and FB_APP_SECRET in .env, and writes FB_PAGE_ACCESS_TOKEN
  there. The person who signs in must manage the Page.
*/
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { SettingsError, loadEnvFile, readSettings } from '../settings';
import { connectFacebook } from './facebook-connect';

/** Shows an address in the computer's usual browser. */
function openInBrowser(url: string): void {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    spawn(command!, args, { stdio: 'ignore', detached: true })
      .on('error', () => undefined)
      .unref();
  } catch {
    // The address is printed as well.
  }
}

async function main(): Promise<number> {
  loadEnvFile();
  // Neither the dashboard nor a token is needed to get a token.
  const settings = readSettings(
    {
      ...process.env,
      DASHBOARD_PASSWORD: 'not-used-here',
      CHAT_CONNECTION: 'messenger',
      FB_PAGE_ACCESS_TOKEN: process.env.FB_PAGE_ACCESS_TOKEN || 'none-yet',
    },
    [],
  );
  const port = Number(process.env.FB_CONNECT_PORT ?? 3402);
  const ok = await connectFacebook({
    appId: settings.facebook.appId,
    appSecret: settings.facebook.appSecret,
    graphVersion: settings.facebook.graphVersion,
    pageId: settings.facebook.pageId,
    envFile: resolve('.env'),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3402,
    timeoutMs: 15 * 60_000,
    say: (line = '') => console.log(line),
    open: process.argv.includes('--no-open') ? () => undefined : openInBrowser,
  });
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof SettingsError ? `\n${error.message}\n` : error);
    process.exit(1);
  },
);
