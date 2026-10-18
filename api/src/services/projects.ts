import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { getProjectPerms, requireGlobal, requireProject, type Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { publish } from '../events.js';
import type { FieldDef } from './common.js';

export type ColumnSpec = { name: string; category?: 'todo' | 'active' | 'done' | 'closed'; color?: string; parity_weight?: number | null; wip_limit?: number | null };
export type BoardSpec = { key: string; name: string; description?: string; field_defs?: FieldDef[]; parity_enabled?: boolean; columns: ColumnSpec[] };

export const DEFAULT_BOARD: BoardSpec = {
  key: 'kanban',
  name: 'Kanban',
  columns: [
    { name: 'Backlog', category: 'todo', color: 'slate' },
    { name: 'To Do', category: 'todo', color: 'blue' },
    { name: 'In Progress', category: 'active', color: 'amber' },
    { name: 'Review', category: 'active', color: 'violet' },
    { name: 'Done', category: 'done', color: 'green' },
  ],
};

export const fieldDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Field keys are lowercase letters, digits and underscores'),
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'longtext', 'bool', 'number', 'date', 'url', 'select']),
  options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});

const actorId = (ctx: Ctx) => (ctx.via === 'system' ? null : ctx.user.id);

export async function listProjectsFor(ctx: Ctx) {
  const all = ctx.global.has('projects.all');
  const rows = await q(
    `select p.id, p.key, p.name, p.description, p.archived_at, p.created_at, p.updated_at, r.name as my_role,
            (select count(*) from cards c where c.project_id = p.id and c.archived_at is null) as card_count,
            (select count(*) from project_members m2 where m2.project_id = p.id) as member_count
       from projects p
       left join project_members m on m.project_id = p.id and m.user_id = $1
       left join roles r on r.id = m.role_id
      where $2 or m.user_id is not null
      order by p.archived_at nulls first, p.name`,
    [ctx.user.id, all],
  );
  return rows.map((r) => ({ ...r, my_role: r.my_role ?? (all ? 'Administrator' : null) }));
}

export async function createBoard(ctx: Ctx, projectId: string, spec: BoardSpec, db: Db) {
  const sort = (await one<{ n: number }>(`select coalesce(max(sort), -1) + 1 as n from boards where project_id = $1`, [projectId], db))!.n;
  const board = await one<{ id: string }>(
    `insert into boards (project_id, key, name, description, sort, field_defs, parity_enabled) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [projectId, spec.key, spec.name, spec.description ?? '', sort, JSON.stringify(spec.field_defs ?? []), spec.parity_enabled ?? false],
    db,
  ).catch((e) => {
    if (e.code === '23505') throw conflict(`A board with key "${spec.key}" already exists`);
    throw e;
  });
  for (const [i, col] of spec.columns.entries()) {
    await db.query(
      `insert into board_columns (board_id, name, sort, color, category, parity_weight, wip_limit) values ($1, $2, $3, $4, $5, $6, $7)`,
      [board!.id, col.name, i, col.color ?? '', col.category ?? 'todo', col.parity_weight ?? null, col.wip_limit ?? null],
    );
  }
  await audit(ctx, { action: 'board.created', entityType: 'board', entityId: board!.id, projectId, summary: `Created board "${spec.name}" with ${spec.columns.length} columns` }, db);
  return board!.id;
}

export const projectInput = z.object({
  key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Key is 2-10 letters/digits, starting with a letter'),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(5000).optional(),
});

export async function createProject(ctx: Ctx, input: z.infer<typeof projectInput>, opts: { boards?: BoardSpec[] } = {}) {
  requireGlobal(ctx, 'projects.create');
  const id = await tx(async (c) => {
    const exists = await one(`select 1 from projects where key = $1`, [input.key], c);
    if (exists) throw conflict(`Project key ${input.key} is already used`);
    const p = (await one<{ id: string }>(`insert into projects (key, name, description) values ($1, $2, $3) returning id`, [input.key, input.name, input.description ?? ''], c))!;
    const owner = await one<{ id: string }>(`select id from roles where scope = 'project' and name = 'Owner'`, [], c);
    if (owner && ctx.via !== 'system') await c.query(`insert into project_members (project_id, user_id, role_id) values ($1, $2, $3)`, [p.id, ctx.user.id, owner.id]);
    await audit(ctx, { action: 'project.created', entityType: 'project', entityId: p.id, projectId: p.id, summary: `Created project ${input.key} "${input.name}"` }, c);
    for (const b of opts.boards ?? [DEFAULT_BOARD]) await createBoard(ctx, p.id, b, c);
    return p.id;
  });
  return getProject(ctx, id);
}

export async function getProject(ctx: Ctx, projectId: string) {
  const perms = await requireProject(ctx, projectId, 'project.view');
  const p = await one(`select id, key, name, description, archived_at, created_at, updated_at from projects where id = $1`, [projectId]);
  if (!p) throw notFound('Project not found');
  const boards = await q(
    `select b.id, b.key, b.name, b.description, b.sort, b.field_defs, b.parity_enabled, b.archived_at,
            (select count(*) from cards c where c.board_id = b.id and c.archived_at is null) as card_count
       from boards b where b.project_id = $1 order by b.sort, b.name`,
    [projectId],
  );
  const columns = await q(
    `select col.id, col.board_id, col.name, col.sort, col.color, col.category, col.parity_weight, col.wip_limit,
            (select count(*) from cards c where c.column_id = col.id and c.archived_at is null) as card_count
       from board_columns col join boards b on b.id = col.board_id where b.project_id = $1 order by col.sort`,
    [projectId],
  );
  const areas = await q(`select id, name, sort, priority, expected_date, notes, updated_at from areas where project_id = $1 order by sort, name`, [projectId]);
  const requests = (await one<{ new: number; open: number }>(
    `select count(*) filter (where status = 'new') as new, count(*) filter (where status in ('new', 'reviewing')) as open from feature_requests where project_id = $1`,
    [projectId],
  ))!;
  return {
    ...p,
    requests,
    permissions: [...perms],
    boards: boards.map((b) => ({ ...b, columns: columns.filter((c) => c.board_id === b.id) })),
    areas,
  };
}

export const projectPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(5000).optional(), archived: z.boolean().optional() });

export async function updateProject(ctx: Ctx, projectId: string, patch: z.infer<typeof projectPatch>) {
  await requireProject(ctx, projectId, 'project.manage');
  await tx(async (c) => {
    const before = (await one(`select * from projects where id = $1`, [projectId], c))!;
    await c.query(
      `update projects set name = coalesce($2, name), description = coalesce($3, description),
         archived_at = case when $4::boolean is null then archived_at when $4 then coalesce(archived_at, now()) else null end, updated_at = now() where id = $1`,
      [projectId, patch.name ?? null, patch.description ?? null, patch.archived ?? null],
    );
    const after = (await one(`select * from projects where id = $1`, [projectId], c))!;
    const changes = diff(before, after, ['name', 'description', 'archived_at']);
    if (Object.keys(changes).length) await audit(ctx, { action: 'project.updated', entityType: 'project', entityId: projectId, projectId, summary: `Updated project settings (${Object.keys(changes).join(', ')})`, changes }, c);
  });
  publish({ projectId, type: 'project.updated', actor: ctx.user.name });
  return getProject(ctx, projectId);
}

// ---------- Areas ----------

export const areaInput = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.string().max(40).optional(),
  expected_date: z.string().max(40).optional(),
  notes: z.string().max(5000).optional(),
  sort: z.number().int().optional(),
});

export async function upsertArea(ctx: Ctx, projectId: string, areaId: string | null, input: Partial<z.infer<typeof areaInput>>, db?: Db) {
  const run = async (c: Db) => {
    // Renaming, reordering and creating areas is project management; the summary fields only need area.edit.
    const structural = !areaId || input.name !== undefined || input.sort !== undefined;
    await requireProject(ctx, projectId, structural ? 'project.manage' : 'area.edit', c);
    if (!areaId) {
      if (!input.name) throw badRequest('Area name is required');
      const sort = input.sort ?? (await one<{ n: number }>(`select coalesce(max(sort), -1) + 1 as n from areas where project_id = $1`, [projectId], c))!.n;
      const a = await one(
        `insert into areas (project_id, name, sort, priority, expected_date, notes) values ($1, $2, $3, $4, $5, $6) returning *`,
        [projectId, input.name, sort, input.priority ?? '', input.expected_date ?? '', input.notes ?? ''],
        c,
      ).catch((e) => {
        if (e.code === '23505') throw conflict(`Area "${input.name}" already exists`);
        throw e;
      });
      await audit(ctx, { action: 'area.created', entityType: 'area', entityId: a.id, projectId, summary: `Created area "${a.name}"` }, c);
      return a;
    }
    const before = await one(`select * from areas where id = $1 and project_id = $2`, [areaId, projectId], c);
    if (!before) throw notFound('Area not found');
    const after = await one(
      `update areas set name = coalesce($3, name), priority = coalesce($4, priority), expected_date = coalesce($5, expected_date),
         notes = coalesce($6, notes), sort = coalesce($7, sort), updated_at = now() where id = $1 and project_id = $2 returning *`,
      [areaId, projectId, input.name ?? null, input.priority ?? null, input.expected_date ?? null, input.notes ?? null, input.sort ?? null],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict(`Area "${input.name}" already exists`);
      throw e;
    });
    const changes = diff(before, after, ['name', 'priority', 'expected_date', 'notes', 'sort']);
    if (Object.keys(changes).length) await audit(ctx, { action: 'area.updated', entityType: 'area', entityId: areaId, projectId, summary: `Updated area "${after.name}" (${Object.keys(changes).join(', ')})`, changes }, c);
    return after;
  };
  const a = db ? await run(db) : await tx(run);
  publish({ projectId, type: 'area.updated', actor: ctx.user.name });
  return a;
}

export async function deleteArea(ctx: Ctx, projectId: string, areaId: string) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const a = await one(`delete from areas where id = $1 and project_id = $2 returning name`, [areaId, projectId], c);
    if (!a) throw notFound('Area not found');
    await audit(ctx, { action: 'area.deleted', entityType: 'area', entityId: areaId, projectId, summary: `Deleted area "${a.name}" (its cards keep no area)` }, c);
  });
  publish({ projectId, type: 'area.updated', actor: ctx.user.name });
}

// ---------- Boards & columns ----------

export const boardInput = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
  parity_enabled: z.boolean().optional(),
  field_defs: z.array(fieldDefSchema).max(40).optional(),
  columns: z.array(z.object({ name: z.string().trim().min(1).max(60), category: z.enum(['todo', 'active', 'done', 'closed']).optional(), color: z.string().max(20).optional() })).min(1).max(30).optional(),
});

export async function addBoard(ctx: Ctx, projectId: string, input: z.infer<typeof boardInput>) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    await createBoard(ctx, projectId, { ...input, columns: input.columns ?? DEFAULT_BOARD.columns }, c);
  });
  publish({ projectId, type: 'board.updated', actor: ctx.user.name });
}

export const boardPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  parity_enabled: z.boolean().optional(),
  field_defs: z.array(fieldDefSchema).max(40).optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});

export async function updateBoard(ctx: Ctx, projectId: string, boardId: string, patch: z.infer<typeof boardPatch>) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const before = await one(`select * from boards where id = $1 and project_id = $2`, [boardId, projectId], c);
    if (!before) throw notFound('Board not found');
    if (patch.field_defs) {
      const keys = patch.field_defs.map((f) => f.key);
      if (new Set(keys).size !== keys.length) throw badRequest('Field keys must be unique');
    }
    const after = await one(
      `update boards set name = coalesce($2, name), description = coalesce($3, description), parity_enabled = coalesce($4, parity_enabled),
         field_defs = coalesce($5, field_defs), sort = coalesce($6, sort),
         archived_at = case when $7::boolean is null then archived_at when $7 then coalesce(archived_at, now()) else null end, updated_at = now()
       where id = $1 returning *`,
      [boardId, patch.name ?? null, patch.description ?? null, patch.parity_enabled ?? null, patch.field_defs ? JSON.stringify(patch.field_defs) : null, patch.sort ?? null, patch.archived ?? null],
      c,
    );
    const changes = diff(before, after, ['name', 'description', 'parity_enabled', 'field_defs', 'sort', 'archived_at']);
    if (Object.keys(changes).length) await audit(ctx, { action: 'board.updated', entityType: 'board', entityId: boardId, projectId, summary: `Updated board "${after.name}" (${Object.keys(changes).join(', ')})`, changes }, c);
  });
  publish({ projectId, type: 'board.updated', boardId, actor: ctx.user.name });
}

export const columnInput = z.object({
  name: z.string().trim().min(1).max(60),
  category: z.enum(['todo', 'active', 'done', 'closed']).optional(),
  color: z.string().max(20).optional(),
  parity_weight: z.number().min(0).max(1).nullable().optional(),
  wip_limit: z.number().int().min(1).max(999).nullable().optional(),
  sort: z.number().int().optional(),
});

async function boardOf(projectId: string, boardId: string, c: Db) {
  const b = await one(`select id, name from boards where id = $1 and project_id = $2`, [boardId, projectId], c);
  if (!b) throw notFound('Board not found');
  return b;
}

export async function addColumn(ctx: Ctx, projectId: string, boardId: string, input: z.infer<typeof columnInput>) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const b = await boardOf(projectId, boardId, c);
    const sort = input.sort ?? (await one<{ n: number }>(`select coalesce(max(sort), -1) + 1 as n from board_columns where board_id = $1`, [boardId], c))!.n;
    const col = await one(
      `insert into board_columns (board_id, name, sort, color, category, parity_weight, wip_limit) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [boardId, input.name, sort, input.color ?? '', input.category ?? 'todo', input.parity_weight ?? null, input.wip_limit ?? null],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict(`Column "${input.name}" already exists on this board`);
      throw e;
    });
    await audit(ctx, { action: 'column.created', entityType: 'column', entityId: col.id, projectId, summary: `Added column "${input.name}" to ${b.name}` }, c);
  });
  publish({ projectId, type: 'board.updated', boardId, actor: ctx.user.name });
}

export async function updateColumn(ctx: Ctx, projectId: string, boardId: string, columnId: string, patch: Partial<z.infer<typeof columnInput>>) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const b = await boardOf(projectId, boardId, c);
    const before = await one(`select * from board_columns where id = $1 and board_id = $2`, [columnId, boardId], c);
    if (!before) throw notFound('Column not found');
    const after = await one(
      `update board_columns set name = coalesce($2, name), category = coalesce($3, category), color = coalesce($4, color),
         parity_weight = case when $5::boolean then $6 else parity_weight end,
         wip_limit = case when $7::boolean then $8 else wip_limit end, sort = coalesce($9, sort)
       where id = $1 returning *`,
      [columnId, patch.name ?? null, patch.category ?? null, patch.color ?? null, patch.parity_weight !== undefined, patch.parity_weight ?? null, patch.wip_limit !== undefined, patch.wip_limit ?? null, patch.sort ?? null],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict(`Column "${patch.name}" already exists on this board`);
      throw e;
    });
    const changes = diff(before, after, ['name', 'category', 'color', 'parity_weight', 'wip_limit', 'sort']);
    if (Object.keys(changes).length) await audit(ctx, { action: 'column.updated', entityType: 'column', entityId: columnId, projectId, summary: `Updated column "${after.name}" on ${b.name} (${Object.keys(changes).join(', ')})`, changes }, c);
  });
  publish({ projectId, type: 'board.updated', boardId, actor: ctx.user.name });
}

export async function deleteColumn(ctx: Ctx, projectId: string, boardId: string, columnId: string, moveTo?: string) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const b = await boardOf(projectId, boardId, c);
    const col = await one(`select * from board_columns where id = $1 and board_id = $2`, [columnId, boardId], c);
    if (!col) throw notFound('Column not found');
    const count = (await one<{ n: number }>(`select count(*) as n from cards where column_id = $1`, [columnId], c))!.n;
    if (count > 0) {
      if (!moveTo) throw badRequest(`Column has ${count} cards; choose a column to move them to`);
      const target = await one(`select id, name from board_columns where id = $1 and board_id = $2 and id <> $3`, [moveTo, boardId, columnId], c);
      if (!target) throw badRequest('Target column not found');
      await c.query(`update cards set column_id = $1, updated_at = now() where column_id = $2`, [target.id, columnId]);
    }
    await c.query(`delete from board_columns where id = $1`, [columnId]);
    await audit(ctx, { action: 'column.deleted', entityType: 'column', entityId: columnId, projectId, summary: `Deleted column "${col.name}" from ${b.name}${count ? ` (moved ${count} cards)` : ''}` }, c);
  });
  publish({ projectId, type: 'board.updated', boardId, actor: ctx.user.name });
}

// ---------- Members ----------

export async function listMembers(ctx: Ctx, projectId: string) {
  await requireProject(ctx, projectId, 'project.view');
  return q(
    `select u.id, u.name, u.email, u.kind, u.is_active, u.avatar_updated_at, r.id as role_id, r.name as role_name, m.created_at
       from project_members m join users u on u.id = m.user_id join roles r on r.id = m.role_id where m.project_id = $1 order by u.name`,
    [projectId],
  );
}

export async function setMember(ctx: Ctx, projectId: string, userId: string, roleId: string | null) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'project.manage', c);
    const user = await one(`select id, name from users where id = $1`, [userId], c);
    if (!user) throw notFound('User not found');
    const before = await one(`select r.name from project_members m join roles r on r.id = m.role_id where m.project_id = $1 and m.user_id = $2`, [projectId, userId], c);
    if (roleId === null) {
      if (!before) return;
      await c.query(`delete from project_members where project_id = $1 and user_id = $2`, [projectId, userId]);
      await audit(ctx, { action: 'member.removed', entityType: 'user', entityId: userId, projectId, summary: `Removed ${user.name} from the project (was ${before.name})` }, c);
      return;
    }
    const role = await one(`select id, name from roles where id = $1 and scope = 'project'`, [roleId], c);
    if (!role) throw badRequest('Not a project role');
    await c.query(
      `insert into project_members (project_id, user_id, role_id) values ($1, $2, $3) on conflict (project_id, user_id) do update set role_id = excluded.role_id`,
      [projectId, userId, roleId],
    );
    if (before?.name !== role.name) {
      await audit(ctx, {
        action: before ? 'member.role_changed' : 'member.added', entityType: 'user', entityId: userId, projectId,
        summary: before ? `Changed ${user.name}'s project role from ${before.name} to ${role.name}` : `Added ${user.name} to the project as ${role.name}`,
        changes: { role: { from: before?.name ?? null, to: role.name } },
      }, c);
    }
  });
}

// ---------- Summary ----------

/** Per-area counts by column and parity, mirroring the sheet's "By area" table. */
export async function boardSummary(boardId: string) {
  const columns = await q(`select id, name, category, parity_weight, color from board_columns where board_id = $1 order by sort`, [boardId]);
  const rows = await q<{ area_id: string | null; column_id: string; n: number }>(
    `select area_id, column_id, count(*) as n from cards where board_id = $1 and archived_at is null group by area_id, column_id`,
    [boardId],
  );
  const weight = new Map(columns.map((c) => [c.id, c.parity_weight as number | null]));
  const byArea = new Map<string | null, Record<string, number>>();
  for (const r of rows) {
    const m = byArea.get(r.area_id) ?? {};
    m[r.column_id] = r.n;
    byArea.set(r.area_id, m);
  }
  const parity = (counts: Record<string, number>) => {
    let num = 0;
    let den = 0;
    for (const [col, n] of Object.entries(counts)) {
      const w = weight.get(col);
      if (w === null || w === undefined) continue;
      num += w * n;
      den += n;
    }
    return den ? num / den : null;
  };
  const totals: Record<string, number> = {};
  for (const m of byArea.values()) for (const [k, v] of Object.entries(m)) totals[k] = (totals[k] ?? 0) + v;
  const counted = Object.entries(totals).reduce((s, [k, v]) => s + (weight.get(k) === null || weight.get(k) === undefined ? 0 : v), 0);
  return {
    columns,
    areas: [...byArea.entries()].map(([area_id, counts]) => ({ area_id, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), parity: parity(counts) })),
    totals: { counts: totals, total: Object.values(totals).reduce((a, b) => a + b, 0), counted, parity: parity(totals) },
  };
}

export async function projectSummary(ctx: Ctx, projectId: string) {
  await requireProject(ctx, projectId, 'project.view');
  const boards = await q(`select id, key, name, parity_enabled from boards where project_id = $1 and archived_at is null order by sort`, [projectId]);
  const out = [];
  for (const b of boards) out.push({ board: b, ...(await boardSummary(b.id)) });
  const recent = await q(
    `select id, at, actor_name, via, action, summary, entity_type, entity_id from audit_log where project_id = $1 order by at desc, id desc limit 15`,
    [projectId],
  );
  const latestUpdate = await one(`select id, title, period_start, period_end, hours, updated_at from project_updates where project_id = $1 order by period_start desc nulls last, created_at desc limit 1`, [projectId]);
  return { boards: out, recent, latest_update: latestUpdate ?? null };
}

export async function canSee(ctx: Ctx, projectId: string) {
  return (await getProjectPerms(ctx, projectId)).has('project.view');
}

export { actorId };
