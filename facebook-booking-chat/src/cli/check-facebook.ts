/*
  Looks over the connection to Facebook on its own, before or while the
  assistant runs:

    pnpm fb:check                      what is in .env, and what Facebook has on record for it
    pnpm fb:check --save-page-token    also turns the token of a person in .env into a token
                                       of the Page that does not expire, and saves it there

  It reads the same settings as the assistant (.env). Without the option it
  changes nothing, here or at Facebook.
*/
import { resolve } from 'node:path';
import { SettingsError, loadEnvFile, readSettings } from '../settings';
import { reportOnFacebook } from './facebook-report';

async function main(): Promise<number> {
  loadEnvFile();
  // The dashboard is not started here, so its password is not needed.
  const settings = readSettings(
    { ...process.env, DASHBOARD_PASSWORD: 'not-used-here', CHAT_CONNECTION: 'messenger' },
    [],
  );
  const ok = await reportOnFacebook({
    ...settings.facebook,
    publicUrl: settings.publicUrl,
    saveTokenTo: process.argv.includes('--save-page-token') ? resolve('.env') : null,
    say: (line = '') => console.log(line),
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
