import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { one, q, type Db } from './db.js';
import { forbidden, notFound, unauthorized } from './errors.js';
import { recheckSession, tokenOwnerAllowed } from './hsl.js';
import { PROJECT_PERMISSIONS, type GlobalPermission, type ProjectPermission } from './permissions.js';

export const SESSION_COOKIE = 'hsl_session';
export const CSRF_HEADER = 'x-hsl-csrf';

export type Via = 'web' | 'api' | 'mcp' | 'import' | 'system';

export type CtxUser = { id: string; email: string; name: string; kind: 'human' | 'service'; must_change_password: boolean };

export type Ctx = {
  user: CtxUser;
  tokenId: string | null;
  sessionId: string | null;
  via: Via;
  ip: string | null;
  global: Set<string>;
  projectPerms: Map<string, Set<string>>;
  /** How a cookie session was signed in: 'oidc' is Sign in with HackSpaceLabs. */
  authSource?: 'local' | 'oidc';
};

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx | null;
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 200) return 'Password is too long';
  return null;
}

async function loadGlobalPerms(userId: string, db?: Db): Promise<Set<string>> {
  const rows = await q<{ p: string }>(
    `select distinct unnest(r.permissions) as p from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`,
    [userId],
    db,
  );
  return new Set(rows.map((r) => r.p));
}

export async function buildCtx(user: CtxUser, opts: { via: Via; ip: string | null; tokenId?: string | null; sessionId?: string | null }): Promise<Ctx> {
  return {
    user,
    via: opts.via,
    ip: opts.ip,
    tokenId: opts.tokenId ?? null,
    sessionId: opts.sessionId ?? null,
    global: await loadGlobalPerms(user.id),
    projectPerms: new Map(),
  };
}

const userCols = 'u.id, u.email, u.name, u.kind, u.must_change_password';

/** A password or Google sign-in: 96 hours, or 30 days with "Remember me" (both extended on activity). */
export async function createSession(userId: string, ip: string | null, ua: string | null, remember = true) {
  const token = randomToken();
  const expires = new Date(Date.now() + (remember ? config.rememberDays * 86400_000 : config.sessionHours * 3600_000));
  await q(`insert into sessions (id, user_id, expires_at, ip, user_agent, remember) values ($1, $2, $3, $4, $5, $6)`, [sha256(token), userId, expires, ip, ua?.slice(0, 300) ?? null, remember]);
  return { token, expires, remember };
}

/** A HackSpaceLabs sign-in: lasts as long as the Keycloak session (never extended by activity). */
export async function createHslSession(userId: string, ip: string | null, ua: string | null, seconds: number, idpSid: string | null, sealed: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + seconds * 1000);
  await q(
    `insert into sessions (id, user_id, expires_at, ip, user_agent, remember, auth_source, idp_sid, idp_tokens, idp_checked_at)
     values ($1, $2, $3, $4, $5, true, 'oidc', $6, $7, now())`,
    [sha256(token), userId, expires, ip, ua?.slice(0, 300) ?? null, idpSid, sealed],
  );
  return { token, expires };
}

/** The cookie always carries an expiry: the session's, set once at sign-in. */
export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires, maxAge });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

// API tokens look like hsl_<8 char prefix>_<secret>.
export function newApiToken() {
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const token = `hsl_${prefix}_${randomToken(32)}`;
  return { token, prefix, hash: sha256(token) };
}

/**
 * Resolve the caller from a bearer token or the session cookie. Sets req.ctx (or null). A HackSpaceLabs
 * session is rechecked with Keycloak when due; if that ends it, the cookie is cleared (given a reply).
 */
export async function authenticate(req: FastifyRequest, via: Via = 'web', reply?: FastifyReply) {
  req.ctx = null;
  const ip = req.ip ?? null;
  const authz = req.headers.authorization;
  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    const row = await one<CtxUser & { token_id: string; hsl_sub: string | null }>(
      `select ${userCols}, u.hsl_sub, t.id as token_id from api_tokens t join users u on u.id = t.user_id
        where t.token_hash = $1 and t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) and u.is_active`,
      [sha256(token)],
    );
    if (!row) throw unauthorized('Invalid or expired API token');
    // Owners tied to HackSpaceLabs must still be enabled there and hold a Harbor Master role (D18).
    if (!(await tokenOwnerAllowed(row.hsl_sub))) throw unauthorized('Invalid or expired API token');
    q(`update api_tokens set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [row.token_id]).catch(() => {});
    const { token_id, hsl_sub, ...user } = row;
    req.ctx = await buildCtx(user, { via: via === 'web' ? 'api' : via, ip, tokenId: token_id });
    return;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (!cookie) return;
  const sid = sha256(cookie);
  const row = await one<CtxUser & { last_seen_at: Date; auth_source: 'local' | 'oidc'; idp_tokens: string | null; idp_checked_at: Date | null; hsl_sub: string | null }>(
    `select ${userCols}, u.hsl_sub, s.last_seen_at, s.auth_source, s.idp_tokens, s.idp_checked_at from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.expires_at > now() and u.is_active`,
    [sid],
  );
  if (!row) return;
  const { last_seen_at, auth_source, idp_tokens, idp_checked_at, hsl_sub, ...user } = row;
  if (auth_source === 'oidc') {
    const r = await recheckSession({ sid, userId: user.id, name: user.name, email: user.email, hslSub: hsl_sub, sealed: idp_tokens, checkedAt: idp_checked_at, ip });
    if (r === 'ended') {
      if (reply) clearSessionCookie(reply);
      return;
    }
    // Forced steps belong to local accounts: someone signed in through HackSpaceLabs can't change a password here.
    user.must_change_password = false;
  }
  if (Date.now() - new Date(last_seen_at).getTime() > 5 * 60_000) {
    // Local sessions are extended on activity; HackSpaceLabs sessions end when Keycloak's does.
    q(
      `update sessions set last_seen_at = now(),
              expires_at = case when auth_source = 'oidc' then expires_at
                                when remember then now() + make_interval(days => $2)
                                else now() + make_interval(hours => $3) end
        where id = $1`,
      [sid, config.rememberDays, config.sessionHours],
    ).catch(() => {});
  }
  req.ctx = await buildCtx(user, { via: 'web', ip, sessionId: sid });
  req.ctx.authSource = auth_source;
  // Cookie-authenticated writes must carry the custom CSRF header (cross-site forms cannot set it).
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== '1') {
    throw forbidden('Missing CSRF header');
  }
}

/**
 * For long-lived requests (the live-update stream): is the caller who connected still signed in?
 * Re-resolves the same cookie or token, which runs the HackSpaceLabs recheck when it is due.
 */
export async function stillSignedIn(req: FastifyRequest): Promise<boolean> {
  const before = req.ctx;
  if (!before) return false;
  try {
    await authenticate(req, before.via === 'mcp' ? 'mcp' : 'web');
  } catch {
    req.ctx = before;
    return false;
  }
  const ok = !!req.ctx && req.ctx.user.id === before.user.id;
  req.ctx = before;
  return ok;
}

export function requireUser(req: FastifyRequest): Ctx {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

export function hasGlobal(ctx: Ctx, perm: GlobalPermission) {
  return ctx.global.has(perm);
}

export function requireGlobal(ctx: Ctx, perm: GlobalPermission) {
  if (!ctx.global.has(perm)) throw forbidden();
}

export async function getProjectPerms(ctx: Ctx, projectId: string, db?: Db): Promise<Set<string>> {
  const cached = ctx.projectPerms.get(projectId);
  if (cached) return cached;
  let perms: Set<string>;
  if (ctx.global.has('projects.all')) {
    perms = new Set(Object.keys(PROJECT_PERMISSIONS));
  } else {
    const row = await one<{ permissions: string[] }>(
      `select r.permissions from project_members m join roles r on r.id = m.role_id where m.project_id = $1 and m.user_id = $2`,
      [projectId, ctx.user.id],
      db,
    );
    perms = new Set(row?.permissions ?? []);
  }
  ctx.projectPerms.set(projectId, perms);
  return perms;
}

/** Throws 404 when the caller cannot even see the project, 403 when they lack the specific permission. */
export async function requireProject(ctx: Ctx, projectId: string, perm: ProjectPermission, db?: Db) {
  const perms = await getProjectPerms(ctx, projectId, db);
  if (!perms.has('project.view')) throw notFound('Project not found');
  if (!perms.has(perm)) throw forbidden();
  return perms;
}

export function systemCtx(): Ctx {
  return {
    user: { id: '00000000-0000-0000-0000-000000000000', email: 'system', name: 'System', kind: 'service', must_change_password: false },
    tokenId: null,
    sessionId: null,
    via: 'system',
    ip: null,
    global: new Set(['projects.all']),
    projectPerms: new Map(),
  };
}
