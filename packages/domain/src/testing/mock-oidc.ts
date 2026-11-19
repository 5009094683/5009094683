import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export interface MockOidcIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export interface MockOidcProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * Plays the part of the user at the identity provider: takes the
   * authorization URL the application redirected to, "signs in" as the given
   * identity, and returns the callback URL the browser would be sent to.
   */
  authorize(authorizationUrl: string, identity: MockOidcIdentity): string;
  /** Makes the next token response carry a wrong nonce (a replayed or forged token). */
  corruptNextNonce(): void;
  close(): Promise<void>;
}

interface PendingCode {
  identity: MockOidcIdentity;
  nonce: string | null;
  codeChallenge: string | null;
  redirectUri: string;
  clientId: string;
}

/**
 * A minimal OpenID Connect provider for tests and local development:
 * discovery, JWKS and the authorization-code token endpoint with PKCE.
 */
export async function startMockOidcProvider(): Promise<MockOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const clientId = 'pms-test-client';
  const clientSecret = 'pms-test-secret';
  const codes = new Map<string, PendingCode>();
  let corruptNonce = false;
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, { keys: [jwk] });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString());
          let id = body.get('client_id');
          let secret = body.get('client_secret');
          const basic = req.headers.authorization?.match(/^Basic (.+)$/)?.[1];
          if (basic) {
            const [u, p] = Buffer.from(basic, 'base64').toString().split(':');
            id = decodeURIComponent(u ?? '');
            secret = decodeURIComponent(p ?? '');
          }
          const pending = codes.get(body.get('code') ?? '');
          if (id !== clientId || secret !== clientSecret)
            return json(401, { error: 'invalid_client' });
          if (!pending || pending.redirectUri !== body.get('redirect_uri')) {
            return json(400, { error: 'invalid_grant' });
          }
          codes.delete(body.get('code') ?? '');
          if (pending.codeChallenge) {
            const verifier = body.get('code_verifier') ?? '';
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            if (challenge !== pending.codeChallenge) return json(400, { error: 'invalid_grant' });
          }
          const nonce = corruptNonce ? 'forged-nonce' : pending.nonce;
          corruptNonce = false;
          const idToken = await new SignJWT({ ...pending.identity, ...(nonce ? { nonce } : {}) })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer(issuer)
            .setAudience(clientId)
            .setSubject(pending.identity.sub)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);
          json(200, {
            access_token: randomBytes(16).toString('hex'),
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          });
        })();
      });
      return;
    }
    json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    authorize(authorizationUrl, identity) {
      const url = new URL(authorizationUrl);
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!redirectUri) throw new Error('authorization URL has no redirect_uri');
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        identity,
        nonce: url.searchParams.get('nonce'),
        codeChallenge: url.searchParams.get('code_challenge'),
        redirectUri,
        clientId: url.searchParams.get('client_id') ?? '',
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = url.searchParams.get('state');
      if (state) callback.searchParams.set('state', state);
      return callback.toString();
    },
    corruptNextNonce() {
      corruptNonce = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
