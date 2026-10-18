import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { hasGlobal, hashPassword, randomToken, requireGlobal, requireUser, validatePassword, type Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { GLOBAL_PERMISSIONS, isKnownPermission, PROJECT_PERMISSIONS } from '../permissions.js';
import { setMember } from '../services/projects.js';
import { parse } from '../validate.js';
import { issueToken, listTokens, revokeToken, tokenInput } from './auth.js';

const USER_SELECT = `
  select u.id, u.email, u.name, u.kind, u.is_active, u.must_change_password, u.last_login_at, u.created_at, u.updated_at,
         coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name) order by r.name) from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id), '[]') as global_roles,
         coalesce((select json_agg(json_build_object('project_id', p.id, 'project_key', p.key, 'project_name', p.name, 'role_id', r.id, 'role_name', r.name) order by p.name)
                     from project_members m join projects p on p.id = m.project_id join roles r on r.id = m.role_id where m.user_id = u.id), '[]') as projects,
         (select count(*) from api_tokens t where t.user_id = u.id and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())) as active_tokens,
         (select count(*) from sessions s where s.user_id = u.id and s.expires_at > now()) as active_sessions
    from users u`;

/** Number of active humans who would still hold admin.users after excluding the given user. */
async function otherUserAdmins(userId: string, db: Db) {
  return (await one<{ n: number }>(
    `select count(distinct u.id) as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
      where u.is_active and u.kind = 'human' and u.id <> $1 and 'admin.users' = any(r.permissions)`,
    [userId],
    db,
  ))!.n;
}

const userCreate = z.object({
  email: z.string().trim().email().max(200),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['human', 'service']).default('human'),
  password: z.string().max(200).optional(),
  must_change_password: z.boolean().default(true),
  global_role_ids: z.array(z.string().uuid()).default([]),
  projects: z.array(z.object({ project_id: z.string().uuid(), role_id: z.string().uuid() })).default([]),
});

const userPatch = z.object({
  email: z.string().trim().email().max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  global_role_ids: z.array(z.string().uuid()).optional(),
});

async function roleNames(ids: string[], db: Db) {
  if (!ids.length) return [];
  const rows = await q<{ id: string; name: string }>(`select id, name from roles where id = any($1) and scope = 'global'`, [ids], db);
  if (rows.length !== new Set(ids).size) throw badRequest('Unknown global role');
  return rows.map((r) => r.name).sort();
}

const roleInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  scope: z.enum(['global', 'project']),
  permissions: z.array(z.string()).max(50),
});

export default async function adminRoutes(app: FastifyInstance) {
  app.get('/api/permissions', async (req) => {
    requireUser(req);
    return { global: GLOBAL_PERMISSIONS, project: PROJECT_PERMISSIONS };
  });

  // ---------- Roles ----------
  app.get('/api/roles', async (req) => {
    requireUser(req);
    return q(
      `select r.id, r.name, r.description, r.scope, r.permissions, r.is_builtin, r.updated_at,
              (select count(*) from user_roles ur where ur.role_id = r.id) + (select count(*) from project_members m where m.role_id = r.id) as assignments
         from roles r order by r.scope, r.is_builtin desc, r.name`,
    );
  });

  app.post('/api/admin/roles', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.roles');
    const body = parse(roleInput, req.body);
    const bad = body.permissions.filter((p) => !isKnownPermission(body.scope, p));
    if (bad.length) throw badRequest(`Unknown ${body.scope} permissions: ${bad.join(', ')}`);
    const r = await tx(async (c) => {
      const r = await one(`insert into roles (name, description, scope, permissions) values ($1, $2, $3, $4) returning *`, [body.name, body.description, body.scope, [...new Set(body.permissions)]], c).catch((e) => {
        if (e.code === '23505') throw conflict(`A ${body.scope} role named "${body.name}" already exists`);
        throw e;
      });
      await audit(ctx, { action: 'role.created', entityType: 'role', entityId: r.id, summary: `Created ${body.scope} role "${body.name}"`, changes: { permissions: r.permissions } }, c);
      return r;
    });
    return r;
  });

  app.patch('/api/admin/roles/:id', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.roles');
    const id = (req.params as any).id;
    const body = parse(roleInput.omit({ scope: true }).partial(), req.body);
    return tx(async (c) => {
      const before = await one(`select * from roles where id = $1`, [id], c);
      if (!before) throw notFound('Role not found');
      if (before.is_builtin && before.scope === 'global' && before.name === 'Administrator') throw badRequest('The Administrator role cannot be changed');
      if (before.is_builtin && body.name && body.name !== before.name) throw badRequest('Built-in roles cannot be renamed');
      if (body.permissions) {
        const bad = body.permissions.filter((p) => !isKnownPermission(before.scope, p));
        if (bad.length) throw badRequest(`Unknown ${before.scope} permissions: ${bad.join(', ')}`);
      }
      const after = await one(
        `update roles set name = coalesce($2, name), description = coalesce($3, description), permissions = coalesce($4, permissions), updated_at = now() where id = $1 returning *`,
        [id, body.name ?? null, body.description ?? null, body.permissions ? [...new Set(body.permissions)] : null],
        c,
      ).catch((e) => {
        if (e.code === '23505') throw conflict(`A role named "${body.name}" already exists`);
        throw e;
      });
      if (before.scope === 'global' && before.permissions.includes('admin.users') && !after.permissions.includes('admin.users')) {
        const left = await one<{ n: number }>(
          `select count(distinct u.id) as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.is_active and u.kind = 'human' and 'admin.users' = any(r.permissions)`,
          [],
          c,
        );
        if (!left?.n) throw badRequest('That would leave nobody able to manage users');
      }
      const added = after.permissions.filter((p: string) => !before.permissions.includes(p));
      const removed = before.permissions.filter((p: string) => !after.permissions.includes(p));
      const parts = [added.length && `granted ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`, before.name !== after.name && `renamed from "${before.name}"`, before.description !== after.description && 'edited description'].filter(Boolean);
      if (parts.length) await audit(ctx, { action: 'role.updated', entityType: 'role', entityId: id, summary: `Role "${after.name}": ${parts.join('; ')}`, changes: { added, removed } }, c);
      return after;
    });
  });

  app.delete('/api/admin/roles/:id', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.roles');
    const id = (req.params as any).id;
    await tx(async (c) => {
      const r = await one(`select * from roles where id = $1`, [id], c);
      if (!r) throw notFound('Role not found');
      if (r.is_builtin) throw badRequest('Built-in roles cannot be deleted');
      const used = await one<{ n: number }>(`select (select count(*) from user_roles where role_id = $1) + (select count(*) from project_members where role_id = $1) as n`, [id], c);
      if (used!.n > 0) throw badRequest(`Role is assigned ${used!.n} time(s); reassign those first`);
      await c.query(`delete from roles where id = $1`, [id]);
      await audit(ctx, { action: 'role.deleted', entityType: 'role', entityId: id, summary: `Deleted ${r.scope} role "${r.name}"` }, c);
    });
    return { ok: true };
  });

  // ---------- Users ----------
  app.get('/api/admin/users', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    return q(`${USER_SELECT} order by u.kind, u.is_active desc, u.name`);
  });

  // Lightweight directory any signed-in user can read (for assigning cards and adding members).
  app.get('/api/users/directory', async (req) => {
    requireUser(req);
    return q(`select id, name, email, kind from users where is_active order by name`);
  });

  app.get('/api/admin/users/:id', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const u = await one(`${USER_SELECT} where u.id = $1`, [(req.params as any).id]);
    if (!u) throw notFound('User not found');
    const sessions = await q(`select id, created_at, last_seen_at, expires_at, ip, user_agent from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`, [u.id]);
    return { ...u, sessions: sessions.map((s) => ({ ...s, id: s.id.slice(0, 12) })) };
  });

  app.post('/api/admin/users', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const body = parse(userCreate, req.body);
    let password = body.password;
    let generated = false;
    if (body.kind === 'human') {
      if (!password) {
        password = randomToken(12);
        generated = true;
      }
      const problem = validatePassword(password);
      if (problem) throw badRequest(problem);
    } else password = undefined;
    const id = await tx(async (c) => {
      const exists = await one(`select 1 from users where lower(email) = lower($1)`, [body.email], c);
      if (exists) throw conflict('A user with that email already exists');
      const names = await roleNames(body.global_role_ids, c);
      const u = (await one<{ id: string }>(
        `insert into users (email, name, kind, password_hash, must_change_password) values ($1, $2, $3, $4, $5) returning id`,
        [body.email, body.name, body.kind, password ? await hashPassword(password) : null, body.kind === 'human' ? body.must_change_password : false],
        c,
      ))!;
      for (const r of body.global_role_ids) await c.query(`insert into user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [u.id, r]);
      await audit(ctx, { action: 'user.created', entityType: 'user', entityId: u.id, summary: `Created ${body.kind === 'service' ? 'service account' : 'user'} ${body.name} <${body.email}>${names.length ? ` with ${names.join(', ')}` : ''}` }, c);
      return u.id;
    });
    for (const p of body.projects) await setMember(ctx, p.project_id, id, p.role_id);
    const u = await one(`${USER_SELECT} where u.id = $1`, [id]);
    return { ...u, temporary_password: generated ? password : undefined };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const id = (req.params as any).id;
    const body = parse(userPatch, req.body);
    await tx(async (c) => {
      const before = await one(`select * from users where id = $1`, [id], c);
      if (!before) throw notFound('User not found');
      if (body.is_active === false && id === ctx.user.id) throw badRequest('You cannot deactivate yourself');
      const beforeRoles = await q<{ id: string; name: string }>(`select r.id, r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`, [id], c);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (body.email && body.email.toLowerCase() !== before.email.toLowerCase()) {
        const exists = await one(`select 1 from users where lower(email) = lower($1) and id <> $2`, [body.email, id], c);
        if (exists) throw conflict('A user with that email already exists');
      }
      for (const k of ['email', 'name', 'is_active'] as const) {
        if (body[k] !== undefined && body[k] !== before[k]) changes[k] = { from: before[k], to: body[k] };
      }
      await c.query(`update users set email = coalesce($2, email), name = coalesce($3, name), is_active = coalesce($4, is_active), updated_at = now() where id = $1`, [id, body.email ?? null, body.name ?? null, body.is_active ?? null]);
      if (body.is_active === false) {
        await c.query(`delete from sessions where user_id = $1`, [id]);
      }
      if (body.global_role_ids) {
        const after = await roleNames(body.global_role_ids, c);
        const prev = beforeRoles.map((r) => r.name).sort();
        if (JSON.stringify(prev) !== JSON.stringify(after)) {
          await c.query(`delete from user_roles where user_id = $1`, [id]);
          for (const r of body.global_role_ids) await c.query(`insert into user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [id, r]);
          changes.global_roles = { from: prev, to: after };
        }
      }
      // Never leave the system without someone who can manage users.
      const stillAdmin = await one(`select 1 from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.id = $1 and u.is_active and 'admin.users' = any(r.permissions)`, [id], c);
      const wasAdmin = beforeRoles.length && (await one(`select 1 from roles where id = any($1) and 'admin.users' = any(permissions)`, [beforeRoles.map((r) => r.id)], c));
      if (wasAdmin && before.is_active && !stillAdmin && (await otherUserAdmins(id, c)) === 0) throw badRequest('That would leave nobody able to manage users');
      if (Object.keys(changes).length) {
        const what = Object.entries(changes).map(([k, v]) => (k === 'is_active' ? (v.to ? 'reactivated' : 'deactivated') : k === 'global_roles' ? `roles now ${(v.to as string[]).join(', ') || 'none'}` : `${k} changed`));
        await audit(ctx, { action: 'user.updated', entityType: 'user', entityId: id, summary: `Updated ${before.name}: ${what.join('; ')}`, changes }, c);
      }
    });
    return one(`${USER_SELECT} where u.id = $1`, [id]);
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const id = (req.params as any).id;
    const body = parse(z.object({ password: z.string().max(200).optional(), must_change_password: z.boolean().default(true) }), req.body);
    const u = await one(`select id, name, kind from users where id = $1`, [id]);
    if (!u) throw notFound('User not found');
    if (u.kind !== 'human') throw badRequest('Service accounts sign in with API tokens, not passwords');
    const password = body.password || randomToken(12);
    const problem = validatePassword(password);
    if (problem) throw badRequest(problem);
    await tx(async (c) => {
      await c.query(`update users set password_hash = $2, must_change_password = $3, updated_at = now() where id = $1`, [id, await hashPassword(password), body.must_change_password]);
      await c.query(`delete from sessions where user_id = $1`, [id]);
      await audit(ctx, { action: 'user.password_reset', entityType: 'user', entityId: id, summary: `Reset ${u.name}'s password and signed them out everywhere` }, c);
    });
    return { temporary_password: body.password ? undefined : password };
  });

  app.post('/api/admin/users/:id/revoke-sessions', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const id = (req.params as any).id;
    const u = await one(`select name from users where id = $1`, [id]);
    if (!u) throw notFound('User not found');
    const r = await q(`delete from sessions where user_id = $1 returning id`, [id]);
    await audit(ctx, { action: 'user.sessions_revoked', entityType: 'user', entityId: id, summary: `Signed ${u.name} out of ${r.length} session(s)` });
    return { revoked: r.length };
  });

  app.put('/api/admin/users/:id/projects/:projectId', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.users');
    const { id, projectId } = req.params as any;
    const body = parse(z.object({ role_id: z.string().uuid().nullable() }), req.body);
    // Admins with admin.users can manage memberships on any project.
    await setMember({ ...ctx, global: new Set([...ctx.global, 'projects.all']), projectPerms: new Map() }, projectId, id, body.role_id);
    return one(`${USER_SELECT} where u.id = $1`, [id]);
  });

  // ---------- Tokens (admin) ----------
  const canTokens = (ctx: Ctx, userId: string) => {
    if (userId !== ctx.user.id && !hasGlobal(ctx, 'admin.tokens')) throw forbidden();
  };

  app.get('/api/admin/users/:id/tokens', async (req) => {
    const ctx = requireUser(req);
    canTokens(ctx, (req.params as any).id);
    return listTokens((req.params as any).id);
  });

  app.post('/api/admin/users/:id/tokens', async (req) => {
    const ctx = requireUser(req);
    const id = (req.params as any).id;
    canTokens(ctx, id);
    if (ctx.tokenId) throw badRequest('Create tokens from the web app, not with another token');
    const u = await one(`select id, is_active from users where id = $1`, [id]);
    if (!u) throw notFound('User not found');
    if (!u.is_active) throw badRequest('User is deactivated');
    return issueToken(ctx, id, parse(tokenInput, req.body));
  });

  app.delete('/api/admin/users/:id/tokens/:tokenId', async (req) => {
    const ctx = requireUser(req);
    const { id, tokenId } = req.params as any;
    canTokens(ctx, id);
    await revokeToken(ctx, id, tokenId);
    return { ok: true };
  });

  // ---------- Audit ----------
  app.get('/api/admin/audit', async (req) => {
    const ctx = requireUser(req);
    requireGlobal(ctx, 'admin.audit');
    return queryAudit(req.query as any);
  });
}

export async function queryAudit(f: { actor_id?: string; project_id?: string; action?: string; entity_type?: string; entity_id?: string; via?: string; q?: string; before_id?: string; from?: string; to?: string; limit?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (f.actor_id) add('a.actor_id = ?', f.actor_id);
  if (f.project_id) add('a.project_id = ?', f.project_id);
  if (f.action) add(f.action.endsWith('.') ? 'a.action like ? || \'%\'' : 'a.action = ?', f.action);
  if (f.entity_type) add('a.entity_type = ?', f.entity_type);
  if (f.entity_id) add('a.entity_id = ?', f.entity_id);
  if (f.via) add('a.via = ?', f.via);
  if (f.from) add('a.at >= ?::timestamptz', f.from);
  if (f.to) add('a.at < ?::timestamptz', f.to);
  if (f.q) add(`(a.summary ilike '%' || ? || '%' or a.actor_name ilike '%' || ? || '%')`, f.q);
  if (f.before_id) add('a.id < ?', Number(f.before_id));
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  params.push(limit + 1);
  const rows = await q(
    `select a.id, a.at, a.actor_id, a.actor_name, a.via, a.ip, a.action, a.entity_type, a.entity_id, a.project_id, p.key as project_key, a.summary, a.changes,
            t.name as token_name
       from audit_log a left join projects p on p.id = a.project_id left join api_tokens t on t.id = a.token_id
      ${where.length ? `where ${where.join(' and ')}` : ''} order by a.id desc limit $${params.length}`,
    params,
  );
  return { items: rows.slice(0, limit), next_before_id: rows.length > limit ? rows[limit - 1].id : null };
}
