// ID-token verification (src/oidc.ts) against keys generated here and served by a stand-in JWKS endpoint.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { KeysUnavailable, safeNext, verifyOidcIdToken, type VerifyOptions } from '../src/oidc.js';
import { json, makeKey, now, serve, signJwt } from './helpers.js';

const ISS = 'https://auth.example.test/realms/hackspacelabs';
const key = makeKey('k1');
const other = makeKey('k1'); // same key id, different key: a forged signature
const rotated = makeKey('k2');

let jwks: Awaited<ReturnType<typeof serve>>;
let served: Record<string, unknown>[] = [key.jwk];
before(async () => { jwks = await serve((_req, _b, res) => json(res, 200, { keys: served })); });
after(() => jwks.close());

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS, aud: 'harbormaster', sub: 'user-1', exp: now() + 300, iat: now(), nonce: 'n-1', hsl_roles: ['member'], ...extra,
});
const opts = (extra: Partial<VerifyOptions> = {}): VerifyOptions => ({ jwksUrl: `${jwks.url}/jwks`, issuers: [ISS], clientId: 'harbormaster', nonce: 'n-1', ...extra });

describe('verifyOidcIdToken', () => {
  test('accepts a good token and returns its claims', async () => {
    const c = await verifyOidcIdToken(signJwt(claims(), key), opts());
    assert.equal(c.sub, 'user-1');
    assert.deepEqual(c.hsl_roles, ['member']);
  });

  const bad: [string, () => string, Partial<VerifyOptions>, RegExp][] = [
    ['wrong issuer', () => signJwt(claims({ iss: 'https://evil.test/realms/x' }), key), {}, /issuer/],
    ['wrong audience', () => signJwt(claims({ aud: 'switchyard' }), key), {}, /not issued/],
    ['several audiences without azp', () => signJwt(claims({ aud: ['harbormaster', 'other'] }), key), {}, /not issued/],
    ['several audiences, azp another client', () => signJwt(claims({ aud: ['harbormaster', 'other'], azp: 'other' }), key), {}, /not issued/],
    ['expired beyond the leeway', () => signJwt(claims({ exp: now() - 61 }), key), {}, /expired/],
    ['issued in the future', () => signJwt(claims({ iat: now() + 120 }), key), {}, /future/],
    ['no iat', () => signJwt(claims({ iat: undefined }), key), {}, /future/],
    ['nonce mismatch', () => signJwt(claims({ nonce: 'other' }), key), {}, /nonce/],
    ['missing nonce', () => signJwt(claims({ nonce: undefined }), key), {}, /nonce/],
    ['empty subject', () => signJwt(claims({ sub: '' }), key), {}, /subject/],
    ['forged signature', () => signJwt(claims(), other), {}, /signature/],
    ['HS256 header', () => signJwt(claims(), key, { alg: 'HS256' }), {}, /algorithm/],
    ['alg none', () => { const [h, p] = signJwt(claims(), key, { alg: 'none' }).split('.'); return `${h}.${p}.`; }, {}, /malformed|algorithm/],
    ['garbage', () => 'not-a-jwt', {}, /malformed/],
    ['altered payload', () => { const [h, , s] = signJwt(claims(), key).split('.'); return `${h}.${Buffer.from(JSON.stringify(claims({ sub: 'admin' }))).toString('base64url')}.${s}`; }, {}, /signature/],
  ];
  for (const [name, token, o, re] of bad) {
    test(`refuses: ${name}`, async () => {
      await assert.rejects(verifyOidcIdToken(token(), opts(o)), (e: Error) => re.test(e.message) && !(e instanceof KeysUnavailable));
    });
  }

  test('accepts several audiences when azp is this client', async () => {
    await verifyOidcIdToken(signJwt(claims({ aud: ['harbormaster', 'account'], azp: 'harbormaster' }), key), opts());
  });

  test('accepts expiry within the 60-second leeway', async () => {
    await verifyOidcIdToken(signJwt(claims({ exp: now() - 30 }), key), opts());
  });

  test('nonce: false skips the nonce (a refreshed ID token)', async () => {
    await verifyOidcIdToken(signJwt(claims({ nonce: undefined }), key), opts({ nonce: false }));
  });

  test('an unknown key id refetches the keys once (key rotation)', async () => {
    const t = signJwt(claims(), rotated);
    served = [key.jwk, rotated.jwk];
    const c = await verifyOidcIdToken(t, opts());
    assert.equal(c.sub, 'user-1');
  });

  test('a key id that is still unknown after refetching is refused', async () => {
    await assert.rejects(verifyOidcIdToken(signJwt(claims(), makeKey('k9')), opts()), /unknown signing key/);
  });

  test('keys that cannot be fetched are KeysUnavailable, not a verdict', async () => {
    const down = await serve((_req, _b, res) => json(res, 503, {}));
    try {
      await assert.rejects(verifyOidcIdToken(signJwt(claims(), key), opts({ jwksUrl: `${down.url}/jwks` })), (e) => e instanceof KeysUnavailable);
    } finally {
      await down.close();
    }
  });
});

describe('safeNext', () => {
  const ok = ['/', '/p/SS/b/1?x=1#y', '/oauth/authorize?client_id=hslc_x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&state=' + 's'.repeat(1500)];
  for (const n of ok) test(`keeps ${n.slice(0, 40)}`, () => assert.equal(safeNext(n), n));
  const bad = ['', 'https://evil.test/', '//evil.test/x', '/\\evil.test', '/api/auth/logout', 'javascript:alert(1)', '/a\nb', '/a\u0000', '/x'.repeat(5000), 42, null];
  for (const n of bad) test(`refuses ${JSON.stringify(n)?.slice(0, 30)}`, () => assert.equal(safeNext(n), '/'));
});
