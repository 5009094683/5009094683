import { type ChildProcess, spawn } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';

/*
  A try-out tunnel: a public HTTPS address that leads to a port of this
  machine, so that Facebook can reach the assistant on a computer that has no
  address of its own. It uses Cloudflare's free "quick tunnel" through the
  program cloudflared, which needs no account.

  For trying out only. The address is a new one every time, Cloudflare
  promises nothing about how long it stays up, and it ends when this program
  or the computer stops. To run the assistant for real, give it a lasting
  address (PUBLIC_URL).
*/

export interface TunnelLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface Tunnel {
  /** The public address as it is now. */
  readonly url: string;
  stop(): void;
}

export class TunnelError extends Error {}

export interface TunnelOptions {
  log: TunnelLog;
  /** Called when the tunnel had to be opened anew and got another address. */
  onNewUrl: (url: string) => void;
  /** The program to run. Replaced in tests. */
  command?: string;
  startTimeoutMs?: number;
  reopenAfterMs?: number;
  /** Looks whether the address answers yet. Replaced in tests. */
  answers?: (url: string) => Promise<boolean>;
}

const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CONNECTED = /Registered tunnel connection/i;

/**
 * Looks whether the new address is known on the internet and leads here.
 *
 * It asks public name servers, not this computer's own lookup: asked about a
 * name a moment too early, the computer remembers for minutes that there is
 * no such name, and what matters is what Facebook will find anyway.
 */
async function answersOverHttp(url: string): Promise<boolean> {
  const { hostname } = new URL(url);
  const names = new Resolver({ timeout: 2_000, tries: 1 });
  names.setServers(['1.1.1.1', '8.8.8.8']);
  let ip: string | undefined;
  try {
    [ip] = await names.resolve4(hostname);
  } catch {
    return false;
  }
  if (ip === undefined) return false;

  return new Promise<boolean>((resolve) => {
    const call = request(
      {
        host: ip,
        port: 443,
        servername: hostname,
        path: '/healthz',
        headers: { host: hostname },
        timeout: 5_000,
      },
      (response) => {
        response.resume();
        // Cloudflare answers 530 for a tunnel it does not know yet.
        resolve((response.statusCode ?? 599) < 500);
      },
    );
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve(false));
    call.end();
  });
}

/** Starts cloudflared once and resolves with the address when the tunnel carries traffic. */
function launch(
  port: number,
  command: string,
  timeoutMs: number,
): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let url: string | null = null;
    let connected = false;
    let settled = false;
    let lastLines: string[] = [];

    const finish = (error: TunnelError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve({ url: url!, child });
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new TunnelError(
            `The tunnel did not come up within ${Math.round(timeoutMs / 1000)} seconds. ` +
              `cloudflared said last: ${lastLines.join(' | ') || '(nothing)'}`,
          ),
        ),
      timeoutMs,
    );

    const read = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      lastLines = [...lastLines, ...text.split('\n').filter((line) => line.trim() !== '')].slice(
        -3,
      );
      url ??= ADDRESS.exec(text)?.[0] ?? null;
      connected ||= CONNECTED.test(text);
      if (url !== null && connected) finish(null);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);

    child.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new TunnelError(
          error.code === 'ENOENT'
            ? `--tunnel needs the program "${command}", which is not installed. ` +
                'On a Mac: brew install cloudflared. Elsewhere: see ' +
                'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
            : `The tunnel could not be started: ${error.message}`,
        ),
      ),
    );
    child.on('exit', (code) =>
      finish(
        new TunnelError(
          `cloudflared stopped before the tunnel was up (exit code ${code}). ` +
            `It said last: ${lastLines.join(' | ') || '(nothing)'}`,
        ),
      ),
    );
  });
}

/**
 * Opens the tunnel to a port of this machine and keeps it open: when
 * cloudflared stops, it is started again and the new address reported.
 */
export async function openTunnel(port: number, options: TunnelOptions): Promise<Tunnel> {
  const command = options.command ?? 'cloudflared';
  const startTimeoutMs = options.startTimeoutMs ?? 45_000;
  const reopenAfterMs = options.reopenAfterMs ?? 5_000;
  const answers = options.answers ?? answersOverHttp;

  let stopped = false;
  let child: ChildProcess | null = null;
  let current = '';
  let reopenTimer: NodeJS.Timeout | null = null;

  /** A new address takes a few seconds to be known everywhere. */
  const untilItAnswers = async (url: string) => {
    for (let tries = 0; tries < 12 && !stopped; tries += 1) {
      if (await answers(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    options.log.warn(
      { address: url },
      'Could not see from here whether the tunnel address answers yet; going on anyway',
    );
  };

  const open = async (): Promise<void> => {
    const started = await launch(port, command, startTimeoutMs);
    child = started.child;
    current = started.url;
    started.child.on('exit', () => {
      if (stopped || child !== started.child) return;
      child = null;
      options.log.warn({}, 'The tunnel has closed; opening a new one');
      reopen();
    });
    await untilItAnswers(started.url);
  };

  const reopen = () => {
    if (stopped) return;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      open().then(
        () => {
          if (stopped) return;
          options.log.info({ address: current }, 'The tunnel is open again, at a new address');
          options.onNewUrl(current);
        },
        (error: unknown) => {
          options.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'The tunnel could not be opened; trying again',
          );
          reopen();
        },
      );
    }, reopenAfterMs);
  };

  await open();
  return {
    get url() {
      return current;
    },
    stop() {
      stopped = true;
      if (reopenTimer) clearTimeout(reopenTimer);
      child?.kill();
      child = null;
    },
  };
}
