import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelError } from '../adapter';
import { imapFailure, imapMailbox } from './adapter';

/**
 * A mail server that knows one user and one folder, and answers the handful of commands a
 * read of the mailbox uses, the way a real one words its refusals.
 */
function standInMailServer(): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('* OK IMAP4rev1 ready\r\n');
    let signedIn = false;
    let pending = '';
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const [tag = '', command = '', ...rest] = line.split(' ');
        const args = rest.join(' ');
        switch (command.toUpperCase()) {
          case 'CAPABILITY':
            socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
            break;
          case 'LOGIN':
            signedIn = args.includes('right-password');
            socket.write(
              signedIn
                ? `${tag} OK signed in\r\n`
                : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`,
            );
            break;
          case 'EXAMINE':
          case 'SELECT':
            if (!signedIn) socket.write(`${tag} BAD not signed in\r\n`);
            else if (/INBOX/i.test(args)) {
              socket.write(
                `* 0 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 1] ok\r\n${tag} OK [READ-ONLY] done\r\n`,
              );
            } else socket.write(`${tag} NO [NONEXISTENT] Unknown Mailbox: ${args}\r\n`);
            break;
          case 'UID':
            socket.write(`* SEARCH\r\n${tag} OK done\r\n`);
            break;
          case 'LOGOUT':
            socket.write(`* BYE\r\n${tag} OK done\r\n`);
            socket.end();
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  });
}

describe('reading a mailbox', () => {
  let server: net.Server;
  let port: number;
  const position = { uidValidity: null, lastUid: 0 };
  const settings = (over: { password?: string; folder?: string; port?: number } = {}) => ({
    host: '127.0.0.1',
    port: over.port ?? port,
    secure: false,
    user: 'reservations@seabreeze.example',
    password: over.password ?? 'right-password',
    folder: over.folder ?? 'INBOX',
  });
  const failure = async (reading: Promise<unknown>): Promise<ChannelError> => {
    const err = await reading.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ChannelError);
    return err as ChannelError;
  };

  beforeAll(async () => {
    server = standInMailServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads an empty mailbox without complaint', async () => {
    expect(await imapMailbox(settings()).fetchAfter(position, 10)).toEqual({
      uidValidity: '7',
      messages: [],
    });
  });

  it('says that the sign-in was refused, and does not keep trying a wrong password', async () => {
    const err = await failure(
      imapMailbox(settings({ password: 'wrong' })).fetchAfter(position, 10),
    );
    expect(err.message).toBe(
      'The mail server at 127.0.0.1 refused the sign-in for reservations@seabreeze.example. Check the user name and the password.',
    );
    expect(err.retryable).toBe(false);
  });

  it('names the folder that cannot be opened, in the server’s own words', async () => {
    const err = await failure(
      imapMailbox(settings({ folder: 'Bookings' })).fetchAfter(position, 10),
    );
    expect(err.message).toMatch(
      /^The folder "Bookings" could not be opened in the mailbox of reservations@seabreeze\.example: .*Unknown Mailbox/,
    );
    expect(err.retryable).toBe(false);
  });

  it('says so when the server cannot be reached, and tries again', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const dead = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const err = await failure(imapMailbox(settings({ port: dead })).fetchAfter(position, 10));
    expect(err.message).toMatch(/^The mailbox at 127\.0\.0\.1 could not be reached: /);
    expect(err.retryable).toBe(true);
  });

  it('reads what the server said out of the library’s error', () => {
    expect(
      imapFailure(
        Object.assign(new Error('Command failed'), {
          authenticationFailed: true,
          responseText: 'Invalid credentials (Failure)',
        }),
      ),
    ).toEqual({ refused: true, detail: 'Invalid credentials (Failure)' });
    expect(imapFailure(new Error('connect ECONNREFUSED 10.0.0.1:993'))).toEqual({
      refused: false,
      detail: 'connect ECONNREFUSED 10.0.0.1:993',
    });
    expect(imapFailure('odd')).toEqual({ refused: false, detail: 'odd' });
  });
});
