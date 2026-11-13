// "Sign in with HackSpaceLabs": OpenID Connect against the HSL Keycloak realm (authorization code
// flow with PKCE, state and nonce, ID token signature checked against the realm's keys).
//
// Who gets in:
// - An account already linked to the HSL account (by its stable `sub`) signs in.
// - Otherwise the first HSL sign-in links to an account when an administrator set that account's
//   HSL username, or when Keycloak vouches for the email (email_verified) and it matches.
// - Signed-in people can link their own account from the Account page.
// - Anyone else gets a new account with no global roles and no projects. HSL does not verify email
//   addresses, so an unverified email is never used as the account email (it would let someone claim
//   another person's Google sign-in or block their address); it goes into the contact email instead.
// Passwords, Google sign-in, sessions and API tokens are unaffected.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../audit.js';
import { createSession, randomToken, requireUser, setSessionCookie, sha256, type Ctx } from '../auth.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { safeNext, verifyOidcIdToken, type IdClaims } from '../oidc.js';

export const hslEnabled = () => !!(config.hsl.issuer && config.hsl.clientId && config.hsl.clientSecret);
const redirectUri = () => `${config.publicUrl}/api/auth/hsl/callback`;

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let discovery: { doc: Discovery; at: number } | null = null;

/** The realm's endpoints, from its discovery document (cached for an hour). */
async function endpoints(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < 3600_000) return discovery.doc;
  const res = await fetch(`${config.hsl.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`could not load HackSpaceLabs sign-in settings (${res.status})`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer !== config.hsl.issuer) throw new Error('HackSpaceLabs issuer does not match HSL_OIDC_ISSUER');
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('HackSpaceLabs discovery document is incomplete');
  discovery = { doc, at: Date.now() };
  return doc;
}

function fail(reply: FastifyReply, code: string, extra: Record<string, string> = {}) {
  return reply.redirect(`/login?${new URLSearchParams({ error: code, ...extra })}`);
}
function failLink(reply: FastifyReply, code: string) {
  return reply.redirect(`/account?${new URLSearchParams({ hsl: code })}`);
}

type UserRow = { id: string; name: string; email: string; is_active: boolean; kind: string; hsl_sub: string | null; hsl_username: string | null };
const USER_COLS = 'id, name, email, is_active, kind, hsl_sub, hsl_username';

/** Starts a sign-in (or link) attempt and returns the HSL authorization URL. */
async function begin(opts: { next: string; remember: boolean; linkUserId?: string }) {
  const ep = await endpoints();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  await q(`delete from oauth_states where expires_at < now()`);
  await q(
    `insert into oauth_states (id, provider, nonce, code_verifier, next_path, remember, link_user_id, expires_at)
     values ($1, 'hsl', $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
    [sha256(state), nonce, verifier, opts.next, opts.remember, opts.linkUserId ?? null],
  );
  const params = new URLSearchParams({
    client_id: config.hsl.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `${ep.authorization_endpoint}?${params}`;
}

const displayName = (c: IdClaims) =>
  (c.name?.trim() || [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || c.preferred_username || 'HackSpaceLabs user').slice(0, 120);

export default async function hslAuthRoutes(app: FastifyInstance) {
  const limited = { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } };

  app.get('/api/auth/hsl/start', limited, async (req, reply) => {
    if (!hslEnabled()) return fail(reply, 'hsl_off');
    const f = req.query as Record<string, string | undefined>;
    try {
      return reply.redirect(await begin({ next: safeNext(f.next), remember: f.remember !== '0' }));
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'hsl sign-in could not start');
      return fail(reply, 'hsl_failed');
    }
  });

  // Link the signed-in person's account. A POST (CSRF-checked) so another site can't start it.
  app.post('/api/auth/hsl/link', limited, async (req) => {
    const ctx = requireUser(req);
    if (!hslEnabled()) throw badRequest("HackSpaceLabs sign-in isn't set up on this server");
    if (ctx.via !== 'web' || ctx.user.kind !== 'human') throw badRequest('Only people signed in to the web app can link a HackSpaceLabs account');
    return { url: await begin({ next: '/account?hsl=linked', remember: true, linkUserId: ctx.user.id }) };
  });

  // Unlink your own HSL account, if you still have another way to sign in.
  app.post('/api/auth/hsl/unlink', async (req) => {
    const ctx = requireUser(req);
    const u = await one<{ name: string; has_other: boolean }>(
      `select name, (password_hash is not null or google_sub is not null) as has_other from users where id = $1 and hsl_sub is not null`,
      [ctx.user.id],
    );
    if (!u) throw notFound('No HackSpaceLabs account is linked');
    if (!u.has_other) throw badRequest('Set a password first: HackSpaceLabs is your only way to sign in');
    await q(`update users set hsl_sub = null, hsl_username = null, updated_at = now() where id = $1`, [ctx.user.id]);
    await audit(ctx, { action: 'user.hsl_unlinked', entityType: 'user', entityId: ctx.user.id, summary: `${u.name} unlinked their HackSpaceLabs account` });
    return { ok: true };
  });

  app.get('/api/auth/hsl/callback', limited, async (req, reply) => {
    const f = req.query as Record<string, string | undefined>;
    if (!f.state) return fail(reply, 'hsl_failed');
    const st = await one<{ nonce: string; code_verifier: string; next_path: string; remember: boolean; link_user_id: string | null }>(
      `delete from oauth_states where id = $1 and provider = 'hsl' and expires_at > now() returning nonce, code_verifier, next_path, remember, link_user_id`,
      [sha256(f.state)],
    );
    if (!st) return fail(reply, 'hsl_expired');
    const bail = (code: string) => (st.link_user_id ? failLink(reply, code) : fail(reply, code));
    if (f.error) return bail(f.error === 'access_denied' ? 'hsl_cancelled' : 'hsl_failed');
    if (!hslEnabled() || !f.code) return bail('hsl_failed');

    let claims: IdClaims;
    try {
      const ep = await endpoints();
      const res = await fetch(ep.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: f.code, client_id: config.hsl.clientId, client_secret: config.hsl.clientSecret,
          redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: st.code_verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.id_token) throw new Error(data.error_description ?? data.error ?? `token exchange failed (${res.status})`);
      claims = await verifyOidcIdToken(data.id_token, { jwksUrl: ep.jwks_uri, issuers: [ep.issuer], clientId: config.hsl.clientId, nonce: st.nonce });
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'hsl sign-in failed');
      return bail('hsl_failed');
    }

    const sub = claims.sub;
    const username = (claims.preferred_username ?? '').trim().slice(0, 255) || null;
    const email = (claims.email ?? '').trim().toLowerCase() || null;
    const emailVerified = !!email && claims.email_verified === true;
    const label = username ?? email ?? sub;
    const ctxFor = (name: string, id: string | null, userEmail = email ?? ''): Ctx => ({
      user: { id: id ?? '00000000-0000-0000-0000-000000000000', email: userEmail, name, kind: 'human', must_change_password: false },
      via: 'web', ip: req.ip, tokenId: null, sessionId: null, global: new Set(), projectPerms: new Map(),
    });
    const refuse = async (code: string, why: string, u?: UserRow) => {
      await audit(ctxFor(u?.name ?? label, u?.id ?? null), { action: 'auth.login_failed', entityType: 'user', entityId: u?.id, summary: `HackSpaceLabs sign-in refused for ${u?.name ?? label}: ${why}` });
      return bail(code);
    };
    const linkTo = async (u: UserRow, how: string) => {
      await tx(async (c) => {
        // A username an administrator reserved on a different, unlinked account moves to this one.
        if (username) await c.query(`update users set hsl_username = null where lower(hsl_username) = lower($1) and id <> $2 and hsl_sub is null`, [username, u.id]);
        await c.query(`update users set hsl_sub = $2, hsl_username = $3, updated_at = now() where id = $1`, [u.id, sub, username]);
        await audit(ctxFor(u.name, u.id, u.email), { action: 'user.hsl_linked', entityType: 'user', entityId: u.id, summary: `Linked ${u.name} to the HackSpaceLabs account ${label} (${how})` }, c);
      });
    };

    const bySub = await one<UserRow>(`select ${USER_COLS} from users where hsl_sub = $1`, [sub]);

    // Linking from the Account page while signed in.
    if (st.link_user_id) {
      const me = await one<UserRow>(`select ${USER_COLS} from users where id = $1`, [st.link_user_id]);
      if (!me || !me.is_active || me.kind !== 'human') return failLink(reply, 'hsl_failed');
      if (bySub && bySub.id !== me.id) return refuse('hsl_taken', `already linked to ${bySub.name}`, me);
      if (me.hsl_sub && me.hsl_sub !== sub) return refuse('hsl_mismatch', 'a different HackSpaceLabs account is linked', me);
      if (!me.hsl_sub) await linkTo(me, 'linked from their account page');
      return reply.redirect(st.next_path);
    }

    let user = bySub;
    let how = '';
    if (!user && username) {
      user = await one<UserRow>(`select ${USER_COLS} from users where lower(hsl_username) = lower($1) and hsl_sub is null`, [username]);
      how = 'HSL username set by an administrator';
    }
    if (!user && emailVerified) {
      user = await one<UserRow>(`select ${USER_COLS} from users where lower(email) = $1 and hsl_sub is null`, [email]);
      how = 'verified email';
    }

    if (!user) {
      // Someone with a Harbor Master account under this email should link it rather than get a second account.
      if (email && (await one(`select 1 from users where lower(email) = $1`, [email]))) return refuse('hsl_email_taken', 'an account already uses that email; link it from the Account page');
      const slug = (username ?? sub).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60) || 'user';
      let accountEmail = emailVerified ? email! : `${slug}@hsl.invalid`;
      if (await one(`select 1 from users where lower(email) = $1`, [accountEmail])) accountEmail = `${slug}-${sha256(sub).slice(0, 8)}@hsl.invalid`;
      const name = displayName(claims);
      try {
        user = await tx(async (c) => {
          const u = (await one<UserRow>(
            `insert into users (email, name, kind, hsl_sub, hsl_username, first_name, last_name, contact_email)
             values ($1, $2, 'human', $3, $4, $5, $6, $7) returning ${USER_COLS}`,
            [accountEmail, name, sub, username, (claims.given_name ?? '').slice(0, 80), (claims.family_name ?? '').slice(0, 80), (email ?? '').slice(0, 200)],
            c,
          ))!;
          await audit(ctxFor(u.name, u.id, u.email), { action: 'user.created', entityType: 'user', entityId: u.id, summary: `Created ${u.name} on their first HackSpaceLabs sign-in (${label}), with no roles or projects` }, c);
          return u;
        });
      } catch (e: any) {
        // Two first sign-ins at once: the other one won; use its account.
        user = await one<UserRow>(`select ${USER_COLS} from users where hsl_sub = $1`, [sub]);
        if (!user) {
          req.log.warn({ err: e?.message }, 'hsl account creation failed');
          return fail(reply, 'hsl_failed');
        }
      }
    }

    if (user.kind !== 'human') return refuse('hsl_failed', 'not a person account', user);
    if (!user.is_active) return refuse('hsl_disabled', 'account deactivated', user);
    if (user.hsl_sub && user.hsl_sub !== sub) return refuse('hsl_mismatch', 'a different HackSpaceLabs account is linked', user);
    if (!user.hsl_sub) await linkTo(user, how);
    else if (username && user.hsl_username !== username) await q(`update users set hsl_username = $2 where id = $1`, [user.id, username]).catch(() => undefined);

    const s = await createSession(user.id, req.ip, req.headers['user-agent'] ?? null, st.remember);
    await q(`update users set last_login_at = now() where id = $1`, [user.id]);
    await audit(ctxFor(user.name, user.id, user.email), { action: 'auth.login', entityType: 'user', entityId: user.id, summary: `${user.name} signed in with HackSpaceLabs` });
    setSessionCookie(reply, s.token, s.expires, s.remember);
    return reply.redirect(st.next_path);
  });
}
