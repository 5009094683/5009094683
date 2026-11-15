/*
  Tries the connection to Facebook on its own, before the assistant is let
  loose on customers:

    pnpm fb:check            signs in, waits for one message, shows it
    pnpm fb:check --reply    also answers that message with a test line

  It reads the same settings as the assistant (.env) and changes nothing but
  the session file, which it keeps renewed.
*/
import { loadBusiness } from '../business/load';
import { loadEnvFile, readSettings } from '../settings';
import { FacebookTransport } from '../transport/facebook';
import { SessionError, describeSession, loadSession } from '../transport/session';
import type { IncomingMessage } from '../transport/types';

const WAIT_FOR_CONNECTION_MS = 100_000;
const WAIT_FOR_MESSAGE_MS = 3 * 60_000;
const WAIT_FOR_ECHO_MS = 15_000;

const say = (line = '') => console.log(line);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(250);
  }
  return condition();
}

async function main(): Promise<number> {
  loadEnvFile();
  // The dashboard is not started here, so its password is not needed.
  const settings = readSettings({ ...process.env, DASHBOARD_PASSWORD: 'not-used-here' });
  const reply = process.argv.includes('--reply');
  const business = await loadBusiness(settings.businessFile);

  say(`Session file: ${settings.sessionFile}`);
  let session;
  try {
    session = loadSession(settings.sessionFile);
  } catch (error) {
    if (!(error instanceof SessionError)) throw error;
    say(`\nNOT USABLE. ${error.message}`);
    return 1;
  }
  say(`Signs in as:  ${describeSession(session)}`);
  if (session.pageId === null) {
    say();
    say('Note: this is a personal profile, not a Page. Facebook encrypts chats between personal');
    say('profiles end to end, and the assistant cannot read those. To answer as the Page, switch');
    say('into the Page in the browser (profile picture, top right) before exporting the cookies.');
  }

  const received: IncomingMessage[] = [];
  const transport = new FacebookTransport({
    sessionFile: settings.sessionFile,
    sendVia: settings.sendVia,
    userAgent: settings.userAgent,
    retryDelaysMs: [24 * 60 * 60_000], // One attempt is enough to tell.
    log: {
      info: (_details, message) => say(`  ${message}`),
      warn: (details, message) => say(`  ${message} ${JSON.stringify(details)}`),
      error: () => undefined,
    },
  });

  say('\nSigning in and connecting to Messenger...');
  await transport.start((message) => received.push(message));
  const connected = await until(() => {
    const state = transport.status().state;
    return state === 'connected' || state === 'disconnected';
  }, WAIT_FOR_CONNECTION_MS);

  const status = transport.status();
  if (!connected || status.state !== 'connected') {
    say(`\nNOT CONNECTED. ${status.lastError ?? 'Facebook did not answer in time.'}`);
    await transport.stop();
    return 1;
  }
  await sleep(2000);
  const account = transport.status().account;
  say(`Connected as ${account?.name ?? '(name not available)'}, id ${account?.id}.`);

  say('\nNow send a message to this account from ANOTHER Facebook account.');
  say(`Waiting up to ${WAIT_FOR_MESSAGE_MS / 60_000} minutes...`);
  const fromCustomer = () => received.find((message) => !message.fromSelf && !message.isGroup);
  await until(() => fromCustomer() !== undefined, WAIT_FOR_MESSAGE_MS);
  const message = fromCustomer();

  let ok = true;
  if (!message) {
    ok = false;
    say('\nNO MESSAGE ARRIVED. Signing in worked, but nothing was received. If you did send one:');
    say(
      '- from a personal profile to a personal profile, the chat is encrypted and cannot be read;',
    );
    say('- the message may sit under "Message requests" until it is accepted in Messenger.');
  } else {
    const name = (await transport.nameOf(message.senderId)) ?? '(name not available)';
    say(`\nRECEIVED from ${name} (id ${message.senderId}): ${JSON.stringify(message.text)}`);

    if (reply) {
      const text = `This is a test message from the booking assistant of ${business.company.name}. Please ignore it.`;
      try {
        await transport.sendText(message.threadId, text);
        say(
          `SENT a test reply (FB_SEND_VIA=${settings.sendVia}). Check that it shows in the chat.`,
        );
        const reportedBack = () =>
          received.find((echo) => echo.fromSelf && echo.threadId === message.threadId);
        await until(() => reportedBack() !== undefined, WAIT_FOR_ECHO_MS);
        const echo = reportedBack();
        if (!echo) {
          say(
            'Facebook did not report the reply back. The assistant will then not notice when a person',
          );
          say('answers in Messenger itself: take chats over in the dashboard instead.');
        } else if (echo.text.replace(/\s+/g, ' ').trim() === text) {
          say(
            'Facebook reported the reply back unchanged, so replies typed by a person in Messenger',
          );
          say('are told from the assistant\u2019s own.');
        } else {
          ok = false;
          say('Facebook reported the reply back, but changed. The assistant may then take its own');
          say(
            'messages for a person\u2019s and fall silent. Please report this, with the two lines below:',
          );
          say(`  sent:     ${JSON.stringify(text)}`);
          say(`  reported: ${JSON.stringify(echo.text)}`);
        }
      } catch (error) {
        ok = false;
        const other = settings.sendVia === 'mqtt' ? 'http' : 'mqtt';
        say(`\nSENDING FAILED (FB_SEND_VIA=${settings.sendVia}): ${(error as Error).message}`);
        say(`Set FB_SEND_VIA=${other} in .env and run this check again.`);
      }
    } else {
      say('Receiving works. Run "pnpm fb:check --reply" to try sending too.');
    }
  }

  await transport.stop();
  say(ok ? '\nAll checked steps worked.' : '\nNot everything worked; see above.');
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
