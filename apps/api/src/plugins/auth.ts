import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  API_KEY_PREFIX,
  DomainError,
  can,
  forbidden,
  resolveApiKey,
  resolveSession,
  type Actor,
  type Permission,
  type ResolvedApiKey,
  type SessionContext,
} from '@pms/domain';

export const SESSION_COOKIE = 'pms_session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionContext | null;
    sessionToken: string | null;
    /** Set when the request came with an API key instead of a signed-in session. */
    apiKey: ResolvedApiKey | null;
  }
}

/**
 * Counts requests per API key in one-minute windows, in this process. With
 * several API servers each keeps its own count, so the limit is per server.
 */
class KeyLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly perMinute: number) {}

  /** Seconds until the key may call again, or 0 when the request is within the limit. */
  take(keyId: string, now: number = Date.now()): number {
    const window = this.windows.get(keyId);
    if (!window || now - window.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(keyId, { start: now, count: 1 });
      return 0;
    }
    window.count++;
    return window.count > this.perMinute ? Math.ceil((window.start + 60_000 - now) / 1000) : 0;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes called by other systems, authenticated by their own signatures rather than a cookie. */
function isMachineRoute(url: string): boolean {
  return url.startsWith('/webhooks/') || url.startsWith('/ical/') || url.startsWith('/public/');
}

export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('session', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('apiKey', null);
  const limiter = new KeyLimiter(app.env.API_KEY_RATE_LIMIT_PER_MINUTE);

  const allowedOrigins = new Set(
    [app.env.WEB_URL, app.env.BOOKING_URL, app.env.API_PUBLIC_URL].map((u) => new URL(u).origin),
  );

  app.addHook('onRequest', async (req) => {
    // A browser attaches its Origin to cross-site writes. Refusing foreign
    // origins stops another site from acting with a signed-in user's cookie,
    // on top of the SameSite cookie attribute.
    if (UNSAFE_METHODS.has(req.method) && !isMachineRoute(req.url)) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        throw forbidden('Cross-site requests are not allowed');
      }
    }

    // A key in the Authorization header is used instead of a session, never alongside one.
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (bearer?.startsWith(API_KEY_PREFIX) && !isMachineRoute(req.url)) {
      const key = await resolveApiKey(app.db, bearer);
      if (!key) {
        throw new DomainError('unauthenticated', 'This API key is not valid, or no longer valid');
      }
      const wait = limiter.take(key.id);
      if (wait > 0) {
        throw new DomainError(
          'rate_limited',
          `This API key has made too many requests. Try again in ${wait} seconds.`,
          { retryAfterSeconds: wait },
        );
      }
      req.apiKey = key;
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      req.sessionToken = token;
      req.session = await resolveSession(app.db, token);
    }
  });
}

export function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: app.env.isProduction,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The signed-in session, including ones still waiting for a second factor. */
export function anySession(req: FastifyRequest): SessionContext {
  if (!req.session) throw new DomainError('unauthenticated', 'Sign in to continue');
  return req.session;
}

/** A fully signed-in session: second factor done and, where required, enrolled. */
export function fullSession(req: FastifyRequest): SessionContext {
  const session = anySession(req);
  if (session.mfaPending) {
    throw new DomainError('unauthenticated', 'Enter your authenticator code to continue', {
      reason: 'mfa_required',
    });
  }
  if (session.mustEnrollTwoFactor) {
    throw new DomainError('forbidden', 'Set up two-factor authentication to continue', {
      reason: 'mfa_enrollment_required',
    });
  }
  return session;
}

export function actorFromSession(req: FastifyRequest, session: SessionContext): Actor {
  return {
    type: 'user',
    orgId: session.user.orgId,
    userId: session.user.id,
    label: session.user.email,
    grants: session.grants,
    ip: req.ip,
    requestId: req.id,
  };
}

/**
 * Authenticates the request and, when a permission is given, authorises it.
 * Pass the property the action touches whenever there is one, so property-
 * scoped roles are honoured.
 */
export function authorize(
  req: FastifyRequest,
  permission?: Permission,
  propertyId?: string | null,
): Actor {
  if (req.apiKey) {
    const key = req.apiKey;
    if (permission && !can(key.grants, permission, propertyId)) throw forbidden();
    return {
      type: 'api_key',
      orgId: key.orgId,
      label: `api-key:${key.name}`,
      grants: key.grants,
      ip: req.ip,
      requestId: req.id,
    };
  }
  const session = fullSession(req);
  if (permission && !can(session.grants, permission, propertyId)) throw forbidden();
  return actorFromSession(req, session);
}

export function clientInfo(req: FastifyRequest): {
  ip: string;
  userAgent?: string;
  requestId: string;
} {
  return { ip: req.ip, userAgent: req.headers['user-agent'], requestId: req.id };
}
