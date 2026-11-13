import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelError } from './adapter';
import { isPrivateAddress, safeFetch } from './net';

describe('isPrivateAddress', () => {
  it('recognises addresses that are not on the public internet', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      'not-an-address',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '172.32.0.1',
      '93.184.216.34',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/calendar') {
        res.writeHead(200, { 'content-type': 'text/calendar', etag: '"v1"' });
        res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
      } else if (req.url === '/moved') {
        res.writeHead(302, { location: '/calendar' });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/huge') {
        res.writeHead(200);
        res.end('x'.repeat(50_000));
      } else if (req.url === '/slow') {
        // Never answers.
      } else {
        res.writeHead(404);
        res.end('nope');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const refusal = async (promise: Promise<unknown>): Promise<ChannelError> => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ChannelError);
    return err as ChannelError;
  };

  it('fetches, follows redirects, and reports the final address', async () => {
    const direct = await safeFetch(`${base}/calendar`, { allowPrivate: true });
    expect(direct).toMatchObject({ status: 200, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    expect(direct.headers.etag).toBe('"v1"');
    const moved = await safeFetch(`${base}/moved`, { allowPrivate: true });
    expect(moved).toMatchObject({ status: 200, url: `${base}/calendar` });
    expect((await safeFetch(`${base}/missing`, { allowPrivate: true })).status).toBe(404);
  });

  it('reaches a host by its name, which is how every real calendar is addressed', async () => {
    // By name the connection asks where the host is, and is answered with the addresses
    // that were checked. `localhost` may be answered with ::1 first, where nothing listens
    // here: the next address is tried.
    const port = (server.address() as AddressInfo).port;
    const named = await safeFetch(`http://localhost:${port}/calendar`, { allowPrivate: true });
    expect(named).toMatchObject({ status: 200, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
    // A redirect that names the host is followed the same way.
    const moved = await safeFetch(`http://localhost:${port}/moved`, { allowPrivate: true });
    expect(moved).toMatchObject({ status: 200, url: `http://localhost:${port}/calendar` });
    // A name that stands for this machine is still refused when told to stay public.
    const err = await refusal(safeFetch('https://localhost/cal.ics', { allowPrivate: false }));
    expect(err.message).toBe('localhost is not a public address');
  });

  it('refuses addresses on this machine or a private network when told to stay public', async () => {
    for (const url of [
      `${base}/calendar`.replace('http:', 'https:'),
      'https://10.0.0.5/cal.ics',
      'https://[::1]/cal.ics',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      const err = await refusal(safeFetch(url, { allowPrivate: false }));
      expect(err.retryable, url).toBe(false);
      expect(err.message).toMatch(/not a public address/);
    }
  });

  it('refuses anything that is not https when told to stay public', async () => {
    const err = await refusal(safeFetch('http://example.com/cal.ics', { allowPrivate: false }));
    expect(err.message).toMatch(/Only https/);
    expect(
      (await refusal(safeFetch('file:///etc/passwd', { allowPrivate: true }))).message,
    ).toMatch(/Only https/);
    expect((await refusal(safeFetch('nonsense', { allowPrivate: true }))).message).toMatch(
      /not a valid web address/,
    );
    expect(
      (await refusal(safeFetch('https://user:pw@example.com/x', { allowPrivate: true }))).message,
    ).toMatch(/user name or password/);
  });

  it('gives up on endless redirects, oversized bodies and servers that do not answer', async () => {
    expect((await refusal(safeFetch(`${base}/loop`, { allowPrivate: true }))).message).toMatch(
      /Too many redirects/,
    );
    const huge = await refusal(safeFetch(`${base}/huge`, { allowPrivate: true, maxBytes: 1_000 }));
    expect(huge.message).toMatch(/larger than 1000 bytes/);
    expect(huge.retryable).toBe(true);
    const slow = await refusal(safeFetch(`${base}/slow`, { allowPrivate: true, timeoutMs: 150 }));
    expect(slow.message).toMatch(/did not answer in time/);
  });
});
