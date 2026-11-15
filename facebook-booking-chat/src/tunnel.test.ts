import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Tunnel, TunnelError, openTunnel } from './tunnel';

/*
  cloudflared is played by a small script that prints what the real one
  prints: the address it was given, and that the tunnel carries traffic.
*/
const STAND_IN = `#!/usr/bin/env node
const fs = require('node:fs');
const state = process.env.FAKE_TUNNEL_STATE;
let run = 0;
try { run = Number(fs.readFileSync(state, 'utf8')); } catch {}
fs.writeFileSync(state, String(run + 1));
fs.appendFileSync(state + '.args', process.argv.slice(2).join(' ') + '\\n');
const mode = process.env.FAKE_TUNNEL_MODE || '';
console.error('2026-11-15T02:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');
if (mode === 'refuses') {
  console.error('2026-11-15T02:00:01Z ERR failed to request quick Tunnel: 429 Too Many Requests');
  process.exit(1);
}
console.error('2026-11-15T02:00:01Z INF |  https://fake-tunnel-' + run + '.trycloudflare.com  |');
if (mode !== 'never-connects') {
  console.error('2026-11-15T02:00:02Z INF Registered tunnel connection connIndex=0 location=sin01');
}
if (mode === 'dies-once' && run === 0) setTimeout(() => process.exit(1), 60);
else setInterval(() => {}, 1000);
`;

let directory: string;
let command: string;
let state: string;
let tunnel: Tunnel | null;
const log = { info: () => undefined, warn: () => undefined };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fbchat-tunnel-'));
  command = join(directory, 'cloudflared');
  state = join(directory, 'state');
  writeFileSync(command, STAND_IN);
  chmodSync(command, 0o755);
  process.env.FAKE_TUNNEL_STATE = state;
  delete process.env.FAKE_TUNNEL_MODE;
  tunnel = null;
});

afterEach(() => {
  tunnel?.stop();
  delete process.env.FAKE_TUNNEL_STATE;
  delete process.env.FAKE_TUNNEL_MODE;
});

describe('the try-out tunnel', () => {
  it('opens a tunnel to the port and reports its address', async () => {
    tunnel = await openTunnel(3401, {
      command,
      log,
      onNewUrl: () => undefined,
      answers: async () => true,
    });
    expect(tunnel.url).toBe('https://fake-tunnel-0.trycloudflare.com');
    expect(readFileSync(`${state}.args`, 'utf8')).toBe(
      'tunnel --no-autoupdate --url http://127.0.0.1:3401\n',
    );
  });

  it('waits until the new address answers', async () => {
    let asked = 0;
    tunnel = await openTunnel(3401, {
      command,
      log,
      onNewUrl: () => undefined,
      answers: async (url) => {
        expect(url).toBe('https://fake-tunnel-0.trycloudflare.com');
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(1);
  });

  it('opens a new one when the tunnel closes, and reports the new address', async () => {
    process.env.FAKE_TUNNEL_MODE = 'dies-once';
    const reported: string[] = [];
    tunnel = await openTunnel(3401, {
      command,
      log,
      onNewUrl: (url) => reported.push(url),
      answers: async () => true,
      reopenAfterMs: 10,
    });
    expect(tunnel.url).toBe('https://fake-tunnel-0.trycloudflare.com');
    await expect
      .poll(() => reported, { timeout: 5000, interval: 20 })
      .toEqual(['https://fake-tunnel-1.trycloudflare.com']);
    expect(tunnel.url).toBe('https://fake-tunnel-1.trycloudflare.com');
  });

  it('says how to get cloudflared when it is not installed', async () => {
    const failure = await openTunnel(3401, {
      command: join(directory, 'not-there'),
      log,
      onNewUrl: () => undefined,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TunnelError);
    expect((failure as Error).message).toMatch(
      /--tunnel needs the program .*brew install cloudflared/,
    );
  });

  it('says what cloudflared said when no tunnel comes up', async () => {
    process.env.FAKE_TUNNEL_MODE = 'refuses';
    const refused = await openTunnel(3401, { command, log, onNewUrl: () => undefined }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(TunnelError);
    expect((refused as Error).message).toMatch(
      /stopped before the tunnel was up.*429 Too Many Requests/,
    );

    process.env.FAKE_TUNNEL_MODE = 'never-connects';
    const slow = await openTunnel(3401, {
      command,
      log,
      onNewUrl: () => undefined,
      startTimeoutMs: 300,
    }).catch((error: unknown) => error);
    expect(slow).toBeInstanceOf(TunnelError);
    expect((slow as Error).message).toMatch(/did not come up within 0 seconds/);
  });

  it('closes the tunnel when stopped, and opens no other', async () => {
    tunnel = await openTunnel(3401, {
      command,
      log,
      onNewUrl: () => undefined,
      answers: async () => true,
      reopenAfterMs: 10,
    });
    tunnel.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(state, 'utf8')).toBe('1');
  });
});
