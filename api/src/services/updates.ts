import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { publish } from '../events.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const updateInput = z.object({
  title: z.string().trim().min(1).max(200),
  period_start: date.nullable().optional(),
  period_end: date.nullable().optional(),
  body: z.string().max(200000).optional(),
  hours: z.number().min(0).max(10000).nullable().optional(),
  hours_note: z.string().max(1000).optional(),
});
export type UpdateInput = z.infer<typeof updateInput>;

const SELECT = `select pu.id, pu.project_id, pu.title, pu.period_start, pu.period_end, pu.body, pu.hours, pu.hours_note,
  pu.created_at, pu.updated_at, cu.name as created_by_name, uu.name as updated_by_name
  from project_updates pu left join users cu on cu.id = pu.created_by left join users uu on uu.id = pu.updated_by`;

export async function listUpdates(ctx: Ctx, projectId: string, limit = 100) {
  await requireProject(ctx, projectId, 'project.view');
  return q(`${SELECT} where pu.project_id = $1 order by pu.period_start desc nulls last, pu.created_at desc limit $2`, [projectId, limit]);
}

const actorId = (ctx: Ctx) => (ctx.via === 'system' ? null : ctx.user.id);

export async function saveUpdate(ctx: Ctx, projectId: string, id: string | null, input: Partial<UpdateInput>, db?: Db) {
  const run = async (c: Db) => {
    await requireProject(ctx, projectId, 'update.write', c);
    if (!id) {
      const row = await one(
        `insert into project_updates (project_id, title, period_start, period_end, body, hours, hours_note, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
        [projectId, input.title, input.period_start ?? null, input.period_end ?? null, input.body ?? '', input.hours ?? null, input.hours_note ?? '', actorId(ctx)],
        c,
      ).catch((e) => {
        if (e.code === '23505') throw conflict(`An update titled "${input.title}" already exists`);
        throw e;
      });
      await audit(ctx, { action: 'update.created', entityType: 'update', entityId: row.id, projectId, summary: `Added progress update "${input.title}"` }, c);
      return row.id as string;
    }
    const before = await one(`select * from project_updates where id = $1 and project_id = $2`, [id, projectId], c);
    if (!before) throw notFound('Update not found');
    const has = (k: keyof UpdateInput) => input[k] !== undefined;
    const after = await one(
      `update project_updates set
         title = case when $3 then $4 else title end, period_start = case when $5 then $6::date else period_start end,
         period_end = case when $7 then $8::date else period_end end, body = case when $9 then $10 else body end,
         hours = case when $11 then $12::numeric else hours end, hours_note = case when $13 then $14 else hours_note end,
         updated_by = $15, updated_at = now()
       where id = $1 and project_id = $2 returning *`,
      [id, projectId, has('title'), input.title ?? null, has('period_start'), input.period_start ?? null, has('period_end'), input.period_end ?? null,
        has('body'), input.body ?? '', has('hours'), input.hours ?? null, has('hours_note'), input.hours_note ?? '', actorId(ctx)],
      c,
    ).catch((e) => {
      if (e.code === '23505') throw conflict(`An update titled "${input.title}" already exists`);
      throw e;
    });
    const changes = diff(before, after, ['title', 'period_start', 'period_end', 'body', 'hours', 'hours_note']);
    if (changes.body) changes.body = { from: `${String(before.body).length} chars`, to: `${String(after.body).length} chars` };
    if (Object.keys(changes).length) await audit(ctx, { action: 'update.edited', entityType: 'update', entityId: id, projectId, summary: `Edited progress update "${after.title}" (${Object.keys(changes).join(', ')})`, changes }, c);
    return id;
  };
  const saved = db ? await run(db) : await tx(run);
  publish({ projectId, type: 'update.saved', actor: ctx.user.name });
  return (await one(`${SELECT} where pu.id = $1`, [saved]))!;
}

export async function deleteUpdate(ctx: Ctx, projectId: string, id: string) {
  await tx(async (c) => {
    await requireProject(ctx, projectId, 'update.write', c);
    const row = await one(`delete from project_updates where id = $1 and project_id = $2 returning title`, [id, projectId], c);
    if (!row) throw notFound('Update not found');
    await audit(ctx, { action: 'update.deleted', entityType: 'update', entityId: id, projectId, summary: `Deleted progress update "${row.title}"` }, c);
  });
  publish({ projectId, type: 'update.saved', actor: ctx.user.name });
}

/** Monday-to-Sunday week containing the given date, as YYYY-MM-DD strings. */
export function weekOf(d = new Date()) {
  const day = (d.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const end = new Date(start.getTime() + 6 * 86400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Title in the sheet's style: "21SEP26 to 27SEP26". */
export function weekTitle(start: string, end: string) {
  const f = (s: string) => `${s.slice(8, 10)}${MON[Number(s.slice(5, 7)) - 1]}${s.slice(2, 4)}`;
  return `${f(start)} to ${f(end)}`;
}
