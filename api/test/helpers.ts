// Test helpers: generated RSA keys, signed JWTs and a tiny HTTP server to stand in for Keycloak or the portal.
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Key = { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> };

export function makeKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signJwt(claims: Record<string, unknown>, key: Key, header: Record<string, unknown> = {}) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header });
  const body = b64(claims);
  const s = createSign('RSA-SHA256');
  s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(key.privateKey).toString('base64url')}`;
}

export const now = () => Math.floor(Date.now() / 1000);

export type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => unknown;

/** Starts a server on a free port; `handler` can be swapped while it runs. */
export async function serve(handler: Handler) {
  const state = { handler, requests: [] as { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      state.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      try {
        await state.handler(req, body, res);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
