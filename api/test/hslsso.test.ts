// The HackSpaceLabs client (src/hslsso.ts) against a stand-in Keycloak: lazy discovery, the internal-URL
// rule, sign-in, refresh outcomes, sign-out address and sealed tokens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { HslSso, knownRoles, newFlow, openTokens, sealTokens, SsoError } from '../src/hslsso.js';
import { json, makeKey, now, serve, signJwt } from './helpers.js';

const key = makeKey('kc1');
let kc: Awaited<ReturnType<typeof serve>>;
let issuer = '';
let tokenReply: (form: URLSearchParams) => [number, unknown];
let discoveryUp = true;

before(async () => {
  kc = await serve((req, body, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/realms/hsl/.well-known/openid-configuration') {
      if (!discoveryUp) return json(res, 503, {});
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        code_challenge_methods_supported: ['plain', 'S256'],
      });
    }
    if (path === '/realms/hsl/protocol/openid-connect/certs') return json(res, 200, { keys: [key.jwk] });
    if (path === '/realms/hsl/protocol/openid-connect/token') {
      const [status, b] = tokenReply(new URLSearchParams(body));
      return json(res, status, b);
    }
    json(res, 404, {});
  });
  issuer = `${kc.url}/realms/hsl`;
});
after(() => kc.close());
beforeEach(() => { discoveryUp = true; kc.state.requests.length = 0; });

const idToken = (extra: Record<string, unknown> = {}) =>
  signJwt({ iss: issuer, aud: 'harbormaster', azp: 'harbormaster', sub: 'kc-user', sid: 'kc-sid', exp: now() + 300, iat: now(), hsl_roles: ['member'], ...extra }, key);
const client = (extra = {}) => new HslSso({ issuer, clientId: 'harbormaster', clientSecret: 's3cret', redirectUri: 'https://hm.example.test/api/auth/hsl/callback', ...extra });

describe('discovery', () => {
  test('nothing is fetched until it is needed', async () => {
    client();
    assert.equal(kc.state.requests.length, 0);
  });

  test('Keycloak down at first use: unavailable, and it tries again next time', async () => {
    const c = client();
    discoveryUp = false;
    await assert.rejects(c.authUrl(newFlow()), (e) => e instanceof SsoError && e.kind === 'unavailable');
    discoveryUp = true;
    assert.match(await c.authUrl(newFlow()), /protocol\/openid-connect\/auth\?/);
  });

  test('a wrong issuer in the document is refused', async () => {
    const c = new HslSso({ issuer: `${kc.url}/realms/hsl`.replace('127.0.0.1', 'localhost'), clientId: 'harbormaster', clientSecret: 's', redirectUri: 'https://x.test/cb', internalUrl: kc.url });
    await assert.rejects(c.discovery(), (e) => e instanceof SsoError && e.kind === 'unavailable' && /issuer/.test(e.message));
  });

  test('HSL_OIDC_INTERNAL_URL: server-to-server endpoints move to it, browser ones stay public', async () => {
    // Keycloak announces its public address; here the "public" one is the same server under another name.
    const publicIssuer = issuer;
    const internal = kc.url.replace('127.0.0.1', 'localhost');
    const c = client({ internalUrl: internal });
    const d = await c.discovery();
    assert.equal(d.issuer, publicIssuer);
    assert.ok(d.token_endpoint.startsWith(`${internal}/`), d.token_endpoint);
    assert.ok(d.jwks_uri.startsWith(`${internal}/`), d.jwks_uri);
    assert.ok(d.authorization_endpoint.startsWith(publicIssuer), d.authorization_endpoint);
    assert.ok(d.end_session_endpoint!.startsWith(publicIssuer));
    assert.equal(kc.state.requests[0].headers.host, new URL(internal).host);
  });
});

describe('sign-in', () => {
  test('the authorization address carries PKCE S256, state, nonce and the scopes', async () => {
    const f = newFlow();
    const u = new URL(await client().authUrl(f, { prompt: 'login' }));
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'openid profile email');
    assert.equal(u.searchParams.get('client_id'), 'harbormaster');
    assert.equal(u.searchParams.get('state'), f.state);
    assert.equal(u.searchParams.get('nonce'), f.nonce);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(f.verifier).digest('base64url'));
    assert.equal(u.searchParams.get('prompt'), 'login');
  });

  test('exchange sends the verifier and returns verified claims and the session length', async () => {
    const f = newFlow();
    let sent: URLSearchParams | null = null;
    tokenReply = (form) => { sent = form; return [200, { id_token: idToken({ nonce: f.nonce }), refresh_token: 'r1', refresh_expires_in: 345600 }]; };
    const t = await client().exchange('code-1', f);
    assert.equal(sent!.get('code_verifier'), f.verifier);
    assert.equal(sent!.get('grant_type'), 'authorization_code');
    assert.equal(sent!.get('redirect_uri'), 'https://hm.example.test/api/auth/hsl/callback');
    assert.equal(t.claims.sub, 'kc-user');
    assert.equal(t.refreshToken, 'r1');
    assert.equal(t.sessionSeconds, 345600);
  });

  test('exchange refuses an ID token with the wrong nonce', async () => {
    tokenReply = () => [200, { id_token: idToken({ nonce: 'someone-elses' }), refresh_token: 'r1' }];
    await assert.rejects(client().exchange('c', newFlow()), (e) => e instanceof SsoError && e.kind === 'invalid');
  });

  test('a 4xx from the token endpoint is a refusal, a 5xx is unavailable', async () => {
    tokenReply = () => [400, { error: 'invalid_grant' }];
    await assert.rejects(client().exchange('c', newFlow()), (e) => e instanceof SsoError && e.kind === 'refused');
    tokenReply = () => [502, {}];
    await assert.rejects(client().exchange('c', newFlow()), (e) => e instanceof SsoError && e.kind === 'unavailable');
  });
});

describe('refresh (the recheck)', () => {
  const cases: [string, [number, unknown] | (() => [number, unknown]), string | null][] = [
    ['success', () => [200, { id_token: idToken(), refresh_token: 'r2', refresh_expires_in: 2592000 }], null],
    ['signed out or disabled: invalid_grant', [400, { error: 'invalid_grant', error_description: 'Session not active' }], 'refused'],
    ['another 400 (invalid_request)', [400, { error: 'invalid_request' }], 'unavailable'],
    ['wrong client secret: invalid_client', [401, { error: 'invalid_client' }], 'unavailable'],
    ['server error', [500, {}], 'unavailable'],
    ['answer for someone else', () => [200, { id_token: idToken({ sub: 'other-user' }), refresh_token: 'r2' }], 'refused'],
    ['bad signature', () => [200, { id_token: signJwt({ iss: issuer, aud: 'harbormaster', sub: 'kc-user', exp: now() + 60, iat: now() }, makeKey('kc1')) }], 'invalid'],
    ['no ID token', [200, { access_token: 'a', refresh_token: 'r2' }], 'invalid'],
  ];
  for (const [name, reply, kind] of cases) {
    test(name, async () => {
      tokenReply = () => (typeof reply === 'function' ? reply() : reply);
      const p = client().refresh('r1', 'kc-user');
      if (kind === null) {
        const t = await p;
        assert.equal(t.refreshToken, 'r2');
        assert.equal(t.sessionSeconds, 2592000);
      } else {
        await assert.rejects(p, (e) => e instanceof SsoError && e.kind === kind);
      }
    });
  }

  test('Keycloak unreachable is unavailable', async () => {
    const down = await serve((_q, _b, res) => res.destroy());
    const c2 = new HslSso({ issuer, clientId: 'harbormaster', clientSecret: 's', redirectUri: 'https://x.test/cb' });
    await c2.discovery();
    // Point the cached token endpoint at a server that hangs up.
    (await c2.discovery()).token_endpoint = `${down.url}/token`;
    await assert.rejects(c2.refresh('r1', 'kc-user'), (e) => e instanceof SsoError && e.kind === 'unavailable');
    await down.close();
  });

  test('a refresh without a new refresh token keeps the old one', async () => {
    tokenReply = () => [200, { id_token: idToken() }];
    assert.equal((await client().refresh('r1', 'kc-user')).refreshToken, 'r1');
  });

  test('a missing refresh_expires_in gives 0, for the caller to default', async () => {
    tokenReply = () => [200, { id_token: idToken(), refresh_token: 'r2' }];
    assert.equal((await client().refresh('r1', 'kc-user')).sessionSeconds, 0);
  });
});

test('roles: only the ones Harbor Master knows, and a missing claim is no role', () => {
  assert.deepEqual(knownRoles(['member', 'admin', 'editor'], ['admin', 'member']), ['admin', 'member']);
  assert.deepEqual(knownRoles(undefined, ['admin', 'member']), []);
  assert.deepEqual(knownRoles('admin', ['admin', 'member']), []);
  assert.deepEqual(knownRoles(['viewer'], ['admin', 'member']), []);
});

test('sign-out address carries id_token_hint, client_id and the signed-out page', async () => {
  const u = new URL(await client().endSessionUrl('id.tok.en', 'https://hm.example.test/signed-out'));
  assert.ok(u.href.startsWith(`${issuer}/protocol/openid-connect/logout?`));
  assert.equal(u.searchParams.get('id_token_hint'), 'id.tok.en');
  assert.equal(u.searchParams.get('client_id'), 'harbormaster');
  assert.equal(u.searchParams.get('post_logout_redirect_uri'), 'https://hm.example.test/signed-out');
});

describe('sealed tokens', () => {
  const t = { sub: 'kc-user', refresh_token: 'r', id_token: 'i' };
  test('round trip', () => assert.deepEqual(openTokens('secret', sealTokens('secret', t)), t));
  test('each seal is different', () => assert.notEqual(sealTokens('secret', t), sealTokens('secret', t)));
  test('another secret cannot open them', () => assert.throws(() => openTokens('other', sealTokens('secret', t))));
  test('an altered value is refused', () => {
    const s = sealTokens('secret', t);
    const flipped = s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
    assert.throws(() => openTokens('secret', flipped));
  });
  test('the value does not contain the tokens in clear', () => assert.ok(!sealTokens('secret', { ...t, refresh_token: 'VISIBLE' }).includes('VISIBLE')));
});
