import type { MailboxSaved, MailboxSettings } from './types';

/** How a mailbox is read, while it is being edited. Text is kept as typed and tidied when saved. */
export interface DraftMailbox {
  host: string;
  port: string;
  user: string;
  folder: string;
  recipient: string;
  trustUnverifiedSenders: boolean;
  /** A password to store. Null keeps the stored one, which is never sent back to be shown. */
  password: string | null;
}

export type MailboxField = 'host' | 'port' | 'user' | 'password' | 'folder' | 'recipient';
export type MailboxErrors = Partial<Record<MailboxField, string>>;

/** What the server uses where the port and the folder are left empty. */
export const DEFAULT_PORT = 993;
export const DEFAULT_FOLDER = 'INBOX';

export function draftOf(settings: MailboxSettings): DraftMailbox {
  return {
    host: settings.host ?? '',
    port: settings.port === null ? '' : String(settings.port),
    user: settings.user ?? '',
    folder: settings.folder ?? '',
    recipient: settings.recipient ?? '',
    trustUnverifiedSenders: settings.trustUnverifiedSenders,
    password: null,
  };
}

function tidy(draft: DraftMailbox): DraftMailbox {
  return {
    ...draft,
    host: draft.host.trim(),
    port: draft.port.trim(),
    user: draft.user.trim(),
    folder: draft.folder.trim(),
    recipient: draft.recipient.trim().toLowerCase(),
  };
}

/** Whether saving the one would leave what the other holds. */
export function sameMailbox(a: DraftMailbox, b: DraftMailbox): boolean {
  const [x, y] = [tidy(a), tidy(b)];
  return (
    x.host === y.host &&
    x.port === y.port &&
    x.user === y.user &&
    x.folder === y.folder &&
    x.recipient === y.recipient &&
    x.trustUnverifiedSenders === y.trustUnverifiedSenders &&
    // An empty box for a new password changes nothing: the stored one stays.
    (x.password || null) === (y.password || null)
  );
}

/**
 * What the server takes for an email address. It answers anything else with the name of the
 * field and a rule, so the same is checked here, where it can be said in a sentence.
 */
const EMAIL_ADDRESS =
  /^(?:[a-z0-9_'+-]+\.)*[a-z0-9_'+-]*[a-z0-9_+-]@(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/i;

/** Whether the mail server, the user name or the password is given, so that all three are needed. */
function mailboxEntered(draft: DraftMailbox): boolean {
  return Boolean(draft.host || draft.user || draft.password);
}

/**
 * What is wrong with what was typed, in the words of the screen. The server checks the same
 * things, but answers some of them with the name of the field and a rule rather than a sentence.
 */
export function mailboxErrors(draft: DraftMailbox, hasPassword: boolean): MailboxErrors {
  const { host, port, user, folder, recipient, password } = tidy(draft);
  const errors: MailboxErrors = {};
  const entered = mailboxEntered(tidy(draft));

  if (host && !/^[a-z0-9.-]+$/i.test(host)) {
    errors.host =
      'Enter only the name of the mail server, such as imap.example.com: no https:// and no spaces.';
  } else if (host.length > 200) {
    errors.host = 'Use at most 200 characters.';
  } else if (entered && !host) {
    errors.host = 'Enter the mail server.';
  }

  if (port) {
    const number = Number(port);
    if (!/^\d+$/.test(port) || number < 1 || number > 65535) {
      errors.port = 'Enter a number from 1 to 65535.';
    }
  }

  if (user.length > 200) errors.user = 'Use at most 200 characters.';
  else if (entered && !user) errors.user = 'Enter the user name.';

  if (password !== null && password.length > 500) {
    errors.password = 'Use at most 500 characters.';
  } else if (entered && !password && !hasPassword) {
    errors.password = 'Enter the password.';
  }

  if (folder.length > 200) errors.folder = 'Use at most 200 characters.';

  if (recipient && !EMAIL_ADDRESS.test(recipient)) {
    errors.recipient = 'Enter one email address, such as bookings@example.com.';
  }
  return errors;
}

/** Whether, once saved, there is a mailbox to read: a server, a user name and a password. */
export function readable(draft: DraftMailbox, hasPassword: boolean): boolean {
  const { host, user, password } = tidy(draft);
  return Boolean(host && user && (password || hasPassword));
}

/** Whether saving takes the saved mailbox away and puts none in its place. */
export function removesMailbox(draft: DraftMailbox, saved: DraftMailbox): boolean {
  const [now, before] = [tidy(draft), tidy(saved)];
  return Boolean(before.host && before.user) && !now.host && !now.user;
}

/** Whether saving reads another mailbox than the saved one, so that reading starts afresh. */
export function anotherMailbox(draft: DraftMailbox, saved: DraftMailbox): boolean {
  const [now, before] = [tidy(draft), tidy(saved)];
  return (
    Boolean(before.host && before.user) &&
    !removesMailbox(draft, saved) &&
    (now.host !== before.host || now.user !== before.user)
  );
}

/** The settings as the server takes them. A password is sent only when a new one was typed. */
export function toInput(draft: DraftMailbox): MailboxSaved {
  const { host, port, user, folder, recipient, trustUnverifiedSenders, password } = tidy(draft);
  return {
    host: host || null,
    port: port ? Number(port) : null,
    user: user || null,
    folder: folder || null,
    recipient: recipient || null,
    trustUnverifiedSenders,
    ...(password ? { password } : {}),
  };
}
