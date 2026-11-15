/// <reference lib="dom" />
/*
  Walks through the dashboard in a real browser against a running try-out
  instance (`pnpm demo`) and saves a screenshot of each step.

    pnpm demo                         in one terminal
    pnpm tsx scripts/walkthrough.ts   in another

  Screenshots go to the folder given as the first argument (default: ./var/walkthrough).
*/
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Page, chromium } from 'playwright-core';

const base = process.env.DASHBOARD_ADDRESS ?? 'http://127.0.0.1:3400';
const out = resolve(process.argv[2] ?? './var/walkthrough');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
const problems: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

let step = 0;
async function shot(name: string, fullPage = false): Promise<void> {
  step += 1;
  const file = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
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

// ---- narrow screen
await page.setViewportSize({ width: 390, height: 800 });
await page.goto(`${base}/bookings?status=all`);
await shot('phone-bookings');
await page.goto(`${base}/conversations`);
await page.click('.convo >> nth=1');
await shot('phone-chat');

// ---- signed out, nothing is reachable
await page.setViewportSize({ width: 1280, height: 860 });
await page.click('.signout button');
await page.waitForURL('**/login');
await page.goto(`${base}/bookings`);
expectText(page.url(), '/login', 'after signing out');

await browser.close();
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nWalkthrough finished without problems.');
