// "Sign in with Google" (OpenID Connect, authorization code flow with PKCE).
// Only existing, active accounts can sign in: the verified Google email must match a user,
// and after the first sign-in the Google account id is linked to that user.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../audit.js';
import { createSession, randomToken, setSessionCookie, sha256, type Ctx } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { safeNext, verifyOidcIdToken, type IdClaims } from '../oidc.js';
import { hslEnabled } from './hsl-auth.js';

export const googleEnabled = () => !!(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

/** Verifies a Google ID token's signature and claims. */
export const verifyIdToken = (idToken: string, nonce: string): Promise<IdClaims> =>
  verifyOidcIdToken(idToken, { jwksUrl: config.google.jwksUrl, issuers: config.google.issuers, clientId: config.google.clientId, nonce });

function fail(reply: FastifyReply, code: string, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams({ error: code, ...extra });
  return reply.redirect(`/login?${qs}`);
}

export default async function googleAuthRoutes(app: FastifyInstance) {
  app.get('/api/auth/providers', async () => ({ google: googleEnabled(), hsl: hslEnabled() }));

  app.get('/api/auth/google/start', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (!googleEnabled()) return fail(reply, 'google_off');
    const f = req.query as Record<string, string | undefined>;
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    await q(`delete from oauth_states where expires_at < now()`);
    await q(
      `insert into oauth_states (id, provider, nonce, code_verifier, next_path, remember, expires_at) values ($1, 'google', $2, $3, $4, $5, now() + interval '10 minutes')`,
      [sha256(state), nonce, verifier, safeNext(f.next), f.remember !== '0'],
    );
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    if (config.google.allowedDomains.length === 1) params.set('hd', config.google.allowedDomains[0]);
    return reply.redirect(`${config.google.authUrl}?${params}`);
  });

  app.get('/api/auth/google/callback', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const f = req.query as Record<string, string | undefined>;
    if (f.error) return fail(reply, f.error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    if (!googleEnabled() || !f.state || !f.code) return fail(reply, 'google_failed');
    const st = await one<{ nonce: string; code_verifier: string; next_path: string; remember: boolean }>(
      `delete from oauth_states where id = $1 and provider = 'google' and expires_at > now() returning nonce, code_verifier, next_path, remember`,
      [sha256(f.state)],
    );
    if (!st) return fail(reply, 'google_expired');

    let claims: IdClaims;
    try {
      const res = await fetch(config.google.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: f.code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: st.code_verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.id_token) throw new Error(data.error_description ?? data.error ?? `token exchange failed (${res.status})`);
      claims = await verifyIdToken(data.id_token, st.nonce);
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'google sign-in failed');
      return fail(reply, 'google_failed');
    }

    const email = (claims.email ?? '').toLowerCase();
    const ctxFor = (name: string, id: string | null): Ctx => ({
      user: { id: id ?? '00000000-0000-0000-0000-000000000000', email, name, kind: 'human', must_change_password: false },
      via: 'web', ip: req.ip, tokenId: null, sessionId: null, global: new Set(), projectPerms: new Map(),
    });
    if (!email || claims.email_verified !== true) return fail(reply, 'google_unverified');
    const domain = email.split('@')[1] ?? '';
    if (config.google.allowedDomains.length && !config.google.allowedDomains.includes(domain)) {
      await audit(ctxFor(email, null), { action: 'auth.login_failed', entityType: 'user', summary: `Google sign-in refused for ${email}: domain not allowed` });
      return fail(reply, 'google_domain', { email });
    }

    const user =
      (await one<{ id: string; name: string; is_active: boolean; kind: string; google_sub: string | null }>(`select id, name, is_active, kind, google_sub from users where google_sub = $1`, [claims.sub])) ??
      (await one<{ id: string; name: string; is_active: boolean; kind: string; google_sub: string | null }>(`select id, name, is_active, kind, google_sub from users where lower(email) = $1`, [email]));
    if (!user || user.kind !== 'human') {
      await audit(ctxFor(email, null), { action: 'auth.login_failed', entityType: 'user', summary: `Google sign-in refused for ${email}: no account` });
      return fail(reply, 'google_no_account', { email });
    }
    if (!user.is_active) {
      await audit(ctxFor(user.name, user.id), { action: 'auth.login_failed', entityType: 'user', entityId: user.id, summary: `Google sign-in refused for ${user.name}: account deactivated` });
      return fail(reply, 'google_disabled');
    }
    if (user.google_sub && user.google_sub !== claims.sub) {
      await audit(ctxFor(user.name, user.id), { action: 'auth.login_failed', entityType: 'user', entityId: user.id, summary: `Google sign-in refused for ${user.name}: a different Google account is linked` });
      return fail(reply, 'google_mismatch');
    }
    if (!user.google_sub) {
      await q(`update users set google_sub = $2 where id = $1`, [user.id, claims.sub]);
      await audit(ctxFor(user.name, user.id), { action: 'user.google_linked', entityType: 'user', entityId: user.id, summary: `Linked ${user.name} to the Google account ${email}` });
    }
    const s = await createSession(user.id, req.ip, req.headers['user-agent'] ?? null, st.remember);
    await q(`update users set last_login_at = now() where id = $1`, [user.id]);
    await audit(ctxFor(user.name, user.id), { action: 'auth.login', entityType: 'user', entityId: user.id, summary: `${user.name} signed in with Google` });
    setSessionCookie(reply, s.token, s.expires, s.remember);
    return reply.redirect(st.next_path);
  });
}
