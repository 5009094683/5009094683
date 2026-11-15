import { describe, expect, it } from 'vitest';
import { FakeFacebook } from '../../test/fake-facebook';
import {
  Graph,
  GraphError,
  explainGraphError,
  isOutsideWindow,
  isTokenRejected,
  isWorthRepeating,
} from './graph';

function setUp() {
  const facebook = new FakeFacebook();
  const graph = new Graph({
    appId: facebook.appId,
    appSecret: facebook.appSecret,
    version: facebook.version,
    fetch: facebook.fetch,
  });
  return { facebook, graph };
}

describe('calls to Facebook', () => {
  it('sends the token in the header and never in the address', async () => {
    const { facebook, graph } = setUp();
    const me = await graph.get<{ id: string; name: string }>('me', facebook.pageToken, {
      fields: 'id,name',
    });
    expect(me).toEqual({ id: facebook.page.id, name: 'Cao Bằng Travel Guide' });

    const request = facebook.requests[0]!;
    expect(request.token).toBe(facebook.pageToken);
    expect(request.url).toContain(`/${facebook.version}/me?fields=id%2Cname`);
    expect(request.url).not.toContain(facebook.pageToken);
    expect(request.url).not.toContain(facebook.appSecret);
  });

  it('proves with the app secret that calls for the Page are its own', async () => {
    const { facebook, graph } = setUp();
    // The stand-in refuses calls without the proof, as Facebook does where it is required.
    await graph.get('me', facebook.pageToken);
    expect(facebook.requests[0]!.query.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);

    // Calls made as the app itself carry the secret already.
    await graph.get(`${facebook.appId}/subscriptions`, graph.appToken);
    expect(facebook.requests[1]!.query.appsecret_proof).toBeUndefined();
    expect(facebook.requests[1]!.url).not.toContain(facebook.appSecret);
  });

  it('posts messages as JSON and settings as form fields', async () => {
    const { facebook, graph } = setUp();
    await graph.post(`${facebook.page.id}/messages`, facebook.pageToken, {
      recipient: { id: '42' },
      messaging_type: 'RESPONSE',
      message: { text: 'Xin chào' },
    });
    expect(facebook.sent[0]).toMatchObject({ to: '42', text: 'Xin chào' });

    await graph.postForm(`${facebook.page.id}/subscribed_apps`, facebook.pageToken, {
      subscribed_fields: 'messages,message_echoes',
    });
    expect(facebook.subscribedApps[0]!.subscribed_fields).toEqual(['messages', 'message_echoes']);
  });

  it('reads Facebook\u2019s errors, with their numbers', async () => {
    const { facebook, graph } = setUp();
    facebook.outsideWindow.add('42');
    const failure = await graph
      .post(`${facebook.page.id}/messages`, facebook.pageToken, {
        recipient: { id: '42' },
        messaging_type: 'RESPONSE',
        message: { text: 'hello' },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GraphError);
    expect(failure).toMatchObject({ status: 400, code: 10, subcode: 2018278, reached: true });
    expect(isOutsideWindow(failure)).toBe(true);
    expect(isWorthRepeating(failure)).toBe(false);
  });

  it('tells an unreachable Facebook from a refusal', async () => {
    const { facebook, graph } = setUp();
    facebook.failing('GET', /^me$/, null);
    const failure = await graph.get('me', facebook.pageToken).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 0, reached: false });
    expect(explainGraphError(failure)).toBe('Facebook could not be reached (ENOTFOUND).');
    // Not answered: the request may have arrived, so it is not sent again by itself.
    expect(isWorthRepeating(failure)).toBe(false);

    facebook.failing(
      'GET',
      /^me$/,
      { message: 'Please retry', code: 2, is_transient: true },
      1,
      500,
    );
    const temporary = await graph.get('me', facebook.pageToken).catch((error: unknown) => error);
    expect(isWorthRepeating(temporary)).toBe(true);
  });

  it('gives up on a Facebook that does not answer', async () => {
    const graph = new Graph({
      appId: '1',
      appSecret: 's',
      version: 'v27.0',
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    });
    const failure = await graph.get('me', 'token').catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 0 });
    expect(explainGraphError(failure)).toBe(
      'Facebook could not be reached (no answer within 0 seconds).',
    );
  });

  it('never repeats a token or the secret in what it throws', async () => {
    const { facebook, graph } = setUp();
    facebook.token.valid = false;
    const failure = (await graph
      .get('me', facebook.pageToken)
      .catch((error: unknown) => error)) as GraphError;
    const said = `${failure.message} ${explainGraphError(failure)} ${JSON.stringify(failure)}`;
    expect(said).not.toContain(facebook.pageToken);
    expect(said).not.toContain(facebook.appSecret);
    expect(isTokenRejected(failure)).toBe(true);
  });
});

describe('looking a token up', () => {
  it('says whose it is, what it may do and when it ends', async () => {
    const { facebook, graph } = setUp();
    expect(await graph.lookUpToken(facebook.pageToken)).toEqual({
      valid: true,
      problem: null,
      kind: 'page',
      appId: facebook.appId,
      ownerId: facebook.page.id,
      expiresAt: null,
      dataAccessExpiresAt: null,
      permissions: facebook.token.scopes,
    });

    facebook.token.expiresAt = 1_800_000_000;
    facebook.token.type = 'USER';
    expect(await graph.lookUpToken(facebook.pageToken)).toMatchObject({
      kind: 'person',
      expiresAt: 1_800_000_000_000,
    });
  });

  it('reports a token Facebook no longer accepts as not valid, not as a failure', async () => {
    const { facebook, graph } = setUp();
    facebook.token.valid = false;
    expect(await graph.lookUpToken(facebook.pageToken)).toMatchObject({
      valid: false,
      problem: 'Error validating access token: Session has expired.',
    });
  });

  it('extends the token of a person', async () => {
    const { facebook, graph } = setUp();
    expect(await graph.extendToken(facebook.personToken)).toBe(`long-${facebook.personToken}`);
  });
});

describe('the signature on what Facebook sends', () => {
  it('is made over the bytes as sent, with the app secret', () => {
    const { facebook, graph } = setUp();
    const bytes = FakeFacebook.bytes(facebook.customerWrites('42', 'Cho mình hỏi giá thuê xe'));
    // Facebook writes every character outside ASCII as an escape before signing.
    expect(bytes).toContain('Cho m\\u00ecnh h\\u1ecfi gi\\u00e1 thu\\u00ea xe');
    expect(graph.signatureOf(Buffer.from(bytes))).toBe(facebook.sign(bytes));
    expect(graph.signatureOf(Buffer.from(bytes))).not.toBe(facebook.sign(bytes, 'another-secret'));
  });

  it('derives the word for checking the address from the secret, the same every time', () => {
    const { graph } = setUp();
    expect(graph.derivedVerifyToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.derivedVerifyToken()).toBe(setUp().graph.derivedVerifyToken());
  });
});

describe('errors in plain words', () => {
  const error = (code: number, subcode: number | null = null, message = 'Facebook said no') =>
    new GraphError(message, 400, code, subcode);

  it('says what to do about each of the usual ones', () => {
    expect(explainGraphError(error(190))).toMatch(/no longer accepts the Page\u2019s access token/);
    expect(explainGraphError(error(190), 'app')).toMatch(/FB_APP_ID and FB_APP_SECRET/);
    expect(explainGraphError(error(10, 2018278))).toMatch(/within 24 hours of their last message/);
    expect(explainGraphError(error(10, 2534022))).toMatch(/within 24 hours/);
    expect(explainGraphError(error(551, 1545041))).toMatch(/cannot receive messages/);
    expect(explainGraphError(error(200, 1545041))).toMatch(/cannot receive messages/);
    expect(explainGraphError(error(10, 2018108))).toMatch(/cannot receive messages/);
    expect(explainGraphError(error(10, 1893063))).toMatch(/restricted the Page/);
    expect(explainGraphError(error(10, 2018300))).toMatch(/Another app has this chat/);
    expect(explainGraphError(error(100, 2534037))).toMatch(/Another app has this chat/);
    expect(explainGraphError(error(2018321))).toMatch(/automatic questions and answers/);
    expect(explainGraphError(error(100, 2018001))).toMatch(/knows nobody with this id/);
    expect(explainGraphError(error(613, 2534040))).toMatch(/too many were sent/);
    expect(explainGraphError(error(4))).toMatch(/too many were sent/);
    expect(explainGraphError(error(2))).toMatch(/problem of its own/);
  });

  it('explains why only people with a role on the app get an answer', () => {
    const text =
      '(#200) Cannot message users who are not admins, developers or testers of the app until pages_messaging permission is reviewed and the app is live.';
    for (const failure of [error(200, 2018028, text), error(200, null, text)]) {
      expect(explainGraphError(failure)).toMatch(/only to people who have a role on it/);
      expect(explainGraphError(failure)).toMatch(/Opening the assistant to all customers/);
    }
  });

  it('quotes Facebook where it has no words of its own', () => {
    expect(explainGraphError(error(10, null, '(#10) Application does not have permission'))).toBe(
      'Facebook refused for lack of permission: \u201c(#10) Application does not have permission\u201d. ' +
        'The access token needs the permissions pages_messaging and pages_manage_metadata, given ' +
        'by someone who manages the Page.',
    );
    expect(explainGraphError(error(100, 2018109, 'Attachment size exceeds allowable limit'))).toBe(
      'Facebook refused: \u201cAttachment size exceeds allowable limit\u201d (error 100/2018109).',
    );
    expect(explainGraphError(new Error('plain'))).toBe('plain');
  });
});
