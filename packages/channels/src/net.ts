import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { ChannelError } from './adapter';

export interface SafeFetchOptions {
  /**
   * Allow addresses on this machine and on private networks. Off in
   * production: the addresses fetched here are typed in by users, and must
   * not be a way to reach internal services.
   */
  allowPrivate: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Largest response body accepted. */
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The address the content finally came from, after redirects. */
  url: string;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
];

/** True for addresses that are not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4 written inside IPv6.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    // Unique local fc00::/7, link local fe80::/10, multicast ff00::/8.
    return /^(f[cd]|fe[89ab]|ff)/.test(lower);
  }
  return true;
}

async function resolvePublic(
  hostname: string,
  allowPrivate: boolean,
): Promise<{ address: string; family: number }> {
  const literal = isIP(hostname);
  const candidates = literal
    ? [{ address: hostname, family: literal }]
    : await dnsLookup(hostname, { all: true, verbatim: true });
  if (candidates.length === 0) throw new Error(`${hostname} does not resolve`);
  if (!allowPrivate && candidates.some((c) => isPrivateAddress(c.address))) {
    throw new ChannelError(`${hostname} is not a public address`, { retryable: false });
  }
  return candidates[0]!;
}

function once(
  url: URL,
  pinned: { address: string; family: number },
  options: SafeFetchOptions,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
      request.destroy();
    };
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'PMS-calendar-sync/1.0', accept: '*/*', ...options.headers },
        timeout: options.timeoutMs ?? 15_000,
        // Connect to the address that was checked, so a second DNS answer cannot redirect the request.
        lookup: (_host, _opts, callback) => {
          (callback as (err: Error | null, address: string, family: number) => void)(
            null,
            pinned.address,
            pinned.family,
          );
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) fail(new Error(`The response is larger than ${maxBytes} bytes`));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', fail);
      },
    );
    request.on('timeout', () => fail(new Error('The server did not answer in time')));
    request.on('error', fail);
    request.end();
  });
}

/**
 * Fetches an address a user supplied (a calendar feed), with the precautions
 * that calls for: https only, public addresses only, every redirect checked
 * the same way, and limits on time and size.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ChannelError('That is not a valid web address', { retryable: false });
  }
  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    if (url.protocol !== 'https:' && !(options.allowPrivate && url.protocol === 'http:')) {
      throw new ChannelError('Only https addresses can be read', { retryable: false });
    }
    if (url.username || url.password) {
      throw new ChannelError('Addresses with a user name or password are not accepted', {
        retryable: false,
      });
    }
    let response: Awaited<ReturnType<typeof once>>;
    try {
      // An IPv6 address is written in brackets in a URL.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const pinned = await resolvePublic(host, options.allowPrivate);
      response = await once(url, pinned, options);
    } catch (err) {
      if (err instanceof ChannelError) throw err;
      throw new ChannelError(`${url.hostname}: ${(err as Error).message}`, {
        retryable: true,
        cause: err,
      });
    }
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    return { status: response.status, headers, body: response.body, url: url.toString() };
  }
  throw new ChannelError('Too many redirects', { retryable: false });
}
