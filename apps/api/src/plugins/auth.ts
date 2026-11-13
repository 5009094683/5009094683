import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DomainError,
  can,
  forbidden,
  resolveSession,
  type Actor,
  type Permission,
  type SessionContext,
} from '@pms/domain';

export const SESSION_COOKIE = 'pms_session';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionContext | null;
    sessionToken: string | null;
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
