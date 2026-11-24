import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import {
  clearSessionCookie, createSession, hashPassword, newApiToken, randomToken, requireUser, setSessionCookie, validatePassword, verifyPassword,
  type Ctx,
} from '../auth.js';
import { one, q } from '../db.js';
import { endSessionRedirect } from '../hsl.js';
import { badRequest, HttpError, notFound, unauthorized } from '../errors.js';
import { listProjectsFor } from '../services/projects.js';
import { parse } from '../validate.js';

// A real hash to compare against when the email is unknown, so timing does not reveal which emails exist.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken()));

export async function meView(ctx: Ctx) {
  const u = await one(`select id, email, name, kind, must_change_password, last_login_at, created_at, avatar_updated_at from users where id = $1`, [ctx.user.id]);
  const roles = await q(`select r.id, r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name`, [ctx.user.id]);
  // A HackSpaceLabs session never gets the local forced steps (ctx carries that rule).
  return {
    ...u, must_change_password: ctx.user.must_change_password, auth_source: ctx.authSource ?? (ctx.tokenId ? 'token' : 'local'),
    global_roles: roles, global_permissions: [...ctx.global], projects: await listProjectsFor(ctx),
  };
}

export const tokenInput = z.object({
  name: z.string().trim().min(1).max(80),
  expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
});

export async function issueToken(ctx: Ctx, userId: string, input: z.infer<typeof tokenInput>) {
  const t = newApiToken();
  const expires = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86400_000) : null;
  const row = (await one(
    `insert into api_tokens (user_id, name, prefix, token_hash, created_by, expires_at) values ($1, $2, $3, $4, $5, $6) returning id, name, prefix, created_at, expires_at`,
    [userId, input.name, t.prefix, t.hash, ctx.user.id, expires],
  ))!;
  const owner = await one<{ name: string }>(`select name from users where id = $1`, [userId]);
  await audit(ctx, { action: 'token.created', entityType: 'user', entityId: userId, summary: `Created API token "${input.name}" (hsl_${t.prefix}_…) for ${owner?.name}` });
  return { ...row, token: t.token };
}

export const listTokens = (userId: string) =>
  // Connector rows (OAuth) rotate a short-lived access token; what expires is the connection itself.
  q(`select t.id, t.name, t.prefix, t.created_at, t.last_used_at, coalesce(t.refresh_expires_at, t.expires_at) as expires_at, t.revoked_at,
            c.name as connector
       from api_tokens t left join oauth_clients c on c.id = t.oauth_client_id
      where t.user_id = $1 order by t.revoked_at nulls first, t.created_at desc`, [userId]);

export async function revokeToken(ctx: Ctx, userId: string, tokenId: string) {
  const row = await one(`update api_tokens set revoked_at = coalesce(revoked_at, now()) where id = $1 and user_id = $2 returning name, prefix`, [tokenId, userId]);
  if (!row) throw notFound('Token not found');
  await audit(ctx, { action: 'token.revoked', entityType: 'user', entityId: userId, summary: `Revoked API token "${row.name}" (hsl_${row.prefix}_…)` });
}

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().min(1).max(200), password: z.string().min(1).max(200), remember: z.boolean().default(true) }), req.body);
    const u = await one<{ id: string; name: string; password_hash: string | null; is_active: boolean; kind: string; hsl_sub: string | null }>(
      `select id, name, password_hash, is_active, kind, hsl_sub from users where lower(email) = lower($1)`,
      [body.email],
    );
    const ok = await verifyPassword(u?.password_hash ?? (await getDummyHash()), body.password);
    const sysCtx = (name: string, id: string | null): Ctx => ({
      user: { id: id ?? '00000000-0000-0000-0000-000000000000', email: body.email, name, kind: 'human', must_change_password: false },
      via: 'web', ip: req.ip, tokenId: null, sessionId: null, global: new Set(), projectPerms: new Map(),
    });
    if (!u || !ok || !u.is_active || u.kind !== 'human' || !u.password_hash) {
      await audit(sysCtx(u?.name ?? body.email, u?.id ?? null), {
        action: 'auth.login_failed', entityType: 'user', entityId: u?.id ?? null,
        summary: `Failed sign-in for ${body.email}${u && !u.is_active ? ' (account deactivated)' : ''}`,
      });
      throw unauthorized('Email or password is incorrect');
    }
    // An account tied to HackSpaceLabs signs in only that way (D16), or disabling someone there would not
    // lock them out. Said only now, after the password proved correct, so the form reveals nothing more.
    if (u.hsl_sub) {
      await audit(sysCtx(u.name, u.id), { action: 'auth.login_failed', entityType: 'user', entityId: u.id, summary: `Password sign-in refused for ${u.name}: the account signs in with HackSpaceLabs` });
      throw new HttpError(401, 'This account signs in with HackSpaceLabs', 'hsl_only');
    }
    const s = await createSession(u.id, req.ip, req.headers['user-agent'] ?? null, body.remember);
    await q(`update users set last_login_at = now() where id = $1`, [u.id]);
    await audit(sysCtx(u.name, u.id), { action: 'auth.login', entityType: 'user', entityId: u.id, summary: `${u.name} signed in with a password` });
    setSessionCookie(reply, s.token, s.expires);
    return { ok: true };
  });

  // A local session answers {ok: true} as before. A HackSpaceLabs session also answers with Keycloak's
  // sign-out address for the browser to open, which signs the person out of every HackSpaceLabs app.
  app.post('/api/auth/logout', async (req, reply) => {
    const ctx = req.ctx;
    let redirect: string | null = null;
    if (ctx?.sessionId) {
      const s = await one<{ auth_source: string; idp_tokens: string | null }>(`delete from sessions where id = $1 returning auth_source, idp_tokens`, [ctx.sessionId]);
      await audit(ctx, { action: 'auth.logout', entityType: 'user', entityId: ctx.user.id, summary: `${ctx.user.name} signed out` });
      if (s?.auth_source === 'oidc') redirect = await endSessionRedirect(s.idp_tokens);
    }
    clearSessionCookie(reply);
    return redirect ? { ok: true, redirect } : { ok: true };
  });

  app.get('/api/auth/me', async (req) => meView(requireUser(req)));

  app.patch('/api/auth/me', async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    if (body.name !== ctx.user.name) {
      await q(`update users set name = $2, updated_at = now() where id = $1`, [ctx.user.id, body.name]);
      await audit(ctx, { action: 'user.updated', entityType: 'user', entityId: ctx.user.id, summary: `Changed own display name to "${body.name}"`, changes: { name: { from: ctx.user.name, to: body.name } } });
    }
    return { ok: true };
  });

  app.post('/api/auth/password', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ current_password: z.string().max(200), new_password: z.string().max(200) }), req.body);
    const u = (await one<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [ctx.user.id]))!;
    if (!u.password_hash || !(await verifyPassword(u.password_hash, body.current_password))) throw badRequest('Current password is incorrect');
    const problem = validatePassword(body.new_password);
    if (problem) throw badRequest(problem);
    if (body.new_password === body.current_password) throw badRequest('Choose a different password');
    await q(`update users set password_hash = $2, must_change_password = false, password_changed_at = now(), updated_at = now() where id = $1`, [ctx.user.id, await hashPassword(body.new_password)]);
    // Sign out every other session.
    await q(`delete from sessions where user_id = $1 and id <> $2`, [ctx.user.id, ctx.sessionId ?? '']);
    await audit(ctx, { action: 'user.password_changed', entityType: 'user', entityId: ctx.user.id, summary: `${ctx.user.name} changed their password` });
    return { ok: true };
  });

  app.get('/api/me/tokens', async (req) => listTokens(requireUser(req).user.id));

  app.post('/api/me/tokens', async (req) => {
    const ctx = requireUser(req);
    if (ctx.tokenId) throw badRequest('Create tokens from the web app, not with another token');
    return issueToken(ctx, ctx.user.id, parse(tokenInput, req.body));
  });

  app.delete('/api/me/tokens/:id', async (req) => {
    const ctx = requireUser(req);
    await revokeToken(ctx, ctx.user.id, (req.params as any).id);
    return { ok: true };
  });
}
