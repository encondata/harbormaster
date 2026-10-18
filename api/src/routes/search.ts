// Global search (header search box and command palette) and the notifications feed (header bell).
import type { FastifyInstance } from 'fastify';
import { requireUser, type Ctx } from '../auth.js';
import { q } from '../db.js';

/** Project ids the caller can see, and the subset whose activity they may read. */
async function visibleProjects(ctx: Ctx) {
  if (ctx.global.has('projects.all')) {
    const ids = (await q<{ id: string }>(`select id from projects`)).map((r) => r.id);
    return { view: ids, audit: ids };
  }
  const rows = await q<{ id: string; perms: string[] }>(
    `select m.project_id as id, r.permissions as perms from project_members m join roles r on r.id = m.role_id where m.user_id = $1`,
    [ctx.user.id],
  );
  return {
    view: rows.filter((r) => r.perms.includes('project.view')).map((r) => r.id),
    audit: rows.filter((r) => r.perms.includes('project.audit')).map((r) => r.id),
  };
}

const like = (s: string) => `%${s.replace(/[%_\\]/g, (m) => '\\' + m)}%`;

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (req) => {
    const ctx = requireUser(req);
    const text = String((req.query as any).q ?? '').trim().slice(0, 100);
    if (!text) return { projects: [], boards: [], cards: [], requests: [] };
    const { view } = await visibleProjects(ctx);
    if (!view.length) return { projects: [], boards: [], cards: [], requests: [] };
    const pat = like(text);
    // "SS-42" or "SS-R4" jumps straight to that card or request.
    const keyMatch = /^([A-Za-z][A-Za-z0-9]*)-(R?)(\d+)$/.exec(text);
    const [projects, boards, cards, requests] = await Promise.all([
      q(`select key, name, archived_at from projects where id = any($1) and (name ilike $2 or key ilike $2) order by archived_at nulls first, name limit 5`, [view, pat]),
      q(`select b.key, b.name, p.key as project_key, p.name as project_name from boards b join projects p on p.id = b.project_id
          where b.project_id = any($1) and b.archived_at is null and b.name ilike $2 order by p.name, b.sort limit 5`, [view, pat]),
      q(`select p.key || '-' || c.number as key, c.title, b.key as board_key, b.name as board_name, col.name as column_name, p.key as project_key
           from cards c join projects p on p.id = c.project_id join boards b on b.id = c.board_id join board_columns col on col.id = c.column_id
          where c.project_id = any($1) and c.archived_at is null
            and (c.title ilike $2 or (p.key || '-' || c.number) ilike $3 ${keyMatch && !keyMatch[2] ? `or (p.key = upper($4) and c.number = $5)` : ''})
          order by (p.key || '-' || c.number) ilike $3 desc, c.updated_at desc limit 8`,
        keyMatch && !keyMatch[2] ? [view, pat, text, keyMatch[1], Number(keyMatch[3])] : [view, pat, text]),
      q(`select p.key || '-R' || r.number as key, r.title, r.status, p.key as project_key
           from feature_requests r join projects p on p.id = r.project_id
          where r.project_id = any($1) and (r.title ilike $2 or (p.key || '-R' || r.number) ilike $3)
          order by (p.key || '-R' || r.number) ilike $3 desc, r.updated_at desc limit 5`, [view, pat, text]),
    ]);
    return { projects, boards, cards, requests };
  });

  // Recent changes on your projects made by someone else (people, Claude, imports).
  app.get('/api/feed', async (req) => {
    const ctx = requireUser(req);
    const { audit } = await visibleProjects(ctx);
    if (!audit.length) return [];
    const limit = Math.min(Number((req.query as any).limit) || 30, 100);
    return q(
      `select a.id, a.at, a.actor_name, a.via, a.action, a.summary, a.entity_type, a.entity_id, p.key as project_key, p.name as project_name
         from audit_log a join projects p on p.id = a.project_id
        where a.project_id = any($1) and (a.actor_id is distinct from $2)
          and a.action not like 'auth.%'
        order by a.id desc limit $3`,
      [audit, ctx.user.id, limit],
    );
  });
}
