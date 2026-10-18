// Feature requests: submitted by project members, voted on, triaged, and accepted into cards.
import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { publish } from '../events.js';
import { createCard } from './cards.js';
import { resolveArea, resolveBoard, UUID_RE } from './common.js';

export const REQUEST_STATUSES = ['new', 'reviewing', 'accepted', 'declined', 'duplicate'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const SELECT = `
  select r.id, r.project_id, p.key || '-R' || r.number as key, r.number, r.title, r.description, r.status,
         r.area_id, a.name as area_name, r.requested_by, ru.name as requested_by_name, ru.kind as requested_by_kind, r.requested_for,
         r.card_id, cp.key || '-' || c.number as card_key, c.title as card_title, bc.name as card_column, cb.key as card_board_key,
         r.duplicate_of, dp.key || '-R' || d.number as duplicate_key, d.title as duplicate_title,
         r.decision_note, r.decided_by, du.name as decided_by_name, r.decided_at, r.created_at, r.updated_at,
         (select count(*) from request_votes v where v.request_id = r.id) as votes,
         (select count(*) from request_comments rc where rc.request_id = r.id and rc.deleted_at is null) as comment_count
    from feature_requests r
    join projects p on p.id = r.project_id
    left join areas a on a.id = r.area_id
    left join users ru on ru.id = r.requested_by
    left join users du on du.id = r.decided_by
    left join cards c on c.id = r.card_id
    left join projects cp on cp.id = c.project_id
    left join board_columns bc on bc.id = c.column_id
    left join boards cb on cb.id = c.board_id
    left join feature_requests d on d.id = r.duplicate_of
    left join projects dp on dp.id = d.project_id`;

export type FeatureRequest = {
  id: string; project_id: string; key: string; number: number; title: string; description: string; status: RequestStatus;
  area_id: string | null; area_name: string | null; requested_by: string | null; requested_by_name: string | null; requested_by_kind: string | null;
  requested_for: string; card_id: string | null; card_key: string | null; card_title: string | null; card_column: string | null; card_board_key: string | null;
  duplicate_of: string | null; duplicate_key: string | null; duplicate_title: string | null; decision_note: string;
  decided_by: string | null; decided_by_name: string | null; decided_at: string | null; created_at: string; updated_at: string;
  votes: number; comment_count: number;
};

const actorId = (ctx: Ctx) => (ctx.via === 'system' ? null : ctx.user.id);

export async function loadRequest(id: string, db?: Db): Promise<FeatureRequest> {
  const r = await one<FeatureRequest>(`${SELECT} where r.id = $1`, [id], db);
  if (!r) throw notFound('Feature request not found');
  return r;
}

/** Accepts a uuid or a key like "SS-R12". */
export async function resolveRequestId(ref: string, db?: Db): Promise<string> {
  const s = ref.trim();
  if (UUID_RE.test(s)) return s;
  const m = /^([A-Za-z][A-Za-z0-9]*)-R(\d+)$/i.exec(s);
  const row = m ? await one<{ id: string }>(`select r.id from feature_requests r join projects p on p.id = r.project_id where p.key = upper($1) and r.number = $2`, [m[1], Number(m[2])], db) : undefined;
  if (!row) throw notFound(`Feature request ${ref} not found`);
  return row.id;
}

export async function getRequestForCtx(ctx: Ctx, ref: string) {
  const r = await loadRequest(await resolveRequestId(ref));
  const perms = await requireProject(ctx, r.project_id, 'project.view');
  return { request: r, perms };
}

export async function listRequests(ctx: Ctx, projectId: string, f: { status?: string; query?: string; sort?: string }) {
  await requireProject(ctx, projectId, 'project.view');
  const where = ['r.project_id = $1'];
  const params: unknown[] = [projectId, ctx.user.id];
  if (f.status === 'open') where.push(`r.status in ('new', 'reviewing')`);
  else if (f.status && f.status !== 'all') {
    params.push(f.status);
    where.push(`r.status = $${params.length}`);
  }
  if (f.query) {
    params.push(`%${f.query.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    where.push(`(r.title ilike $${params.length} or r.description ilike $${params.length} or r.requested_for ilike $${params.length})`);
  }
  const order = f.sort === 'new' ? 'r.created_at desc' : f.sort === 'updated' ? 'r.updated_at desc' : 'votes desc, r.created_at desc';
  return q<FeatureRequest & { voted: boolean }>(
    `select x.*, exists (select 1 from request_votes v where v.request_id = x.id and v.user_id = $2) as voted
       from (${SELECT} where ${where.join(' and ')}) x order by ${order.replace(/r\./g, 'x.')} limit 500`,
    params,
  );
}

export const requestInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).optional(),
  area: z.string().nullable().optional(),
  requested_for: z.string().trim().max(200).optional(),
});

export async function createRequest(ctx: Ctx, projectId: string, input: z.infer<typeof requestInput>) {
  const r = await tx(async (c) => {
    await requireProject(ctx, projectId, 'request.create', c);
    const areaId = input.area ? (await resolveArea(projectId, input.area, c)).id : null;
    const { n } = (await one<{ n: number }>(`update projects set next_request_number = next_request_number + 1 where id = $1 returning next_request_number - 1 as n`, [projectId], c))!;
    const row = (await one<{ id: string }>(
      `insert into feature_requests (project_id, number, title, description, area_id, requested_by, requested_for) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [projectId, n, input.title, input.description ?? '', areaId, actorId(ctx), input.requested_for ?? ''],
      c,
    ))!;
    // Submitting counts as the first vote.
    if (actorId(ctx)) await c.query(`insert into request_votes (request_id, user_id) values ($1, $2) on conflict do nothing`, [row.id, actorId(ctx)]);
    const r = await loadRequest(row.id, c);
    await audit(ctx, { action: 'request.created', entityType: 'request', entityId: r.id, projectId, summary: `Submitted feature request ${r.key} "${r.title}"${r.requested_for ? ` for ${r.requested_for}` : ''}` }, c);
    return r;
  });
  publish({ projectId, type: 'request.created', actor: ctx.user.name });
  return r;
}

export async function updateRequest(ctx: Ctx, id: string, patch: Partial<z.infer<typeof requestInput>>) {
  const r = await tx(async (c) => {
    const before = await loadRequest(id, c);
    const perms = await requireProject(ctx, before.project_id, 'project.view', c);
    const own = before.requested_by === ctx.user.id && perms.has('request.create');
    if (!own && !perms.has('request.triage')) throw forbidden('Only the submitter or someone who triages requests can edit this');
    const areaId = patch.area === undefined ? undefined : patch.area ? (await resolveArea(before.project_id, patch.area, c)).id : null;
    await c.query(
      `update feature_requests set title = coalesce($2, title), description = coalesce($3, description), requested_for = coalesce($4, requested_for),
         area_id = case when $5::boolean then $6::uuid else area_id end, updated_at = now() where id = $1`,
      [id, patch.title ?? null, patch.description ?? null, patch.requested_for ?? null, areaId !== undefined, areaId ?? null],
    );
    const after = await loadRequest(id, c);
    const changes = diff(before, after, ['title', 'description', 'requested_for', 'area_name']);
    if (Object.keys(changes).length) await audit(ctx, { action: 'request.updated', entityType: 'request', entityId: id, projectId: after.project_id, summary: `Edited ${after.key}: ${Object.keys(changes).map((k) => k.replace(/_name$/, '')).join(', ')}`, changes }, c);
    return after;
  });
  publish({ projectId: r.project_id, type: 'request.updated', actor: ctx.user.name });
  return r;
}

export async function vote(ctx: Ctx, id: string, on: boolean) {
  const r = await loadRequest(id);
  await requireProject(ctx, r.project_id, 'request.create');
  if (on) await q(`insert into request_votes (request_id, user_id) values ($1, $2) on conflict do nothing`, [id, ctx.user.id]);
  else await q(`delete from request_votes where request_id = $1 and user_id = $2`, [id, ctx.user.id]);
  publish({ projectId: r.project_id, type: 'request.voted', actor: ctx.user.name });
  return loadRequest(id);
}

export async function listRequestComments(id: string) {
  return q(
    `select rc.id, rc.body, rc.created_at, rc.author_id, u.name as author_name, u.kind as author_kind
       from request_comments rc left join users u on u.id = rc.author_id where rc.request_id = $1 and rc.deleted_at is null order by rc.created_at`,
    [id],
  );
}

export async function commentOnRequest(ctx: Ctx, id: string, body: string) {
  const text = body.trim();
  if (!text) throw badRequest('Comment is empty');
  if (text.length > 20000) throw badRequest('Comment is too long');
  const r = await loadRequest(id);
  await tx(async (c) => {
    await requireProject(ctx, r.project_id, 'request.create', c);
    await c.query(`insert into request_comments (request_id, author_id, body) values ($1, $2, $3)`, [id, actorId(ctx), text]);
    await c.query(`update feature_requests set updated_at = now() where id = $1`, [id]);
    await audit(ctx, { action: 'request.commented', entityType: 'request', entityId: id, projectId: r.project_id, summary: `Commented on ${r.key}`, changes: { comment: text.slice(0, 500) } }, c);
  });
  publish({ projectId: r.project_id, type: 'request.updated', actor: ctx.user.name });
}

export const triageInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), note: z.string().max(5000).optional() }),
  z.object({ action: z.literal('reopen'), note: z.string().max(5000).optional() }),
  z.object({ action: z.literal('decline'), note: z.string({ error: 'Say why the request is declined' }).trim().min(1, 'Say why the request is declined').max(5000) }),
  z.object({ action: z.literal('duplicate'), of: z.string().min(1), note: z.string().max(5000).optional() }),
  z.object({
    action: z.literal('accept'),
    board: z.string().min(1),
    column: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().optional(),
    note: z.string().max(5000).optional(),
  }),
]);

const STATUS_WORD: Record<string, string> = { review: 'Started reviewing', reopen: 'Reopened', decline: 'Declined', duplicate: 'Closed as duplicate', accept: 'Accepted' };

export async function triage(ctx: Ctx, id: string, input: z.infer<typeof triageInput>) {
  const r = await tx(async (c) => {
    const before = await loadRequest(id, c);
    await requireProject(ctx, before.project_id, 'request.triage', c);
    let status: RequestStatus = before.status;
    let cardId: string | null = before.card_id;
    let dupId: string | null = before.duplicate_of;
    let extra = '';
    switch (input.action) {
      case 'review':
        if (before.status !== 'new') throw badRequest('Only new requests can move to review');
        status = 'reviewing';
        break;
      case 'reopen':
        if (before.status === 'new' || before.status === 'reviewing') throw badRequest('This request is already open');
        status = 'reviewing';
        dupId = null;
        break;
      case 'decline':
        if (before.status === 'accepted') throw badRequest('This request already has a card; archive the card instead');
        status = 'declined';
        break;
      case 'duplicate': {
        const other = await loadRequest(await resolveRequestId(input.of, c), c);
        if (other.id === id) throw badRequest('A request cannot duplicate itself');
        if (other.project_id !== before.project_id) throw badRequest('Pick a request from the same project');
        status = 'duplicate';
        dupId = other.id;
        extra = ` of ${other.key}`;
        // Carry votes over to the request that stays open.
        await c.query(`insert into request_votes (request_id, user_id) select $1, user_id from request_votes where request_id = $2 on conflict do nothing`, [other.id, id]);
        break;
      }
      case 'accept': {
        if (before.status === 'accepted') throw badRequest('This request is already accepted');
        const board = await resolveBoard(before.project_id, input.board, c);
        const desc = [before.description, '', `From feature request ${before.key}${before.requested_for ? ` (requested for ${before.requested_for})` : ''}.`].join('\n').trim();
        const card = await createCard(ctx, before.project_id, board.id, {
          title: before.title, description: desc, column: input.column, area: before.area_id ?? undefined, priority: input.priority ?? null,
        }, c);
        cardId = card.id;
        status = 'accepted';
        extra = ` as card ${card.key} on ${board.name}`;
        break;
      }
    }
    const closing = ['accepted', 'declined', 'duplicate'].includes(status);
    await c.query(
      `update feature_requests set status = $2, card_id = $3, duplicate_of = $4, decision_note = $5,
         decided_by = $6, decided_at = $7, updated_at = now() where id = $1`,
      [id, status, cardId, dupId, input.note ?? (closing ? before.decision_note : ''), closing ? actorId(ctx) : null, closing ? new Date() : null],
    );
    const after = await loadRequest(id, c);
    await audit(ctx, {
      action: `request.${input.action === 'review' || input.action === 'reopen' ? 'reviewing' : input.action === 'accept' ? 'accepted' : input.action === 'decline' ? 'declined' : 'duplicate'}`,
      entityType: 'request', entityId: id, projectId: after.project_id,
      summary: `${STATUS_WORD[input.action]} ${after.key} "${after.title}"${extra}${input.note ? `: ${input.note.slice(0, 200)}` : ''}`,
      changes: { status: { from: before.status, to: after.status } },
    }, c);
    return after;
  });
  publish({ projectId: r.project_id, type: 'request.updated', actor: ctx.user.name });
  return r;
}

export async function requestHistory(id: string) {
  return q(`select id, at, actor_name, via, action, summary from audit_log where entity_type = 'request' and entity_id = $1 order by at desc, id desc limit 100`, [id]);
}

/** The request a card came from, if any. */
export async function requestForCard(cardId: string) {
  return one<{ id: string; key: string; title: string }>(
    `select r.id, p.key || '-R' || r.number as key, r.title from feature_requests r join projects p on p.id = r.project_id where r.card_id = $1`,
    [cardId],
  );
}

export async function openRequestCount(projectId: string) {
  return (await one<{ n: number }>(`select count(*) as n from feature_requests where project_id = $1 and status = 'new'`, [projectId]))!.n;
}
