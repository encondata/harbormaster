import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireProject, requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { publish } from '../events.js';
import {
  addComment, cardHistory, cardInput, cardPatch, createCard, deleteComment, getCardForCtx, listCards, listComments, moveCard, setArchived, updateCard,
} from '../services/cards.js';
import { resolveArea, resolveBoard, resolveProject } from '../services/common.js';
import { requestForCard } from '../services/requests.js';
import { deleteObject, getObject, putObject } from '../storage.js';
import { parse } from '../validate.js';

export default async function cardRoutes(app: FastifyInstance) {
  app.get('/api/projects/:project/cards', async (req) => {
    const ctx = requireUser(req);
    const project = await resolveProject((req.params as any).project);
    await requireProject(ctx, project.id, 'project.view');
    const f = req.query as Record<string, string | undefined>;
    const board = f.board ? await resolveBoard(project.id, f.board) : null;
    return listCards(project.id, {
      boardId: board?.id,
      areaId: f.area ? (await resolveArea(project.id, f.area)).id : undefined,
      columnId: f.column_id,
      priority: f.priority,
      tag: f.tag,
      assigneeId: f.assignee_id,
      query: f.q,
      includeArchived: f.archived === 'true',
      limit: f.limit ? Number(f.limit) : undefined,
      offset: f.offset ? Number(f.offset) : undefined,
    });
  });

  app.post('/api/projects/:project/boards/:board/cards', async (req) => {
    const ctx = requireUser(req);
    const project = await resolveProject((req.params as any).project);
    await requireProject(ctx, project.id, 'project.view');
    const board = await resolveBoard(project.id, (req.params as any).board);
    return createCard(ctx, project.id, board.id, parse(cardInput, req.body));
  });

  app.get('/api/cards/:card', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    const [comments, attachments, history, request] = await Promise.all([
      listComments(card.id),
      q(`select a.id, a.filename, a.content_type, a.size_bytes, a.created_at, u.name as uploaded_by_name from attachments a left join users u on u.id = a.uploaded_by where a.card_id = $1 order by a.created_at`, [card.id]),
      cardHistory(card.id),
      requestForCard(card.id),
    ]);
    return { ...card, comments, attachments, history, request: request ?? null };
  });

  app.patch('/api/cards/:card', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    return updateCard(ctx, card.id, parse(cardPatch, req.body));
  });

  app.post('/api/cards/:card/move', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    const body = parse(z.object({ column: z.string().min(1), index: z.union([z.number().int().min(0), z.enum(['top', 'bottom'])]).optional() }), req.body);
    return moveCard(ctx, card.id, body.column, body.index ?? 'bottom');
  });

  app.post('/api/cards/:card/archive', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    const body = parse(z.object({ archived: z.boolean() }), req.body);
    return setArchived(ctx, card.id, body.archived);
  });

  app.post('/api/cards/:card/comments', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    const body = parse(z.object({ body: z.string() }), req.body);
    return addComment(ctx, card.id, body.body);
  });

  app.delete('/api/comments/:id', async (req) => {
    await deleteComment(requireUser(req), (req.params as any).id);
    return { ok: true };
  });

  // ----- attachments (stored in MinIO, always streamed through the API) -----
  app.post('/api/cards/:card/attachments', async (req) => {
    const ctx = requireUser(req);
    const card = await getCardForCtx(ctx, (req.params as any).card);
    await requireProject(ctx, card.project_id, 'attachment.upload');
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest('No file attached');
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`File is larger than ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    const filename = (file.filename || 'file').replace(/[\\/\0\r\n]/g, '_').slice(0, 200);
    const key = `projects/${card.project_id}/cards/${card.id}/${randomUUID()}`;
    const contentType = file.mimetype || 'application/octet-stream';
    await putObject(key, data, contentType);
    const row = await one(
      `insert into attachments (card_id, project_id, filename, content_type, size_bytes, object_key, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7) returning id, filename, content_type, size_bytes, created_at`,
      [card.id, card.project_id, filename, contentType, data.length, key, ctx.user.id],
    );
    await audit(ctx, { action: 'attachment.added', entityType: 'card', entityId: card.id, projectId: card.project_id, summary: `Attached "${filename}" to ${card.key}` });
    publish({ projectId: card.project_id, type: 'card.updated', boardId: card.board_id, cardId: card.id, actor: ctx.user.name });
    return row;
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const ctx = requireUser(req);
    const a = await one(`select * from attachments where id = $1`, [(req.params as any).id]);
    if (!a) throw notFound('Attachment not found');
    await requireProject(ctx, a.project_id, 'project.view');
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(a.content_type) && (req.query as any).download !== '1';
    reply
      .header('content-type', a.content_type)
      .header('content-length', a.size_bytes)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(await getObject(a.object_key));
  });

  app.delete('/api/attachments/:id', async (req) => {
    const ctx = requireUser(req);
    const a = await one(`select a.*, p.key || '-' || c.number as card_key, c.board_id from attachments a join cards c on c.id = a.card_id join projects p on p.id = a.project_id where a.id = $1`, [(req.params as any).id]);
    if (!a) throw notFound('Attachment not found');
    const perms = await requireProject(ctx, a.project_id, 'project.view');
    if (!perms.has('attachment.delete') && a.uploaded_by !== ctx.user.id) throw badRequest('You can only delete attachments you uploaded');
    await q(`delete from attachments where id = $1`, [a.id]);
    await deleteObject(a.object_key).catch(() => {});
    await audit(ctx, { action: 'attachment.deleted', entityType: 'card', entityId: a.card_id, projectId: a.project_id, summary: `Removed attachment "${a.filename}" from ${a.card_key}` });
    publish({ projectId: a.project_id, type: 'card.updated', boardId: a.board_id, cardId: a.card_id, actor: ctx.user.name });
    return { ok: true };
  });
}
