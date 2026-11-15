/*
  Talk to the assistant in the terminal, without Facebook and without keeping
  anything: for trying out the settings and the wording.

    pnpm talk                          sample settings (config/business.demo.ts)
    pnpm talk config/business.ts       the company's settings

  With lines piped in, it prints the conversation and stops:

    printf 'hello\nhow much is a scooter?\n' | pnpm talk
*/
import { createInterface } from 'node:readline';
import { Desk } from '../src/bookings/desk';
import { loadBusiness } from '../src/business/load';
import type { Lang } from '../src/business/schema';
import { Engine } from '../src/engine/engine';
import { Store } from '../src/store';

const business = await loadBusiness(process.argv[2] ?? 'config/business.demo.ts');
const store = Store.open(':memory:');
const engine = new Engine(business, new Desk(store, business), store.bookings);

const threadId = 'terminal';
let lang: Lang = business.defaultLanguage;
let state: unknown;
store.conversations.open(threadId, lang, Date.now());

const interactive = process.stdin.isTTY === true;
if (interactive) {
  console.log(`Talking to the assistant of ${business.company.name}. Ctrl+C to stop.\n`);
}

const lines = createInterface({ input: process.stdin, prompt: interactive ? 'you> ' : '' });
lines.prompt();
for await (const line of lines) {
  if (!interactive) console.log(`you> ${line}`);
  const result = engine.handle(
    state,
    { text: line, attachments: 0 },
    { threadId, lang, customerName: null, now: Date.now() },
  );
  state = result.state;
  lang = result.lang;
  for (const reply of result.replies) console.log(`\n${reply}\n`);
  if (result.replies.length === 0) console.log('\n(no reply)\n');
  if (result.booking) {
    console.log(`  [booking ${result.booking.code} recorded as ${result.booking.status}]\n`);
  }
  if (result.handoff) {
    console.log(`  [passed to a person: ${result.handoff}; the assistant would now stay silent]\n`);
  }
  lines.prompt();
}
