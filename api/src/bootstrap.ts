import { audit } from './audit.js';
import { hashPassword, systemCtx, validatePassword } from './auth.js';
import { config } from './config.js';
import { one, q, tx } from './db.js';
import { BUILTIN_ROLES, GLOBAL_PERMISSIONS } from './permissions.js';
import { importWorkbook, fetchGoogleSheet, SHEET_BOARDS } from './services/import-sheet.js';
import { createBoard } from './services/projects.js';

export async function bootstrap(log: (m: string) => void) {
  const ctx = systemCtx();
  await tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(7342002)');
    for (const r of BUILTIN_ROLES) {
      await c.query(
        `insert into roles (name, scope, description, permissions, is_builtin) values ($1, $2, $3, $4, true) on conflict (scope, name) do nothing`,
        [r.name, r.scope, r.description, r.permissions],
      );
    }
    // The Administrator role always holds every global permission, so nobody can lock the system out.
    await c.query(`update roles set permissions = $1 where scope = 'global' and name = 'Administrator'`, [Object.keys(GLOBAL_PERMISSIONS)]);

    const users = (await one<{ n: number }>(`select count(*) as n from users where kind = 'human'`, [], c))!.n;
    if (users === 0) {
      if (!config.admin.email || !config.admin.password) {
        log('WARNING: no users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set; nobody can sign in yet');
      } else {
        const problem = validatePassword(config.admin.password);
        if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
        const u = (await one<{ id: string }>(
          `insert into users (email, name, password_hash) values ($1, $2, $3) returning id`,
          [config.admin.email.trim(), config.admin.name, await hashPassword(config.admin.password)],
          c,
        ))!;
        await c.query(`insert into user_roles (user_id, role_id) select $1, id from roles where scope = 'global' and name = 'Administrator'`, [u.id]);
        await audit(ctx, { action: 'user.created', entityType: 'user', entityId: u.id, summary: `Created first administrator ${config.admin.email}` }, c);
        log(`created administrator ${config.admin.email}`);
      }
    }

    // A service account for Claude. It signs in only with API tokens an admin issues.
    let claude = await one<{ id: string }>(`select id from users where kind = 'service' and lower(email) = 'claude@service.local'`, [], c);
    if (!claude) {
      claude = (await one<{ id: string }>(`insert into users (email, name, kind) values ('claude@service.local', 'Claude', 'service') returning id`, [], c))!;
      await audit(ctx, { action: 'user.created', entityType: 'user', entityId: claude.id, summary: 'Created the Claude service account' }, c);
      log('created the Claude service account');
    }

    const projects = (await one<{ n: number }>(`select count(*) as n from projects`, [], c))!.n;
    if (projects === 0) {
      const p = (await one<{ id: string }>(
        `insert into projects (key, name, description) values ('SS', 'ServerSherpa', 'ServerSherpa (BaseCamp V3) development: V2 to V3 feature parity, the build list and future features.') returning id`,
        [],
        c,
      ))!;
      await audit(ctx, { action: 'project.created', entityType: 'project', entityId: p.id, projectId: p.id, summary: 'Created project SS "ServerSherpa"' }, c);
      for (const b of SHEET_BOARDS) await createBoard(ctx, p.id, b, c);
      const owner = await one<{ id: string }>(`select id from roles where scope = 'project' and name = 'Owner'`, [], c);
      const editor = await one<{ id: string }>(`select id from roles where scope = 'project' and name = 'Editor'`, [], c);
      const admins = await q<{ id: string }>(`select ur.user_id as id from user_roles ur join roles r on r.id = ur.role_id where r.name = 'Administrator' and r.scope = 'global'`, [], c);
      for (const a of admins) await c.query(`insert into project_members (project_id, user_id, role_id) values ($1, $2, $3) on conflict do nothing`, [p.id, a.id, owner!.id]);
      await c.query(`insert into project_members (project_id, user_id, role_id) values ($1, $2, $3) on conflict do nothing`, [p.id, claude.id, editor!.id]);
      log('created the ServerSherpa project');
    }
  });

  const seedUrl = process.env.SEED_SHEET_URL;
  if (seedUrl) {
    const p = await one<{ id: string; n: number }>(`select p.id, (select count(*) from cards c where c.project_id = p.id) as n from projects p where key = 'SS'`);
    if (p && p.n === 0) {
      try {
        const admin = await one<{ id: string; email: string; name: string }>(
          `select u.id, u.email, u.name from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where r.name = 'Administrator' order by u.created_at limit 1`,
        );
        const ctx2 = admin ? { ...systemCtx(), user: { ...admin, kind: 'human' as const, must_change_password: false } } : systemCtx();
        const r = await importWorkbook(ctx2, p.id, await fetchGoogleSheet(seedUrl));
        log(`imported seed sheet: ${JSON.stringify(r.cards)}`);
      } catch (e: any) {
        log(`seed sheet import failed: ${e?.message ?? e}`);
      }
    }
  }
}
