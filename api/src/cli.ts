// Server-side maintenance commands, run inside the api container:
//   docker compose exec api node dist/cli.js reset-password <email> [new-password]
//   docker compose exec api node dist/cli.js make-admin <email>
//   docker compose exec api node dist/cli.js export-sheet <PROJECT-KEY> [--dry-run]
//   docker compose exec -T api node dist/cli.js publish-skill <email> < bundle.json   ({name, notes?, files})
import { audit } from './audit.js';
import { buildCtx, hashPassword, randomToken, systemCtx, validatePassword } from './auth.js';
import { one, pool, tx } from './db.js';
import { resolveProject } from './services/common.js';
import { runExport } from './services/sheet-export.js';
import { publishSkill } from './services/skills.js';

const [cmd, email, password] = process.argv.slice(2);

async function main() {
  if (cmd === 'export-sheet' && email) {
    const project = await resolveProject(email);
    const r = await runExport(systemCtx(), project.id, { dryRun: process.argv.includes('--dry-run') });
    console.log(`${r.dry_run ? 'Dry run (nothing written)' : 'Exported'} ${project.key}: ${r.tabs.map((t) => `${t.title} (${t.rows} rows)`).join(', ')}`);
    return;
  }
  if (cmd === 'publish-skill' && email) {
    // Publishes as that user (they need skills.publish); the bundle comes on stdin so nothing lands on disk.
    const u = await one<{ id: string; email: string; name: string; kind: 'human' | 'service' }>(`select id, email, name, kind from users where lower(email) = lower($1) and is_active`, [email]);
    if (!u) throw new Error(`No active user with email ${email}`);
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const ctx = await buildCtx({ ...u, must_change_password: false }, { via: 'system', ip: null });
    const r = await publishSkill(ctx, JSON.parse(raw));
    console.log(r.unchanged ? `${r.name} is unchanged (still v${r.version})` : `Published ${r.name} v${r.version}`);
    return;
  }
  if (!cmd || !email) {
    console.log('Usage:\n  node dist/cli.js reset-password <email> [new-password]\n  node dist/cli.js make-admin <email>\n  node dist/cli.js export-sheet <PROJECT-KEY> [--dry-run]\n  node dist/cli.js publish-skill <email> < bundle.json');
    process.exit(1);
  }
  const user = await one<{ id: string; name: string; kind: string }>(`select id, name, kind from users where lower(email) = lower($1)`, [email]);
  if (!user) throw new Error(`No user with email ${email}`);
  const ctx = { ...systemCtx(), via: 'system' as const };
  if (cmd === 'reset-password') {
    if (user.kind !== 'human') throw new Error('Service accounts use API tokens, not passwords');
    const pw = password || randomToken(12);
    const problem = validatePassword(pw);
    if (problem) throw new Error(problem);
    await tx(async (c) => {
      await c.query(`update users set password_hash = $2, must_change_password = true, is_active = true, updated_at = now() where id = $1`, [user.id, await hashPassword(pw)]);
      await c.query(`delete from sessions where user_id = $1`, [user.id]);
      await audit(ctx, { action: 'user.password_reset', entityType: 'user', entityId: user.id, summary: `Reset ${user.name}'s password from the server console` }, c);
    });
    console.log(`Password reset for ${email}. Temporary password: ${pw}\nThey must change it at next sign-in.`);
  } else if (cmd === 'make-admin') {
    await tx(async (c) => {
      await c.query(`insert into user_roles (user_id, role_id) select $1, id from roles where scope = 'global' and name = 'Administrator' on conflict do nothing`, [user.id]);
      await c.query(`update users set is_active = true where id = $1`, [user.id]);
      await audit(ctx, { action: 'user.updated', entityType: 'user', entityId: user.id, summary: `Granted Administrator to ${user.name} from the server console` }, c);
    });
    console.log(`${email} is now an Administrator.`);
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
