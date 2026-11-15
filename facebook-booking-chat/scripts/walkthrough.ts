/// <reference lib="dom" />
/*
  Walks through the dashboard in a real browser against a running try-out
  instance (`pnpm demo`) and saves a screenshot of each step.

    pnpm demo                         in one terminal
    pnpm tsx scripts/walkthrough.ts   in another

  Screenshots go to the folder given as the first argument (default: ./var/walkthrough).

  It drives Chrome (CHROME_PATH says where it is). With BROWSER=webkit it
  drives the WebKit that Playwright installs for itself
  (`pnpm exec playwright-core install webkit`), for machines without Chrome.
*/
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Page, chromium, webkit } from 'playwright-core';

const base = process.env.DASHBOARD_ADDRESS ?? 'http://127.0.0.1:3400';
const out = resolve(process.argv[2] ?? './var/walkthrough');
mkdirSync(out, { recursive: true });

const browser =
  process.env.BROWSER === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
        headless: true,
      });
const viewport = { width: 1280, height: 860 };
const context = await browser.newContext({
  viewport,
  // Set VIDEO_DIR to keep a recording of the whole walk as well.
  recordVideo: process.env.VIDEO_DIR ? { dir: process.env.VIDEO_DIR, size: viewport } : undefined,
});
const page = await context.newPage();
const problems: string[] = [];
let shooting = false;
page.on('console', (message) => {
  // For a screenshot, the driver of WebKit adds a style sheet to the page. The
  // dashboard's rules for content refuse it and say so in the console: that
  // is the driver's doing, not the page's.
  if (message.type() === 'error' && !shooting) problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

let step = 0;
async function shot(name: string, fullPage = false): Promise<void> {
  step += 1;
  const file = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  shooting = true;
  try {
    await page.screenshot({ path: file, fullPage });
    await page.waitForTimeout(150);
  } finally {
    shooting = false;
  }
  console.log(`saved ${file}`);
}

/** Writes as the customer on the try-out page and waits for the assistant's answer. */
async function customerSays(p: Page, text: string): Promise<string> {
  const before = await p.locator('[data-chat] .bubble.bot').count();
  await p.locator('form[data-try] textarea').fill(text);
  await p.locator('form[data-try] textarea').press('Enter');
  await p.waitForFunction(
    (n) => document.querySelectorAll('[data-chat] .bubble.bot').length > n,
    before,
    { timeout: 15_000 },
  );
  await p.waitForTimeout(300);
  return (await p.locator('[data-chat] .bubble.bot').last().innerText()).trim();
}

function expectText(actual: string, wanted: string, where: string): void {
  if (!actual.includes(wanted)) {
    problems.push(`${where}: expected to find "${wanted}" in:\n${actual}`);
  }
}

// ---- sign in
await page.goto(`${base}/bookings`);
await shot('sign-in');
await page.fill('input[name=password]', 'wrong');
await page.click('button[type=submit]');
expectText(await page.innerText('body'), 'That is not the password.', 'wrong password');
// The browser notes the refused sign-in in its console; that one is expected.
problems.length = 0;
await page.fill('input[name=password]', 'demo');
await page.click('button[type=submit]');
await page.waitForURL('**/bookings');
await shot('bookings-empty');

// ---- a customer books a motorbike in English; the assistant confirms by itself
await page.goto(`${base}/try`);
await page.fill('input[name=name]', 'Emma Wilson');
await page.click('form[action="/try/new"] button');
await page.waitForURL('**/try');
expectText(await customerSays(page, 'Hi! Do you rent scooters?'), '200,000 VND', 'price answer');
await customerSays(page, 'Great, I would like 2 automatic ones from 20/11 for 3 days');
await customerSays(page, '+61 412 345 678');
const summary = await customerSays(page, 'We are staying at Primrose Homestay');
expectText(summary, 'Price: 200,000 VND × 2 motorbikes × 3 days = 1,200,000 VND', 'summary');
expectText(summary, 'Pick-up: Primrose Homestay', 'summary');
await shot('try-summary');
expectText(await customerSays(page, 'yes'), 'is confirmed.', 'confirmation');
await shot('try-confirmed');

// ---- a second customer asks for a tour in Vietnamese; a person has to confirm it
await page.fill('input[name=name]', 'Trần Thị Lan');
await page.click('form[action="/try/new"] button');
await page.waitForURL('**/try');
await customerSays(page, 'xin chào shop');
await customerSays(page, 'mình muốn đặt tour thác Bản Giốc cho 2 người ngày 21/11');
await customerSays(page, '0987 654 321');
await customerSays(page, 'khách sạn Sơn Tùng');
expectText(await customerSays(page, 'đồng ý'), 'đã được chuyển cho nhân viên', 'request received');
await shot('try-vietnamese-request');

// ---- the team sees the waiting booking and confirms it
await page.goto(`${base}/bookings`);
expectText(await page.innerText('.tabs'), 'Waiting for you1', 'tabs');
await shot('bookings-waiting');
await page.click('tbody tr a');
await page.waitForURL('**/bookings/CB-*');
await shot('booking-waiting');
await page.fill('input[name=total]', 'abc');
await page.click('form[action$="/confirm"] button');
expectText(await page.innerText('main'), 'The total price must be a whole number', 'bad price');
await page.fill('input[name=total]', '2.600.000');
await page.click('form[action$="/confirm"] button');
await page.waitForURL('**n=confirmed');
expectText(await page.innerText('main'), 'Confirmed. The customer has been told.', 'confirm');
expectText(await page.innerText('main'), '2,600,000 VND', 'changed price');
await shot('booking-confirmed');

// ---- the chat shows what the customer was told
await page.click('text=Open the chat');
await page.waitForURL('**/conversations/**');
expectText(await page.innerText('[data-chat]'), 'đã được xác nhận', 'chat after confirm');
expectText(await page.innerText('[data-chat]'), '2.600.000 VND', 'chat after confirm');
await page.locator('[data-chat]').evaluate((node) => (node.scrollTop = node.scrollHeight));
await shot('chat-after-confirm');

// ---- a person takes the chat over, writes, and hands it back
await page.click('form[action$="/take-over"] button');
await page.waitForURL('**n=takeover');
await page.fill(
  'textarea[name=text]',
  'Chào chị Lan, em là Hiền. Chị cần hỗ trợ gì thêm cứ nhắn em nhé!',
);
await page.click('form.reply button');
await page.waitForURL('**n=sent');
expectText(await page.innerText('[data-chat]'), 'em là Hiền', 'staff reply');
await page.locator('[data-chat]').evaluate((node) => (node.scrollTop = node.scrollHeight));
await shot('chat-person-has-it');
await page.click('form[action$="/hand-back"] button');
await page.waitForURL('**n=handback');

// ---- a customer who asks for a person shows up first in the list
await page.goto(`${base}/try`);
await page.fill('input[name=name]', 'Marco Rossi');
await page.click('form[action="/try/new"] button');
await page.waitForURL('**/try');
expectText(
  await customerSays(page, 'Can I talk to a real person please?'),
  'I have asked our team',
  'handoff',
);
await page.goto(`${base}/conversations`);
expectText(await page.innerText('.convo >> nth=0'), 'Marco Rossi', 'chat list order');
expectText(
  await page.innerText('.convo >> nth=0'),
  'The customer asked for a person.',
  'chat list flag',
);
await shot('chats');

// ---- all bookings, and the status page
await page.goto(`${base}/bookings?status=all`);
await shot('bookings-all');
await page.goto(`${base}/status`);
await shot('status', true);

// ---- a customer asks for their data to be deleted; a person deletes the chat
await page.goto(`${base}/try`);
await page.fill('input[name=name]', 'Sophie Martin');
await page.click('form[action="/try/new"] button');
await page.waitForURL('**/try');
await customerSays(page, 'Hello, how much is a scooter?');
expectText(
  await customerSays(page, 'Please delete my data'),
  'A person will delete your chat with me',
  'request to delete',
);
await page.goto(`${base}/conversations`);
expectText(await page.innerText('.convo >> nth=0'), 'Sophie Martin', 'chat list order');
expectText(await page.innerText('.convo >> nth=0'), 'asks for their data to be deleted', 'flag');
await page.click('.convo >> nth=0');
await page.waitForURL('**/conversations/**');
await shot('chat-asks-for-deletion', true);
page.once('dialog', (dialog) => void dialog.accept());
await page.click('form[action$="/delete"] button');
await page.waitForURL('**n=deleted');
expectText(await page.innerText('main'), 'The chat has been deleted', 'deleting a chat');
if ((await page.innerText('main')).includes('Sophie Martin')) {
  problems.push('deleting a chat: the deleted chat is still listed');
}
await shot('chat-deleted');

// ---- the privacy notice customers are pointed to
await page.goto(`${base}/privacy`);
expectText(await page.innerText('body'), 'What we keep', 'privacy notice');
expectText(await page.innerText('body'), 'Chúng tôi lưu những gì', 'privacy notice');
await shot('privacy-notice', true);

// ---- narrow screen
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}/bookings?status=all`);
await shot('phone-bookings');
await page.goto(`${base}/conversations`);
await page.click('.convo >> nth=1');
await shot('phone-chat');

// ---- signed out, nothing is reachable
await page.setViewportSize(viewport);
await page.click('.signout button');
await page.waitForURL('**/login');
await page.goto(`${base}/bookings`);
expectText(page.url(), '/login', 'after signing out');

const video = page.video();
await context.close();
if (video) console.log(`recorded ${await video.path()}`);
await browser.close();
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nWalkthrough finished without problems.');
