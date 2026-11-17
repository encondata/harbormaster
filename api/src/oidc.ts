// Shared OpenID Connect helpers: signing-key (JWKS) cache and ID-token verification (RS256).
import { createPublicKey, createVerify } from 'node:crypto';

/** A same-site path to return to after sign-in; anything else becomes '/'. */
export const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/api/') ? n.slice(0, 2000) : '/');

const jwksCache = new Map<string, { keys: any[]; at: number }>();

async function keys(jwksUrl: string, force = false) {
  const hit = jwksCache.get(jwksUrl);
  if (!force && hit && Date.now() - hit.at < 3600_000) return hit.keys;
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`could not load signing keys (${res.status})`);
  const found = ((await res.json()) as any).keys ?? [];
  jwksCache.set(jwksUrl, { keys: found, at: Date.now() });
  return found as any[];
}

export type IdClaims = {
  iss: string; aud: string | string[]; azp?: string; sub: string; exp: number; iat: number; nonce?: string;
  email?: string; email_verified?: boolean; hd?: string; name?: string; given_name?: string; family_name?: string; preferred_username?: string;
};

/** Verifies an ID token's RS256 signature against the issuer's keys, then its issuer, audience, expiry and nonce. */
export async function verifyOidcIdToken(idToken: string, o: { jwksUrl: string; issuers: string[]; clientId: string; nonce: string }): Promise<IdClaims> {
  const [h, p, sig] = idToken.split('.');
  if (!h || !p || !sig) throw new Error('malformed ID token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  let jwk = (await keys(o.jwksUrl)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(o.jwksUrl, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  if (!v.verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) throw new Error('bad token signature');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as IdClaims;
  const now = Math.floor(Date.now() / 1000);
  if (!o.issuers.includes(c.iss)) throw new Error('wrong token issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.clientId)) throw new Error('token was not issued for this app');
  if (aud.length > 1 && c.azp !== o.clientId) throw new Error('token was not issued for this app');
  if (typeof c.exp !== 'number' || c.exp < now - 60) throw new Error('token expired');
  if (c.nonce !== o.nonce) throw new Error('nonce mismatch');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('token has no subject');
  return c;
}
