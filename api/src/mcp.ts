// Model Context Protocol endpoint so Claude can read and update boards directly.
// Stateless Streamable HTTP: every POST /api/mcp builds a server bound to the caller's token.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireProject, requireUser, type Ctx } from './auth.js';
import { one, q } from './db.js';
import { HttpError, unauthorized } from './errors.js';
import { addComment, cardHistory, createCard, getCardForCtx, listCards, listComments, moveCard, PRIORITIES, setArchived, updateCard, type Card } from './services/cards.js';
import { resolveArea, resolveBoard, resolveProject } from './services/common.js';
import { getProject, listProjectsFor, projectSummary, upsertArea } from './services/projects.js';
import { createRequest, getRequestForCtx, listRequests, triage, triageInput } from './services/requests.js';
import { listUpdates, saveUpdate, weekOf, weekTitle } from './services/updates.js';

const brief = (c: Card, full = false) => ({
  key: c.key,
  title: c.title,
  column: c.column_name,
  area: c.area_name,
  priority: c.priority,
  tags: c.tags.length ? c.tags : undefined,
  estimate: c.estimate || undefined,
  assignee: c.assignee_name ?? undefined,
  description: full ? c.description : c.description.length > 160 ? c.description.slice(0, 157) + '…' : c.description || undefined,
  fields: full ? c.fields : undefined,
  updated_at: c.updated_at,
  archived: c.archived_at ? true : undefined,
});

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e: any) {
      const msg = e instanceof HttpError ? e.message : `Unexpected error: ${e?.message ?? e}`;
      return { ...text(msg), isError: true };
    }
  };
}

const projectArg = z.string().describe('Project key (e.g. "SS") or id');
const cardArg = z.string().describe('Card key like "SS-42"');

function buildServer(ctx: Ctx) {
  const server = new McpServer({ name: 'harbormaster', version: '0.2.0' }, {
    instructions:
      'Harbor Master tracks software development as projects > boards > columns > cards. Cards are referenced by key (e.g. SS-42). ' +
      'Start with get_project to learn the boards, column names, card fields and areas. Moving a card to another column is how status changes. ' +
      'Every change you make is recorded in the audit history under your account. Prefer add_comment for notes about work done, ' +
      'and log_progress to add a line to the current week\'s progress update. Feature requests (keys like SS-R4) are separate from cards: ' +
      'use create_request when someone asks for something, and triage_request to accept one into a card.',
  });

  server.registerTool('list_projects', { title: 'List projects', description: 'Projects you can access, with your role and card counts.', inputSchema: {} },
    wrap(async () => (await listProjectsFor(ctx)).map((p) => ({ key: p.key, name: p.name, role: p.my_role, cards: p.card_count, archived: !!p.archived_at }))));

  server.registerTool('get_project', {
    title: 'Get project structure',
    description: 'Boards (with columns, card counts and custom fields), areas and your permissions for a project.',
    inputSchema: { project: projectArg },
  }, wrap(async ({ project }: { project: string }) => {
    const p = await getProject(ctx, (await resolveProject(project)).id);
    return {
      key: p.key, name: p.name, description: p.description, your_permissions: p.permissions,
      boards: p.boards.map((b: any) => ({
        key: b.key, name: b.name, description: b.description, cards: b.card_count, parity_enabled: b.parity_enabled,
        columns: b.columns.map((c: any) => ({ name: c.name, category: c.category, cards: c.card_count, parity_weight: c.parity_weight })),
        fields: b.field_defs,
      })),
      areas: p.areas.map((a: any) => ({ name: a.name, priority: a.priority, expected_date: a.expected_date, notes: a.notes })),
    };
  }));

  server.registerTool('get_summary', {
    title: 'Project summary',
    description: 'Counts per area and column for every board, parity scores, recent activity and the latest progress update.',
    inputSchema: { project: projectArg },
  }, wrap(async ({ project }: { project: string }) => {
    const p = await resolveProject(project);
    const s = await projectSummary(ctx, p.id);
    const areas = new Map((await q(`select id, name from areas where project_id = $1`, [p.id])).map((a) => [a.id, a.name]));
    return {
      boards: s.boards.map((b: any) => {
        const colName = new Map(b.columns.map((c: any) => [c.id, c.name]));
        const named = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).map(([k, v]) => [colName.get(k), v]));
        return {
          board: b.board.name,
          totals: named(b.totals.counts),
          parity: b.board.parity_enabled && b.totals.parity !== null ? `${(b.totals.parity * 100).toFixed(1)}%` : undefined,
          by_area: b.areas.map((a: any) => ({ area: a.area_id ? areas.get(a.area_id) : '(none)', ...named(a.counts), parity: b.board.parity_enabled && a.parity !== null ? `${Math.round(a.parity * 100)}%` : undefined })),
        };
      }),
      latest_update: s.latest_update,
      recent_activity: s.recent.map((r: any) => `${new Date(r.at).toISOString().slice(0, 16)} ${r.actor_name}: ${r.summary}`),
    };
  }));

  server.registerTool('list_cards', {
    title: 'Find cards',
    description: 'Search and filter cards. Returns brief cards; use get_card for full detail.',
    inputSchema: {
      project: projectArg,
      board: z.string().optional().describe('Board key or name'),
      column: z.string().optional().describe('Column name (requires board)'),
      area: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      tag: z.string().optional(),
      query: z.string().optional().describe('Text to match in title, description, fields or key'),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Default 100'),
    },
  }, wrap(async (a: any) => {
    const p = await resolveProject(a.project);
    await requireProject(ctx, p.id, 'project.view');
    const board = a.board ? await resolveBoard(p.id, a.board) : null;
    let columnId: string | undefined;
    if (a.column) {
      if (!board) throw new HttpError(400, 'column filter needs a board');
      const col = await one(`select id from board_columns where board_id = $1 and lower(name) = lower($2)`, [board.id, a.column]);
      if (!col) throw new HttpError(400, `Column "${a.column}" not found`);
      columnId = col.id;
    }
    const cards = await listCards(p.id, {
      boardId: board?.id, columnId, areaId: a.area ? (await resolveArea(p.id, a.area)).id : undefined,
      priority: a.priority, tag: a.tag, query: a.query, includeArchived: a.include_archived, limit: a.limit ?? 100,
    });
    return { count: cards.length, cards: cards.map((c) => brief(c)) };
  }));

  server.registerTool('get_card', {
    title: 'Get card',
    description: 'Full card detail including custom fields, comments and change history.',
    inputSchema: { card: cardArg },
  }, wrap(async ({ card }: { card: string }) => {
    const c = await getCardForCtx(ctx, card);
    const board = await one(`select name from boards where id = $1`, [c.board_id]);
    return {
      ...brief(c, true), board: board?.name, created_at: c.created_at, created_by: c.created_by_name, updated_by: c.updated_by_name,
      comments: (await listComments(c.id)).map((m: any) => ({ at: m.created_at, by: m.author_name, body: m.body })),
      history: (await cardHistory(c.id, 30)).map((h: any) => `${new Date(h.at).toISOString().slice(0, 16)} ${h.actor_name} (${h.via}): ${h.summary}`),
    };
  }));

  server.registerTool('create_card', {
    title: 'Create card',
    description: 'Create a card on a board. Fields must match the board\'s custom field keys (see get_project).',
    inputSchema: {
      project: projectArg,
      board: z.string().describe('Board key or name'),
      title: z.string(),
      description: z.string().optional().describe('Markdown'),
      column: z.string().optional().describe('Defaults to the first column'),
      area: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      tags: z.array(z.string()).optional(),
      estimate: z.string().optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      position: z.enum(['top', 'bottom']).optional(),
    },
  }, wrap(async (a: any) => {
    const p = await resolveProject(a.project);
    await requireProject(ctx, p.id, 'project.view');
    const board = await resolveBoard(p.id, a.board);
    const { project: _p, board: _b, ...input } = a;
    return brief(await createCard(ctx, p.id, board.id, input), true);
  }));

  server.registerTool('update_card', {
    title: 'Update card',
    description: 'Change card details. Only the arguments you pass are changed. fields are merged; set a field to null to clear it. Use move_card to change column.',
    inputSchema: {
      card: cardArg,
      title: z.string().optional(),
      description: z.string().optional().describe('Markdown; replaces the whole description'),
      area: z.string().nullable().optional(),
      priority: z.enum(PRIORITIES).nullable().optional(),
      tags: z.array(z.string()).optional().describe('Replaces all tags'),
      estimate: z.string().optional(),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD'),
      fields: z.record(z.string(), z.unknown()).optional(),
    },
  }, wrap(async ({ card, ...patch }: any) => {
    const c = await getCardForCtx(ctx, card);
    return brief(await updateCard(ctx, c.id, patch), true);
  }));

  server.registerTool('move_card', {
    title: 'Move card',
    description: 'Move a card to another column on its board (this is how status changes), optionally with a comment explaining why.',
    inputSchema: {
      card: cardArg,
      column: z.string().describe('Target column name'),
      position: z.enum(['top', 'bottom']).optional().describe('Default bottom'),
      comment: z.string().optional().describe('Optional note added as a comment'),
    },
  }, wrap(async ({ card, column, position, comment }: any) => {
    const c = await getCardForCtx(ctx, card);
    const moved = await moveCard(ctx, c.id, column, position ?? 'bottom');
    if (comment) await addComment(ctx, c.id, comment);
    return brief(moved);
  }));

  server.registerTool('add_comment', {
    title: 'Comment on card',
    description: 'Add a markdown comment to a card, e.g. what was done, commit hashes, test results.',
    inputSchema: { card: cardArg, body: z.string() },
  }, wrap(async ({ card, body }: any) => {
    const c = await getCardForCtx(ctx, card);
    await addComment(ctx, c.id, body);
    return `Comment added to ${c.key}`;
  }));

  server.registerTool('archive_card', {
    title: 'Archive or restore card',
    description: 'Archive (hide) a card or restore it.',
    inputSchema: { card: cardArg, archived: z.boolean().default(true) },
  }, wrap(async ({ card, archived }: any) => {
    const c = await getCardForCtx(ctx, card);
    return brief(await setArchived(ctx, c.id, archived ?? true));
  }));

  server.registerTool('update_area', {
    title: 'Update area',
    description: 'Set an area\'s priority, expected date or notes (the "By area" summary table). Creates the area if it does not exist.',
    inputSchema: { project: projectArg, area: z.string(), priority: z.string().optional(), expected_date: z.string().optional(), notes: z.string().optional() },
  }, wrap(async ({ project, area, ...rest }: any) => {
    const p = await resolveProject(project);
    const existing = await one(`select id from areas where project_id = $1 and lower(name) = lower($2)`, [p.id, area]);
    return upsertArea(ctx, p.id, existing?.id ?? null, existing ? rest : { name: area, ...rest });
  }));

  server.registerTool('list_updates', {
    title: 'List progress updates',
    description: 'Weekly progress updates, newest first.',
    inputSchema: { project: projectArg, limit: z.number().int().min(1).max(50).optional() },
  }, wrap(async ({ project, limit }: any) => {
    const p = await resolveProject(project);
    return (await listUpdates(ctx, p.id, limit ?? 5)).map((u: any) => ({ title: u.title, period_start: u.period_start, period_end: u.period_end, hours: u.hours, hours_note: u.hours_note, body: u.body, updated_at: u.updated_at }));
  }));

  server.registerTool('log_progress', {
    title: 'Log progress',
    description:
      'Append bullet lines to a weekly progress update, creating the week (Monday to Sunday) if needed. ' +
      'Defaults to the current week. Optionally add hours to the week\'s running total.',
    inputSchema: {
      project: projectArg,
      lines: z.array(z.string()).min(1).describe('Each becomes a "- " bullet, e.g. "Two-factor login: backup codes (~2 h)"'),
      date: z.string().optional().describe('Any YYYY-MM-DD inside the target week; default today'),
      add_hours: z.number().min(0).max(200).optional(),
    },
  }, wrap(async ({ project, lines, date, add_hours }: any) => {
    const p = await resolveProject(project);
    const wk = weekOf(date ? new Date(`${date}T12:00:00Z`) : new Date());
    const title = weekTitle(wk.start, wk.end);
    const cur = await one(`select id, body, hours from project_updates where project_id = $1 and (title = $2 or period_start = $3) order by title = $2 desc limit 1`, [p.id, title, wk.start]);
    const bullets = lines.map((l: string) => `- ${l.replace(/^\s*[-•*]\s*/, '').trim()}`).join('\n');
    const hours = add_hours ? Number(cur?.hours ?? 0) + add_hours : undefined;
    const saved = cur
      ? await saveUpdate(ctx, p.id, cur.id, { body: `${cur.body.trimEnd()}\n${bullets}`.trim(), ...(hours !== undefined ? { hours } : {}) })
      : await saveUpdate(ctx, p.id, null, { title, period_start: wk.start, period_end: wk.end, body: bullets, hours: hours ?? null });
    return { title: saved.title, hours: saved.hours, lines: saved.body.split('\n').length };
  }));

  server.registerTool('save_update', {
    title: 'Write progress update',
    description: 'Create or replace a progress update by title (e.g. "12OCT26 to 18OCT26"). Replaces the body when it exists.',
    inputSchema: {
      project: projectArg,
      title: z.string(),
      body: z.string().describe('Markdown'),
      period_start: z.string().optional(),
      period_end: z.string().optional(),
      hours: z.number().nullable().optional(),
      hours_note: z.string().optional(),
    },
  }, wrap(async ({ project, title, ...rest }: any) => {
    const p = await resolveProject(project);
    const cur = await one(`select id from project_updates where project_id = $1 and title = $2`, [p.id, title]);
    const saved = await saveUpdate(ctx, p.id, cur?.id ?? null, { title, ...rest });
    return { title: saved.title, updated_at: saved.updated_at };
  }));

  server.registerTool('list_requests', {
    title: 'List feature requests',
    description: 'Feature requests on a project, most voted first. Status "open" (default) means new or under review.',
    inputSchema: {
      project: projectArg,
      status: z.enum(['open', 'new', 'reviewing', 'accepted', 'declined', 'duplicate', 'all']).optional(),
      query: z.string().optional(),
    },
  }, wrap(async ({ project, status, query }: any) => {
    const p = await resolveProject(project);
    const rows = await listRequests(ctx, p.id, { status: status ?? 'open', query });
    return rows.map((r) => ({
      key: r.key, title: r.title, status: r.status, votes: r.votes, area: r.area_name ?? undefined, requested_by: r.requested_by_name,
      requested_for: r.requested_for || undefined, card: r.card_key ?? undefined, comments: r.comment_count,
      description: r.description.length > 200 ? r.description.slice(0, 197) + '…' : r.description || undefined,
    }));
  }));

  server.registerTool('create_request', {
    title: 'Submit feature request',
    description: 'File a feature request on a project, e.g. something a user asked for. Use requested_for to name who asked.',
    inputSchema: {
      project: projectArg,
      title: z.string(),
      description: z.string().optional().describe('Markdown: what is wanted and why'),
      area: z.string().optional(),
      requested_for: z.string().optional().describe('Who asked for it, e.g. "Mark (CSG)"'),
    },
  }, wrap(async ({ project, ...input }: any) => {
    const p = await resolveProject(project);
    const r = await createRequest(ctx, p.id, input);
    return { key: r.key, title: r.title, status: r.status };
  }));

  server.registerTool('triage_request', {
    title: 'Triage feature request',
    description:
      'Move a feature request: "review" (start reviewing), "accept" (creates a card on the given board), "decline" (note required), ' +
      '"duplicate" (of another request key), or "reopen".',
    inputSchema: {
      request: z.string().describe('Request key like "SS-R4"'),
      action: z.enum(['review', 'accept', 'decline', 'duplicate', 'reopen']),
      board: z.string().optional().describe('For accept: board key or name'),
      column: z.string().optional().describe('For accept: column name, default first column'),
      priority: z.enum(PRIORITIES).optional(),
      of: z.string().optional().describe('For duplicate: the request key it duplicates'),
      note: z.string().optional(),
    },
  }, wrap(async ({ request, ...rest }: any) => {
    const { request: r } = await getRequestForCtx(ctx, request);
    const input = triageInput.parse(rest);
    const after = await triage(ctx, r.id, input);
    return { key: after.key, status: after.status, card: after.card_key ?? undefined };
  }));

  return server;
}

export default async function mcpRoutes(app: FastifyInstance) {
  app.post('/api/mcp', async (req, reply) => {
    await authenticate(req, 'mcp');
    if (!req.ctx || !req.ctx.tokenId) throw unauthorized('Use an API token: Authorization: Bearer hsl_…');
    const ctx = requireUser(req);
    const server = buildServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: any) => reply.code(405).header('allow', 'POST').send({ error: 'Method not allowed' });
  app.get('/api/mcp', notAllowed);
  app.delete('/api/mcp', notAllowed);
}
