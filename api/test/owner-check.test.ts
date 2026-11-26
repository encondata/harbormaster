// The API-token owner check (src/owner-check.ts) against a stand-in portal gateway.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { OwnerCheck } from '../src/owner-check.js';
import { json, serve } from './helpers.js';

let portal: Awaited<ReturnType<typeof serve>>;
let answer: [number, unknown] = [200, { enabled: true, roles: ['member'] }];
before(async () => { portal = await serve((_req, _b, res) => json(res, answer[0], answer[1])); });
after(() => portal.close());
beforeEach(() => { portal.state.requests.length = 0; answer = [200, { enabled: true, roles: ['member'] }]; });

let clock = 1_000_000;
const check = (portalUrl = portal.url) =>
  new OwnerCheck({ portalUrl, secret: 'client-secret', appId: 'harbormaster', roles: ['admin', 'member'], now: () => clock });

test('asks the portal with the client secret, for this app and person', async () => {
  assert.equal(await check().allowed('kc-sub-1'), true);
  const r = portal.state.requests[0];
  assert.equal(r.url, '/internal/apps/harbormaster/owners/kc-sub-1');
  assert.equal(r.headers.authorization, 'Bearer client-secret');
});

for (const [name, body, want] of [
  ['enabled with a role', { enabled: true, roles: ['admin'] }, true],
  ['no role ([])', { enabled: true, roles: [] }, false],
  ['only a role Harbor Master does not know', { enabled: true, roles: ['viewer'] }, false],
  ['disabled', { enabled: false, roles: ['member'] }, false],
] as const) {
  test(name, async () => {
    answer = [200, body];
    assert.equal(await check().allowed('s'), want);
  });
}

test('400 (malformed id) and 404 (wrong secret, or via the proxy) refuse', async () => {
  answer = [400, { error: 'bad id' }];
  assert.equal(await check().allowed('s'), false);
  answer = [404, {}];
  assert.equal(await check().allowed('s'), false);
});

test('asks at most once per five minutes per owner, and concurrent calls share one question', async () => {
  const c = check();
  await Promise.all([c.allowed('a'), c.allowed('a'), c.allowed('a')]);
  assert.equal(portal.state.requests.length, 1);
  clock += 4 * 60_000;
  await c.allowed('a');
  assert.equal(portal.state.requests.length, 1);
  await c.allowed('b');
  assert.equal(portal.state.requests.length, 2);
  answer = [200, { enabled: false, roles: [] }];
  clock += 61_000;
  assert.equal(await c.allowed('a'), false);
  assert.equal(portal.state.requests.length, 3);
});

test('outage (503): keeps the last answer, and waits a full interval before asking again', async () => {
  const c = check();
  assert.equal(await c.allowed('x'), true);
  answer = [503, { error: 'keycloak unavailable' }];
  clock += 6 * 60_000;
  assert.equal(await c.allowed('x'), true);
  assert.equal(portal.state.requests.length, 2);
  await c.allowed('x');
  assert.equal(portal.state.requests.length, 2);

  answer = [200, { enabled: false, roles: [] }];
  const d = check();
  assert.equal(await d.allowed('y'), false);
  answer = [503, {}];
  clock += 6 * 60_000;
  assert.equal(await d.allowed('y'), false, 'a refusal is not lifted by an outage');
});

test('portal unreachable with no earlier answer: keep working', async () => {
  const down = await serve((_q, _b, res) => res.destroy());
  const url = down.url;
  await down.close();
  assert.equal(await check(url).allowed('z'), true);
});

test('forget drops the cached answer', async () => {
  const c = check();
  await c.allowed('f');
  c.forget('f');
  await c.allowed('f');
  assert.equal(portal.state.requests.length, 2);
});
