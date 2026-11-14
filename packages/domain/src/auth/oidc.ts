import { and, eq } from 'drizzle-orm';
import * as oidc from 'openid-client';
import { getEnv } from '@pms/config';
import {
  oidcProviders,
  roleAssignments,
  userIdentities,
  users,
  ROLES,
  type Database,
  type Role,
} from '@pms/db';
import { writeAudit } from '../audit';
import type { Actor } from '../context';
import { decryptSecret, encryptSecret } from '../crypto';
import { DomainError, conflict, forbidden, notFound, validationError } from '../errors';
import { createSession, type ClientInfo } from './service';

/** Carried in an encrypted cookie between the redirect to the provider and the callback. */
export interface OidcFlowState {
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo?: string;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;

type ProviderRow = typeof oidcProviders.$inferSelect;

const discoveryCache = new Map<string, { key: string; config: oidc.Configuration; at: number }>();

async function configurationFor(provider: ProviderRow): Promise<oidc.Configuration> {
  const cacheKey = `${provider.issuer}|${provider.clientId}|${provider.updatedAt.getTime()}`;
  const cached = discoveryCache.get(provider.id);
  if (cached && cached.key === cacheKey && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.config;
  }
  const issuer = new URL(provider.issuer);
  const secret = provider.clientSecretEnc ? decryptSecret(provider.clientSecretEnc) : undefined;
  // Plain-HTTP issuers exist only for local development and tests.
  const allowHttp = issuer.protocol === 'http:' && !getEnv().isProduction;
  let config: oidc.Configuration;
  try {
    config = await oidc.discovery(
      issuer,
      provider.clientId,
      secret,
      secret ? undefined : oidc.None(),
      allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
  } catch (err) {
    throw new DomainError(
      'upstream_failed',
      `Could not reach the single sign-on provider "${provider.name}": ${(err as Error).message}`,
    );
  }
  discoveryCache.set(provider.id, { key: cacheKey, config, at: Date.now() });
  return config;
}

export function oidcRedirectUri(slug: string): string {
  return `${getEnv().API_PUBLIC_URL.replace(/\/$/, '')}/auth/oidc/${encodeURIComponent(slug)}/callback`;
}

export async function startOidcLogin(
  db: Database,
  slug: string,
  returnTo?: string,
): Promise<{ url: string; flow: OidcFlowState }> {
  const [provider] = await db
    .select()
    .from(oidcProviders)
    .where(and(eq(oidcProviders.slug, slug), eq(oidcProviders.enabled, true)))
    .limit(1);
  if (!provider) throw notFound('Single sign-on provider', slug);
  const config = await configurationFor(provider);

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const flow: OidcFlowState = {
    providerId: provider.id,
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    codeVerifier,
    redirectUri: oidcRedirectUri(slug),
    returnTo,
    createdAt: Date.now(),
  };
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: flow.redirectUri,
    scope: provider.scopes,
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { url: url.toString(), flow };
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

export async function finishOidcLogin(
  db: Database,
  flow: OidcFlowState,
  callbackUrl: URL,
  client: ClientInfo = {},
): Promise<{ token: string; expiresAt: Date; returnTo?: string }> {
  if (Date.now() - flow.createdAt > FLOW_TTL_MS) {
    throw new DomainError('unauthenticated', 'The sign-in attempt expired. Start again.');
  }
  const [provider] = await db
    .select()
    .from(oidcProviders)
    .where(and(eq(oidcProviders.id, flow.providerId), eq(oidcProviders.enabled, true)))
    .limit(1);
  if (!provider) throw notFound('Single sign-on provider');
  const config = await configurationFor(provider);

  let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
  try {
    tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    throw new DomainError('unauthenticated', `Single sign-on failed: ${(err as Error).message}`);
  }
  const claims = tokens.claims();
  if (!claims)
    throw new DomainError('unauthenticated', 'The provider did not return an identity token');

  let email = typeof claims.email === 'string' ? claims.email : undefined;
  let emailVerified = claims.email_verified;
  let name = typeof claims.name === 'string' ? claims.name : undefined;
  if (!email && tokens.access_token) {
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    email = typeof info.email === 'string' ? info.email : undefined;
    emailVerified = info.email_verified;
    name ??= typeof info.name === 'string' ? info.name : undefined;
  }
  if (!email)
    throw new DomainError('unauthenticated', 'The provider did not share an email address');
  if (emailVerified === false) {
    throw new DomainError(
      'unauthenticated',
      'Your email address is not verified with the provider',
    );
  }
  email = email.trim().toLowerCase();
  if (!provider.allowedEmailDomains.map((d) => d.toLowerCase()).includes(emailDomain(email))) {
    throw forbidden('Your email domain is not allowed to sign in through this provider');
  }

  return db.transaction(async (tx) => {
    const [identity] = await tx
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(
        and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.sub)),
      )
      .limit(1);

    let userId = identity?.userId;
    if (!userId) {
      const [byEmail] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (byEmail) {
        if (byEmail.orgId !== provider.orgId) throw forbidden();
        userId = byEmail.id;
      } else {
        if (!provider.autoProvision) {
          throw forbidden('No account exists for this email. Ask an administrator for access.');
        }
        const [created] = await tx
          .insert(users)
          .values({ orgId: provider.orgId, email, name: name ?? email, status: 'active' })
          .returning();
        userId = created!.id;
        if (provider.defaultRole) {
          await tx
            .insert(roleAssignments)
            .values({ userId, role: provider.defaultRole, propertyId: null });
        }
      }
      await tx
        .insert(userIdentities)
        .values({ userId, providerId: provider.id, subject: claims.sub, email });
    }

    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.status === 'disabled') throw forbidden('This account is disabled');
    await tx
      .update(users)
      .set({ status: 'active', lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));

    const session = await createSession(tx, user.id, {
      authMethod: 'oidc',
      mfaPending: false,
      ...client,
    });
    await writeAudit(
      tx,
      {
        type: 'user',
        orgId: user.orgId,
        userId: user.id,
        label: user.email,
        grants: [],
        ip: client.ip,
        requestId: client.requestId,
      },
      {
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        summary: `Signed in through ${provider.name}`,
      },
    );
    return { token: session.token, expiresAt: session.expiresAt, returnTo: flow.returnTo };
  });
}

// ---------------------------------------------------------------------------
// Provider administration

export interface OidcProviderInput {
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  /** Omit on update to keep the stored secret; pass null to remove it (public client with PKCE). */
  clientSecret?: string | null;
  scopes?: string;
  allowedEmailDomains: string[];
  autoProvision?: boolean;
  defaultRole?: Role | null;
  enabled?: boolean;
}

function validateProviderInput(input: OidcProviderInput): void {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(input.slug)) {
    throw validationError('Slug must be lowercase letters, digits and dashes');
  }
  let issuer: URL;
  try {
    issuer = new URL(input.issuer);
  } catch {
    throw validationError('Issuer must be a URL');
  }
  if (issuer.protocol !== 'https:' && getEnv().isProduction) {
    throw validationError('Issuer must use https');
  }
  if (!input.clientId.trim()) throw validationError('Client ID is required');
  if (input.defaultRole && !ROLES.includes(input.defaultRole))
    throw validationError('Unknown default role');
  if (input.defaultRole === 'org_admin') {
    throw validationError(
      'New single sign-on users cannot be made organisation admins automatically',
    );
  }
  for (const domain of input.allowedEmailDomains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
      throw validationError(`"${domain}" is not a valid email domain`);
  }
  if (!(input.scopes ?? 'openid').split(/\s+/).includes('openid')) {
    throw validationError('Scopes must include "openid"');
  }
}

export interface OidcProviderView {
  id: string;
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  allowedEmailDomains: string[];
  autoProvision: boolean;
  defaultRole: Role | null;
  enabled: boolean;
  redirectUri: string;
}

function toView(row: ProviderRow): OidcProviderView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    issuer: row.issuer,
    clientId: row.clientId,
    hasClientSecret: row.clientSecretEnc !== null,
    scopes: row.scopes,
    allowedEmailDomains: row.allowedEmailDomains,
    autoProvision: row.autoProvision,
    defaultRole: row.defaultRole,
    enabled: row.enabled,
    redirectUri: oidcRedirectUri(row.slug),
  };
}

export async function listOidcProviders(db: Database, orgId: string): Promise<OidcProviderView[]> {
  const rows = await db
    .select()
    .from(oidcProviders)
    .where(eq(oidcProviders.orgId, orgId))
    .orderBy(oidcProviders.name);
  return rows.map(toView);
}

/** What the sign-in page needs: which buttons to show. No configuration details. */
export async function listPublicOidcProviders(
  db: Database,
): Promise<{ slug: string; name: string }[]> {
  return db
    .select({ slug: oidcProviders.slug, name: oidcProviders.name })
    .from(oidcProviders)
    .where(eq(oidcProviders.enabled, true))
    .orderBy(oidcProviders.name);
}

export async function saveOidcProvider(
  db: Database,
  actor: Actor,
  input: OidcProviderInput,
  existingId?: string,
): Promise<OidcProviderView> {
  validateProviderInput(input);
  const values = {
    slug: input.slug,
    name: input.name.trim(),
    issuer: input.issuer.trim().replace(/\/$/, ''),
    clientId: input.clientId.trim(),
    scopes: input.scopes?.trim() || 'openid email profile',
    allowedEmailDomains: input.allowedEmailDomains.map((d) => d.toLowerCase()),
    autoProvision: input.autoProvision ?? false,
    defaultRole: input.defaultRole ?? null,
    enabled: input.enabled ?? true,
  };
  return db.transaction(async (tx) => {
    const [clash] = await tx
      .select({ id: oidcProviders.id })
      .from(oidcProviders)
      .where(eq(oidcProviders.slug, input.slug))
      .limit(1);
    if (clash && clash.id !== existingId) throw conflict('Another provider already uses this slug');

    let row: ProviderRow | undefined;
    if (existingId) {
      const secretUpdate =
        input.clientSecret === undefined
          ? {}
          : {
              clientSecretEnc:
                input.clientSecret === null ? null : encryptSecret(input.clientSecret),
            };
      [row] = await tx
        .update(oidcProviders)
        .set({ ...values, ...secretUpdate })
        .where(and(eq(oidcProviders.id, existingId), eq(oidcProviders.orgId, actor.orgId)))
        .returning();
      if (!row) throw notFound('Single sign-on provider', existingId);
    } else {
      [row] = await tx
        .insert(oidcProviders)
        .values({
          ...values,
          orgId: actor.orgId,
          clientSecretEnc: input.clientSecret ? encryptSecret(input.clientSecret) : null,
        })
        .returning();
    }
    discoveryCache.delete(row!.id);
    await writeAudit(tx, actor, {
      action: existingId ? 'sso.provider_updated' : 'sso.provider_created',
      entityType: 'oidc_provider',
      entityId: row!.id,
      summary: `${existingId ? 'Updated' : 'Added'} single sign-on provider ${row!.name}`,
      changes: { ...values, clientSecretChanged: input.clientSecret !== undefined },
    });
    return toView(row!);
  });
}

export async function deleteOidcProvider(db: Database, actor: Actor, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(oidcProviders)
      .where(and(eq(oidcProviders.id, id), eq(oidcProviders.orgId, actor.orgId)))
      .returning();
    if (!row) throw notFound('Single sign-on provider', id);
    discoveryCache.delete(id);
    await writeAudit(tx, actor, {
      action: 'sso.provider_deleted',
      entityType: 'oidc_provider',
      entityId: id,
      summary: `Removed single sign-on provider ${row.name}`,
    });
  });
}
