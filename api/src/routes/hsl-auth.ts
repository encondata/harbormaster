// "Sign in with HackSpaceLabs": OpenID Connect against the HSL Keycloak realm (authorization code flow
// with PKCE, state and nonce; ID token checked against the realm's keys). The contract is section 5 of
// the HSL Suite plan; the client itself is in ../hslsso.ts and the recheck in ../hsl.ts.
//
// Who gets in:
// - Only people whose HackSpaceLabs account holds a Harbor Master role (`member` or `admin` on the
//   `harbormaster` client). Anyone else (a portal customer, say) is turned away and nothing is created.
// - An account already linked to the HSL account (by its stable `sub`) signs in.
// - Otherwise the first HSL sign-in links to an account when an administrator set that account's HSL
//   username, or when Keycloak vouches for the email (email_verified) and it matches.
// - Signed-in people can link their own account from the Account page.
// - Anyone else gets a new account with no projects. HSL does not verify email addresses, so an
//   unverified email is never used as the account email (it would let someone claim another person's
//   Google sign-in or block their address); it goes into the contact email instead.
// Once linked, an account signs in only with HackSpaceLabs (D16): password and Google sign-in refuse it.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { createHslSession, requireUser, setSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { applyHslRole, HSL_ROLES, hslEnabled, ownerCheck, sealFor, sessionSeconds, sso, stateHash, userCtx } from '../hsl.js';
import { knownRoles, newFlow, SsoError, type Tokens } from '../hslsso.js';
import { safeNext, type IdClaims } from '../oidc.js';

// The cookie binding a sign-in attempt to this browser (plan 5.4 step 3). Each attempt gets its own name,
// so several tabs signing in at once don't overwrite each other; the name differs from the other apps'
// because on a LAN they share one address and cookies ignore ports.
const FLOW_PATH = '/api/auth/hsl/';
const flowCookie = (state: string) => `hsl_oidc_${stateHash(state).slice(0, 8)}`;
const flowCookieOpts = { path: FLOW_PATH, httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSecure };

function fail(reply: FastifyReply, code: string, extra: Record<string, string> = {}) {
  return reply.redirect(`/login?${new URLSearchParams({ error: code, ...extra })}`, 303);
}
function failLink(reply: FastifyReply, code: string) {
  return reply.redirect(`/account?${new URLSearchParams({ hsl: code })}`, 303);
}

/** The flow cookie must be set on the host Keycloak returns to. Host names only: cookies ignore ports. */
const onPublicHost = (req: FastifyRequest) => req.hostname.toLowerCase() === new URL(config.publicUrl).hostname.toLowerCase();

type UserRow = { id: string; name: string; email: string; is_active: boolean; kind: string; hsl_sub: string | null; hsl_username: string | null };
const USER_COLS = 'id, name, email, is_active, kind, hsl_sub, hsl_username';

/** Starts a sign-in (or link) attempt: stores the flow, sets the flow cookie, returns Keycloak's address. */
async function begin(reply: FastifyReply, opts: { next: string; linkUserId?: string; prompt?: 'login' }) {
  const flow = newFlow();
  const url = await sso!.authUrl(flow, { prompt: opts.prompt });
  await q(`delete from oauth_states where expires_at < now()`);
  await q(
    `insert into oauth_states (id, provider, nonce, code_verifier, next_path, remember, link_user_id, expires_at)
     values ($1, 'hsl', $2, $3, $4, true, $5, now() + interval '10 minutes')`,
    [stateHash(flow.state), flow.nonce, flow.verifier, opts.next, opts.linkUserId ?? null],
  );
  reply.setCookie(flowCookie(flow.state), flow.state, { ...flowCookieOpts, maxAge: 600 });
  return url;
}

/**
 * Linking this person would leave no active Administrator who can still sign in with a password, the
 * way in when Keycloak is down (D16). Every server keeps one unlinked local administrator.
 */
async function isLastLocalAdmin(userId: string, db?: Db) {
  const local = `u.is_active and u.kind = 'human' and u.password_hash is not null and u.hsl_sub is null and 'admin.users' = any(r.permissions)`;
  const me = await one(`select 1 from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.id = $1 and ${local}`, [userId], db);
  if (!me) return false;
  const others = await one<{ n: number }>(
    `select count(distinct u.id)::int as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.id <> $1 and ${local}`,
    [userId],
    db,
  );
  return (others?.n ?? 0) === 0;
}

const displayName = (c: IdClaims) =>
  (c.name?.trim() || [c.given_name, c.family_name].filter(Boolean).join(' ').trim() || c.preferred_username || 'HackSpaceLabs user').slice(0, 120);

export default async function hslAuthRoutes(app: FastifyInstance) {
  const limited = { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } };

  app.get('/api/auth/hsl/start', limited, async (req, reply) => {
    if (!hslEnabled()) return fail(reply, 'hsl_off');
    if (!onPublicHost(req)) return reply.redirect(`${config.publicUrl}${req.url}`, 303);
    const f = req.query as Record<string, string | undefined>;
    try {
      return reply.redirect(await begin(reply, { next: safeNext(f.next), prompt: f.prompt === 'login' ? 'login' : undefined }), 303);
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'HackSpaceLabs sign-in could not start');
      return fail(reply, e instanceof SsoError && e.kind === 'unavailable' ? 'hsl_unavailable' : 'hsl_failed');
    }
  });

  // Link the signed-in person's account. A POST (CSRF-checked) so another site can't start it.
  app.post('/api/auth/hsl/link', limited, async (req, reply) => {
    const ctx = requireUser(req);
    if (!hslEnabled()) throw badRequest("HackSpaceLabs sign-in isn't set up on this server");
    if (ctx.via !== 'web' || ctx.user.kind !== 'human') throw badRequest('Only people signed in to the web app can link a HackSpaceLabs account');
    if (!onPublicHost(req)) throw badRequest(`Open Harbor Master at ${config.publicUrl} to link a HackSpaceLabs account`);
    if (await isLastLocalAdmin(ctx.user.id)) {
      throw badRequest("You're the last administrator who can sign in with a password. Make another one first: this server needs one that works when HackSpaceLabs is down.");
    }
    try {
      return { url: await begin(reply, { next: '/account?hsl=linked', linkUserId: ctx.user.id }) };
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'HackSpaceLabs link could not start');
      throw badRequest("HackSpaceLabs sign-in can't be reached right now. Try again later.");
    }
  });

  // Unlink your own HSL account, if you still have another way to sign in.
  app.post('/api/auth/hsl/unlink', async (req) => {
    const ctx = requireUser(req);
    const u = await one<{ name: string; has_other: boolean; hsl_sub: string }>(
      `select name, hsl_sub, (password_hash is not null or google_sub is not null) as has_other from users where id = $1 and hsl_sub is not null`,
      [ctx.user.id],
    );
    if (!u) throw notFound('No HackSpaceLabs account is linked');
    if (!u.has_other) throw badRequest('Set a password first: HackSpaceLabs is your only way to sign in');
    await q(`update users set hsl_sub = null, hsl_username = null, updated_at = now() where id = $1`, [ctx.user.id]);
    ownerCheck?.forget(u.hsl_sub);
    await audit(ctx, { action: 'user.hsl_unlinked', entityType: 'user', entityId: ctx.user.id, summary: `${u.name} unlinked their HackSpaceLabs account` });
    return { ok: true };
  });

  app.get('/api/auth/hsl/callback', limited, async (req, reply) => {
    if (!hslEnabled()) return fail(reply, 'hsl_off');
    const f = req.query as Record<string, string | undefined>;
    // The attempt must belong to this browser: its flow cookie holds the state.
    let bound = false;
    if (f.state) {
      const name = flowCookie(f.state);
      const c = req.cookies?.[name];
      if (c) {
        bound = c.length === f.state.length && timingSafeEqual(Buffer.from(c), Buffer.from(f.state));
        reply.clearCookie(name, flowCookieOpts);
      }
    }
    const st = bound
      ? await one<{ nonce: string; code_verifier: string; next_path: string; link_user_id: string | null }>(
        `delete from oauth_states where id = $1 and provider = 'hsl' and expires_at > now() returning nonce, code_verifier, next_path, link_user_id`,
        [stateHash(f.state!)],
      )
      : undefined;
    if (!st) {
      // Another tab may have finished signing in already.
      if (req.ctx?.sessionId) return reply.redirect('/', 303);
      return fail(reply, 'hsl_expired');
    }
    const bail = (code: string) => (st.link_user_id ? failLink(reply, code) : fail(reply, code));
    if (f.error) return bail(f.error === 'access_denied' ? 'hsl_cancelled' : 'hsl_failed');
    if (!f.code) return bail('hsl_failed');

    let tokens: Tokens;
    try {
      tokens = await sso!.exchange(f.code, { state: f.state!, nonce: st.nonce, verifier: st.code_verifier });
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'HackSpaceLabs sign-in failed');
      return bail(e instanceof SsoError && e.kind === 'unavailable' ? 'hsl_unavailable' : 'hsl_failed');
    }
    const claims = tokens.claims;
    const sub = claims.sub;
    const username = (claims.preferred_username ?? '').trim().slice(0, 255) || null;
    const email = (claims.email ?? '').trim().toLowerCase() || null;
    const emailVerified = !!email && claims.email_verified === true;
    const label = username ?? email ?? sub;
    const anon = (name: string, id: string | null, userEmail = email ?? '') => userCtx({ id: id ?? '00000000-0000-0000-0000-000000000000', name, email: userEmail }, req.ip);
    const refuse = async (code: string, why: string, u?: UserRow) => {
      req.log.warn({ user: u?.name ?? label, reason: why }, 'HackSpaceLabs sign-in refused');
      await audit(anon(u?.name ?? label, u?.id ?? null), { action: 'auth.login_failed', entityType: 'user', entityId: u?.id, summary: `HackSpaceLabs sign-in refused for ${u?.name ?? label}: ${why}` });
      return bail(code);
    };

    // No Harbor Master role on the HackSpaceLabs account (a missing claim is no role): stop here and
    // create nothing.
    const roles = knownRoles(claims.hsl_roles, HSL_ROLES);
    if (!roles.length) return refuse('hsl_no_access', 'no Harbor Master role in HackSpaceLabs');

    const linkTo = async (u: UserRow, how: string) => {
      await tx(async (c) => {
        // A username an administrator reserved on a different, unlinked account moves to this one.
        if (username) await c.query(`update users set hsl_username = null where lower(hsl_username) = lower($1) and id <> $2 and hsl_sub is null`, [username, u.id]);
        await c.query(`update users set hsl_sub = $2, hsl_username = $3, updated_at = now() where id = $1`, [u.id, sub, username]);
        // From now on this account signs in only with HackSpaceLabs, so its other sessions end.
        await c.query(`delete from sessions where user_id = $1 and auth_source = 'local'`, [u.id]);
        await audit(anon(u.name, u.id, u.email), { action: 'user.hsl_linked', entityType: 'user', entityId: u.id, summary: `Linked ${u.name} to the HackSpaceLabs account ${label} (${how})` }, c);
      });
    };

    const bySub = await one<UserRow>(`select ${USER_COLS} from users where hsl_sub = $1`, [sub]);
    let user: UserRow | undefined;

    if (st.link_user_id) {
      // Linking from the Account page while signed in.
      const me = await one<UserRow>(`select ${USER_COLS} from users where id = $1`, [st.link_user_id]);
      if (!me || !me.is_active || me.kind !== 'human') return failLink(reply, 'hsl_failed');
      if (bySub && bySub.id !== me.id) return refuse('hsl_taken', `already linked to ${bySub.name}`, me);
      if (me.hsl_sub && me.hsl_sub !== sub) return refuse('hsl_mismatch', 'a different HackSpaceLabs account is linked', me);
      if (!me.hsl_sub) {
        if (await isLastLocalAdmin(me.id)) return refuse('hsl_last_admin', 'the last administrator who can sign in with a password', me);
        await linkTo(me, 'linked from their account page');
      }
      user = { ...me, hsl_sub: sub };
    } else {
      user = bySub;
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
        const accountEmail = emailVerified ? email! : `${slug}@hsl.invalid`;
        // Never invent a second address to get round a clash: that would make a duplicate account.
        if (await one(`select 1 from users where lower(email) = $1`, [accountEmail])) return refuse('hsl_account_exists', `an account already uses ${accountEmail}`);
        try {
          user = await tx(async (c) => {
            const u = (await one<UserRow>(
              `insert into users (email, name, kind, hsl_sub, hsl_username, first_name, last_name, contact_email)
               values ($1, $2, 'human', $3, $4, $5, $6, $7) returning ${USER_COLS}`,
              [accountEmail, displayName(claims), sub, username, (claims.given_name ?? '').slice(0, 80), (claims.family_name ?? '').slice(0, 80), (email ?? '').slice(0, 200)],
              c,
            ))!;
            await audit(anon(u.name, u.id, u.email), { action: 'user.created', entityType: 'user', entityId: u.id, summary: `Created ${u.name} on their first HackSpaceLabs sign-in (${label}), with no projects` }, c);
            return u;
          });
        } catch (e: any) {
          // Two first sign-ins at once: the other one won; use its account.
          user = await one<UserRow>(`select ${USER_COLS} from users where hsl_sub = $1`, [sub]);
          if (!user) {
            req.log.warn({ err: e?.message }, 'HackSpaceLabs account creation failed');
            return fail(reply, 'hsl_failed');
          }
        }
      }

      if (user.kind !== 'human') return refuse('hsl_failed', 'not a person account', user);
      if (!user.is_active) return refuse('hsl_disabled', 'account deactivated', user);
      if (user.hsl_sub && user.hsl_sub !== sub) return refuse('hsl_mismatch', 'a different HackSpaceLabs account is linked', user);
      if (!user.hsl_sub) {
        if (await isLastLocalAdmin(user.id)) return refuse('hsl_last_admin', 'the last administrator who can sign in with a password', user);
        await linkTo(user, how);
      } else if (username && user.hsl_username !== username) {
        await q(`update users set hsl_username = $2 where id = $1`, [user.id, username]).catch(() => undefined);
      }
    }

    await applyHslRole(user, roles, req.ip);
    const sealed = sealFor({ sub, refresh_token: tokens.refreshToken, id_token: tokens.idToken });
    // The session lasts as long as Keycloak's: 96 hours, or 30 days with "Remember me".
    const s = await createHslSession(user.id, req.ip, req.headers['user-agent'] ?? null, sessionSeconds(tokens), claims.sid ?? null, sealed);
    if (req.ctx?.sessionId && req.ctx.user.id === user.id) await q(`delete from sessions where id = $1`, [req.ctx.sessionId]);
    await q(`update users set last_login_at = now() where id = $1`, [user.id]);
    await audit(anon(user.name, user.id, user.email), { action: 'auth.login', entityType: 'user', entityId: user.id, summary: `${user.name} signed in with HackSpaceLabs` });
    setSessionCookie(reply, s.token, s.expires);
    return reply.redirect(st.next_path, 303);
  });
}
