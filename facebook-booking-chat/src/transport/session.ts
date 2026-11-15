import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
  The session file is the login to the company's Facebook account, as the
  cookies of a browser that is signed in. Whoever holds it is signed in as the
  company. It is never logged, never sent anywhere but to Facebook, and kept
  readable by the owner of the file only.
*/

export interface SessionCookie {
  key: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface Session {
  cookies: SessionCookie[];
  /** The personal profile that is signed in. */
  userId: string;
  /** The Page the browser was switched into when the cookies were exported, if any. */
  pageId: string | null;
}

export class SessionError extends Error {}

const HOW_TO =
  'Sign in to Facebook in a browser, switch into the Page, export the cookies of facebook.com ' +
  'as JSON and save them as this file. The README describes it step by step.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the cookies however they were exported: a list of cookies with
 * "name" or "key" (Cookie-Editor, EditThisCookie, c3c-fbstate), an object
 * with a "cookies" list (Playwright), or a "name=value; name=value" line.
 */
export function parseSession(raw: string): Session {
  const text = raw.trim();
  if (text === '') throw new SessionError(`The session file is empty. ${HOW_TO}`);

  let entries: unknown[];
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionError(`The session file is not valid JSON. ${HOW_TO}`);
    }
    const list = isRecord(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : parsed;
    if (!Array.isArray(list)) {
      throw new SessionError(`The session file holds no list of cookies. ${HOW_TO}`);
    }
    entries = list;
  } else {
    entries = text.split(';').map((pair) => {
      const at = pair.indexOf('=');
      return at === -1 ? null : { key: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim() };
    });
  }

  const cookies: SessionCookie[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === 'string' ? entry.key : entry.name;
    const value = entry.value;
    if (typeof key !== 'string' || key === '' || typeof value !== 'string') continue;
    const domain = typeof entry.domain === 'string' ? entry.domain : undefined;
    // An export of every cookie in the browser: keep Facebook's only.
    if (domain !== undefined && !/(^|\.)facebook\.com$/i.test(domain)) continue;
    if (cookies.some((cookie) => cookie.key === key)) continue;
    const path = typeof entry.path === 'string' ? entry.path : undefined;
    cookies.push({ key, value, domain, path });
  }

  const find = (key: string) => cookies.find((cookie) => cookie.key === key)?.value;
  const userId = find('c_user');
  if (!userId || !find('xs')) {
    throw new SessionError(
      'The session file lacks the cookies "c_user" and "xs": it was exported from a browser ' +
        `that is not signed in to Facebook, or from another site. ${HOW_TO}`,
    );
  }
  return { cookies, userId, pageId: find('i_user') ?? null };
}

export function loadSession(file: string): Session {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new SessionError(`There is no session file at ${path}. ${HOW_TO}`);
  }
  return parseSession(readFileSync(path, 'utf8'));
}

/**
 * Writes the cookies as Facebook has renewed them since the file was read, so
 * that the next start begins from the newest. Written whole or not at all.
 */
export function saveSession(file: string, cookies: SessionCookie[]): void {
  const keys = new Set(cookies.map((cookie) => cookie.key));
  if (!keys.has('c_user') || !keys.has('xs')) return; // Signed out: keep the file as it is.
  const path = resolve(file);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cookies, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // File systems without permissions (some Windows drives) keep what they have.
  }
}

/** Who the session signs in as, for the log and the status page. Never the cookie values. */
export function describeSession(session: Session): string {
  return session.pageId
    ? `Page ${session.pageId} (through the profile ${session.userId})`
    : `personal profile ${session.userId}`;
}
