// Shared OpenID Connect helpers: signing-key (JWKS) cache and ID-token verification (RS256).
// Used by Sign in with Google and Sign in with HackSpaceLabs.
import { createPublicKey, createVerify } from 'node:crypto';

/**
 * A same-site path to return to after sign-in; anything else becomes '/'. Starts with one '/', no
 * backslash or control characters, no scheme or host, not an API route. Never shortened: a cut-off
 * address (say, the Claude connector's consent page) is worse than going home.
 */
export function safeNext(n: unknown): string {
  if (typeof n !== 'string' || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/api/') || n.length > 8000) return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(n)) return '/';
  try {
    const u = new URL(n, 'http://x.invalid');
    if (u.host !== 'x.invalid' || u.username || u.password) return '/';
  } catch {
    return '/';
  }
  return n;
}

/** The signing keys could not be loaded. Not a verdict on the token: try again later. */
export class KeysUnavailable extends Error {}

const jwksCache = new Map<string, { keys: any[]; at: number }>();

async function keys(jwksUrl: string, force = false) {
  const hit = jwksCache.get(jwksUrl);
  if (!force && hit && Date.now() - hit.at < 3600_000) return hit.keys;
  let found: any[];
  try {
    const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    found = ((await res.json()) as any).keys ?? [];
    if (!Array.isArray(found)) throw new Error('no keys');
  } catch (e: any) {
    if (hit) return hit.keys;
    throw new KeysUnavailable(`could not load signing keys: ${e?.message ?? e}`);
  }
  jwksCache.set(jwksUrl, { keys: found, at: Date.now() });
  return found;
}

export type IdClaims = {
  iss: string; aud: string | string[]; azp?: string; sub: string; exp: number; iat: number; nonce?: string; sid?: string; auth_time?: number;
  email?: string; email_verified?: boolean; hd?: string; name?: string; given_name?: string; family_name?: string; preferred_username?: string;
  hsl_roles?: unknown;
};

export type VerifyOptions = {
  jwksUrl: string;
  issuers: string[];
  clientId: string;
  /** The nonce the sign-in sent, or false when there is none to check (a refreshed ID token). */
  nonce: string | false;
  /** Seconds since the epoch; for tests. */
  now?: number;
};

const LEEWAY_S = 60;

/**
 * Verifies an ID token's RS256 signature against the issuer's keys (cached for an hour, refetched once
 * for an unknown key id), then its issuer, audience (and azp when there are several), expiry, issue
 * time, nonce and subject. Throws KeysUnavailable if the keys can't be fetched, Error otherwise.
 */
export async function verifyOidcIdToken(idToken: string, o: VerifyOptions): Promise<IdClaims> {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  const [h, p, sig] = parts;
  if (parts.length !== 3 || !h || !p || !sig) throw new Error('malformed ID token');
  let header: any;
  let c: IdClaims;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
    c = JSON.parse(Buffer.from(p, 'base64url').toString()) as IdClaims;
  } catch {
    throw new Error('malformed ID token');
  }
  if (header?.alg !== 'RS256') throw new Error('unexpected token algorithm');
  const pick = (list: any[]) => list.find((k) => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  let jwk = pick(await keys(o.jwksUrl));
  if (!jwk) jwk = pick(await keys(o.jwksUrl, true));
  if (!jwk) throw new Error('unknown signing key');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  let ok = false;
  try {
    ok = v.verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('bad token signature');
  if (!c || typeof c !== 'object') throw new Error('malformed ID token');
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!o.issuers.includes(c.iss)) throw new Error('wrong token issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.clientId)) throw new Error('token was not issued for this app');
  if (aud.length > 1 && c.azp !== o.clientId) throw new Error('token was not issued for this app');
  if (typeof c.exp !== 'number' || c.exp < now - LEEWAY_S) throw new Error('token expired');
  if (typeof c.iat !== 'number' || c.iat > now + LEEWAY_S) throw new Error('token issued in the future');
  if (o.nonce !== false && c.nonce !== o.nonce) throw new Error('nonce mismatch');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('token has no subject');
  return c;
}
