import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { publish } from '../events.js';
import { resolveArea, resolveColumn, UUID_RE, validateFields, type FieldDef } from './common.js';

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

const CARD_SELECT = `
  select c.id, p.key || '-' || c.number as key, c.number, c.project_id, c.board_id, c.column_id, col.name as column_name,
         c.title, c.description, c.area_id, a.name as area_name, c.priority, c.assignee_id, au.name as assignee_name,
         c.tags, c.fields, c.estimate, c.due_date, c.sort, c.external_key, c.created_at, c.updated_at, c.archived_at,
         cu.name as created_by_name, uu.name as updated_by_name,
         (select count(*) from card_comments cc where cc.card_id = c.id and cc.deleted_at is null) as comment_count,
         (select count(*) from attachments at where at.card_id = c.id) as attachment_count
    from cards c
    join projects p on p.id = c.project_id
    join board_columns col on col.id = c.column_id
    left join areas a on a.id = c.area_id
    left join users au on au.id = c.assignee_id
    left join users cu on cu.id = c.created_by
    left join users uu on uu.id = c.updated_by`;

export type Card = {
  id: string; key: string; number: number; project_id: string; board_id: string; column_id: string; column_name: string;
  title: string; description: string; area_id: string | null; area_name: string | null; priority: string | null;
  assignee_id: string | null; assignee_name: string | null; tags: string[]; fields: Record<string, unknown>;
  estimate: string; due_date: string | null; sort: number; external_key: string | null; created_at: string; updated_at: string;
  archived_at: string | null; created_by_name: string | null; updated_by_name: string | null; comment_count: number; attachment_count: number;
};

export async function loadCard(id: string, db?: Db): Promise<Card> {
  const c = await one<Card>(`${CARD_SELECT} where c.id = $1`, [id], db);
  if (!c) throw notFound('Card not found');
  return c;
}

/** Resolve "SS-12", a bare number within a project, or a uuid. */
export async function resolveCardId(ref: string, projectId?: string, db?: Db): Promise<string> {
  const s = ref.trim();
  if (UUID_RE.test(s)) return s;
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(s);
  let row: { id: string } | undefined;
  if (m) row = await one(`select c.id from cards c join projects p on p.id = c.project_id where p.key = upper($1) and c.number = $2`, [m[1], Number(m[2])], db);
  else if (/^\d+$/.test(s) && projectId) row = await one(`select id from cards where project_id = $1 and number = $2`, [projectId, Number(s)], db);
  if (!row) throw notFound(`Card ${ref} not found`);
  return row.id;
}

export async function getCardForCtx(ctx: Ctx, ref: string, perm: Parameters<typeof requireProject>[2] = 'project.view') {
  const id = await resolveCardId(ref);
  const card = await loadCard(id);
  await requireProject(ctx, card.project_id, perm);
  return card;
}

export type ListFilter = {
  boardId?: string; columnId?: string; areaId?: string; priority?: string; tag?: string; assigneeId?: string;
  query?: string; includeArchived?: boolean; limit?: number; offset?: number;
};

export async function listCards(projectId: string, f: ListFilter) {
  const where = ['c.project_id = $1'];
  const params: unknown[] = [projectId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.boardId) add('c.board_id = ?', f.boardId);
  if (f.columnId) add('c.column_id = ?', f.columnId);
  if (f.areaId) add('c.area_id = ?', f.areaId);
  if (f.priority) add('c.priority = ?', f.priority);
  if (f.tag) add('? = any(c.tags)', f.tag);
  if (f.assigneeId) add('c.assignee_id = ?', f.assigneeId);
  if (!f.includeArchived) where.push('c.archived_at is null');
  if (f.query) {
    params.push(`%${f.query.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    const i = params.length;
    where.push(`(c.title ilike $${i} or c.description ilike $${i} or c.fields::text ilike $${i} or (p.key || '-' || c.number) ilike $${i})`);
  }
  const limit = Math.min(Math.max(f.limit ?? 2000, 1), 5000);
  params.push(limit, f.offset ?? 0);
  return q<Card>(`${CARD_SELECT} where ${where.join(' and ')} order by col.sort, c.sort, c.number limit $${params.length - 1} offset $${params.length}`, params);
}

export const cardInput = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50000).optional(),
  column: z.string().optional(),
  area: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  estimate: z.string().max(100).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  position: z.enum(['top', 'bottom']).optional(),
  external_key: z.string().max(500).nullable().optional(),
});
export type CardInput = z.infer<typeof cardInput>;

export const cardPatch = cardInput.partial().omit({ position: true, column: true });
export type CardPatch = z.infer<typeof cardPatch>;

const normTags = (t: string[]) => [...new Set(t.map((s) => s.trim().toLowerCase()).filter(Boolean))];

async function sortAt(columnId: string, index: number | 'top' | 'bottom', excludeId: string | null, db: Db): Promise<number> {
  const rows = await q<{ id: string; sort: number }>(
    `select id, sort from cards where column_id = $1 and archived_at is null and ($2::uuid is null or id <> $2) order by sort, number`,
    [columnId, excludeId],
    db,
  );
  const i = index === 'top' ? 0 : index === 'bottom' ? rows.length : Math.max(0, Math.min(index, rows.length));
  const prev = i > 0 ? rows[i - 1].sort : null;
  const next = i < rows.length ? rows[i].sort : null;
  if (prev === null && next === null) return 1024;
  if (prev === null) return next! - 1024;
  if (next === null) return prev + 1024;
  if (next - prev > 1e-6) return (prev + next) / 2;
  // Ran out of room between neighbours: renumber the column and retry.
  await db.query(
    `update cards c set sort = s.rn * 1024 from (select id, row_number() over (order by sort, number) as rn from cards where column_id = $1 and archived_at is null) s where c.id = s.id`,
    [columnId],
  );
  return sortAt(columnId, index, excludeId, db);
}

async function assertAssignee(projectId: string, userId: string | null | undefined, db: Db) {
  if (!userId) return;
  const ok = await one(
    `select 1 from users u where u.id = $1 and u.is_active and (exists (select 1 from project_members m where m.project_id = $2 and m.user_id = u.id)
       or exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and 'projects.all' = any(r.permissions)))`,
    [userId, projectId],
    db,
  );
  if (!ok) throw badRequest('Assignee must be an active member of the project');
}

export async function createCard(ctx: Ctx, projectId: string, boardId: string, input: CardInput, db?: Db): Promise<Card> {
  const run = async (c: Db) => {
    await requireProject(ctx, projectId, 'card.create', c);
    const board = await one<{ id: string; field_defs: FieldDef[] }>(`select id, field_defs from boards where id = $1 and project_id = $2`, [boardId, projectId], c);
    if (!board) throw notFound('Board not found');
    const column = input.column
      ? await resolveColumn(boardId, input.column, c)
      : await one<{ id: string; name: string }>(`select id, name from board_columns where board_id = $1 order by sort limit 1`, [boardId], c);
    if (!column) throw badRequest('Board has no columns');
    const areaId = input.area ? (await resolveArea(projectId, input.area, c)).id : null;
    await assertAssignee(projectId, input.assignee_id, c);
    const fields = validateFields(board.field_defs, input.fields ?? {});
    const { next_card_number: number } = (await one<{ next_card_number: number }>(
      `update projects set next_card_number = next_card_number + 1 where id = $1 returning next_card_number - 1 as next_card_number`,
      [projectId],
      c,
    ))!;
    const sort = await sortAt(column.id, input.position ?? 'bottom', null, c);
    const row = (await one<{ id: string }>(
      `insert into cards (project_id, board_id, column_id, number, title, description, area_id, priority, assignee_id, tags, fields, estimate, due_date, sort, external_key, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16) returning id`,
      [projectId, boardId, column.id, number, input.title, input.description ?? '', areaId, input.priority ?? null, input.assignee_id ?? null,
        normTags(input.tags ?? []), JSON.stringify(stripNulls(fields)), input.estimate ?? '', input.due_date ?? null, sort, input.external_key ?? null, actorId(ctx)],
      c,
    ))!;
    const card = await loadCard(row.id, c);
    await audit(ctx, { action: 'card.created', entityType: 'card', entityId: card.id, projectId, summary: `Created ${card.key} "${card.title}" in ${card.column_name}` }, c);
    return card;
  };
  const card = db ? await run(db) : await tx(run);
  publish({ projectId, type: 'card.created', boardId, cardId: card.id, actor: ctx.user.name });
  return card;
}

const stripNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
const actorId = (ctx: Ctx) => (ctx.via === 'system' ? null : ctx.user.id);

const EDIT_KEYS = ['title', 'description', 'area_name', 'priority', 'assignee_name', 'tags', 'estimate', 'due_date', 'external_key'];

export async function updateCard(ctx: Ctx, cardId: string, patch: CardPatch, db?: Db): Promise<Card> {
  const run = async (c: Db) => {
    const before = await loadCard(cardId, c);
    await requireProject(ctx, before.project_id, 'card.edit', c);
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.area !== undefined) set('area_id', patch.area ? (await resolveArea(before.project_id, patch.area, c)).id : null);
    if (patch.priority !== undefined) set('priority', patch.priority);
    if (patch.assignee_id !== undefined) {
      await assertAssignee(before.project_id, patch.assignee_id, c);
      set('assignee_id', patch.assignee_id);
    }
    if (patch.tags !== undefined) set('tags', normTags(patch.tags));
    if (patch.estimate !== undefined) set('estimate', patch.estimate);
    if (patch.due_date !== undefined) set('due_date', patch.due_date);
    if (patch.external_key !== undefined) set('external_key', patch.external_key);
    if (patch.fields !== undefined) {
      const board = (await one<{ field_defs: FieldDef[] }>(`select field_defs from boards where id = $1`, [before.board_id], c))!;
      const merged = stripNulls({ ...before.fields, ...validateFields(board.field_defs, patch.fields) });
      set('fields', JSON.stringify(merged));
    }
    if (!sets.length) return { before, after: before, changes: {} };
    set('updated_by', actorId(ctx));
    params.push(cardId);
    await c.query(`update cards set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`, params);
    const after = await loadCard(cardId, c);
    const changes: Record<string, unknown> = diff(before, after, EDIT_KEYS);
    for (const k of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])) {
      if (JSON.stringify(before.fields[k] ?? null) !== JSON.stringify(after.fields[k] ?? null)) changes[`fields.${k}`] = { from: before.fields[k] ?? null, to: after.fields[k] ?? null };
    }
    if (Object.keys(changes).length) {
      const names = Object.keys(changes).map((k) => k.replace(/^fields\./, '').replace(/_name$/, ''));
      await audit(ctx, { action: 'card.updated', entityType: 'card', entityId: cardId, projectId: before.project_id, summary: `Edited ${after.key}: ${names.join(', ')}`, changes }, c);
    }
    return { before, after, changes };
  };
  const { after, changes } = db ? await run(db) : await tx(run);
  if (Object.keys(changes).length) publish({ projectId: after.project_id, type: 'card.updated', boardId: after.board_id, cardId, actor: ctx.user.name });
  return after;
}

export async function moveCard(ctx: Ctx, cardId: string, columnRef: string, index: number | 'top' | 'bottom' = 'bottom', db?: Db): Promise<Card> {
  const run = async (c: Db) => {
    const before = await loadCard(cardId, c);
    await requireProject(ctx, before.project_id, 'card.move', c);
    const column = await resolveColumn(before.board_id, columnRef, c);
    const sort = await sortAt(column.id, index, cardId, c);
    await c.query(`update cards set column_id = $1, sort = $2, updated_at = now(), updated_by = $3 where id = $4`, [column.id, sort, actorId(ctx), cardId]);
    const after = await loadCard(cardId, c);
    if (before.column_id !== after.column_id) {
      await audit(ctx, {
        action: 'card.moved', entityType: 'card', entityId: cardId, projectId: before.project_id,
        summary: `Moved ${after.key} from ${before.column_name} to ${after.column_name}`,
        changes: { column: { from: before.column_name, to: after.column_name } },
      }, c);
    }
    return after;
  };
  const after = db ? await run(db) : await tx(run);
  publish({ projectId: after.project_id, type: 'card.moved', boardId: after.board_id, cardId, actor: ctx.user.name });
  return after;
}

export async function setArchived(ctx: Ctx, cardId: string, archived: boolean): Promise<Card> {
  const after = await tx(async (c) => {
    const before = await loadCard(cardId, c);
    await requireProject(ctx, before.project_id, 'card.archive', c);
    if (!!before.archived_at === archived) return before;
    const sort = archived ? before.sort : await sortAt(before.column_id, 'bottom', cardId, c);
    await c.query(`update cards set archived_at = ${archived ? 'now()' : 'null'}, sort = $2, updated_at = now(), updated_by = $3 where id = $1`, [cardId, sort, actorId(ctx)]);
    await audit(ctx, { action: archived ? 'card.archived' : 'card.restored', entityType: 'card', entityId: cardId, projectId: before.project_id, summary: `${archived ? 'Archived' : 'Restored'} ${before.key} "${before.title}"` }, c);
    return loadCard(cardId, c);
  });
  publish({ projectId: after.project_id, type: 'card.updated', boardId: after.board_id, cardId, actor: ctx.user.name });
  return after;
}

export async function listComments(cardId: string) {
  return q(
    `select cc.id, cc.body, cc.created_at, cc.updated_at, cc.author_id, u.name as author_name, u.kind as author_kind
       from card_comments cc left join users u on u.id = cc.author_id where cc.card_id = $1 and cc.deleted_at is null order by cc.created_at`,
    [cardId],
  );
}

export async function addComment(ctx: Ctx, cardId: string, body: string) {
  const text = body.trim();
  if (!text) throw badRequest('Comment is empty');
  if (text.length > 20000) throw badRequest('Comment is too long');
  const { card, comment } = await tx(async (c) => {
    const card = await loadCard(cardId, c);
    await requireProject(ctx, card.project_id, 'card.comment', c);
    const comment = (await one(`insert into card_comments (card_id, author_id, body) values ($1, $2, $3) returning id, body, created_at`, [cardId, actorId(ctx), text], c))!;
    await c.query(`update cards set updated_at = now() where id = $1`, [cardId]);
    await audit(ctx, { action: 'card.commented', entityType: 'card', entityId: cardId, projectId: card.project_id, summary: `Commented on ${card.key}`, changes: { comment: text.slice(0, 500) } }, c);
    return { card, comment };
  });
  publish({ projectId: card.project_id, type: 'card.commented', boardId: card.board_id, cardId, actor: ctx.user.name });
  return comment;
}

export async function deleteComment(ctx: Ctx, commentId: string) {
  const row = await one<{ card_id: string; author_id: string | null }>(`select card_id, author_id from card_comments where id = $1 and deleted_at is null`, [commentId]);
  if (!row) throw notFound('Comment not found');
  const card = await loadCard(row.card_id);
  const perms = await requireProject(ctx, card.project_id, 'project.view');
  if (row.author_id !== ctx.user.id && !perms.has('project.manage')) throw badRequest('You can only delete your own comments');
  await tx(async (c) => {
    await c.query(`update card_comments set deleted_at = now() where id = $1`, [commentId]);
    await audit(ctx, { action: 'card.comment_deleted', entityType: 'card', entityId: card.id, projectId: card.project_id, summary: `Deleted a comment on ${card.key}` }, c);
  });
  publish({ projectId: card.project_id, type: 'card.commented', boardId: card.board_id, cardId: card.id, actor: ctx.user.name });
}

export async function cardHistory(cardId: string, limit = 100) {
  return q(
    `select id, at, actor_name, via, action, summary, changes from audit_log where entity_type = 'card' and entity_id = $1 order by at desc, id desc limit $2`,
    [cardId, limit],
  );
}
