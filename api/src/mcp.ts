// Model Context Protocol endpoint so Claude can read and update boards directly.
// Stateless Streamable HTTP: every POST /api/mcp builds a server bound to the caller's token.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireProject, requireUser, type Ctx } from './auth.js';
import { config } from './config.js';
import { one, q } from './db.js';
import { HttpError } from './errors.js';
import { resourceMetadataUrl } from './routes/oauth.js';
import { addComment, cardHistory, createCard, getCardForCtx, listCards, listComments, moveCard, PRIORITIES, setArchived, updateCard, type Card } from './services/cards.js';
import { resolveArea, resolveBoard, resolveProject } from './services/common.js';
import { getProject, listProjectsFor, projectSummary, upsertArea } from './services/projects.js';
import { createRequest, getRequestForCtx, listRequests, triage, triageInput } from './services/requests.js';
import { getSkill, listSkills, MANIFEST, publishSkill } from './services/skills.js';
import { listUpdates, saveUpdate, weekOf, weekTitle } from './services/updates.js';
import {
  addWikiComment, createPage, deletePage, getPage, listComments as listWikiComments, loadAccess, movePage, pageHistory, savePage, searchWiki, wikiTags, wikiTree,
} from './services/wiki.js';

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
  const server = new McpServer({
    name: 'harbormaster',
    title: 'Harbor Master',
    version: '0.3.0',
    websiteUrl: config.publicUrl,
    icons: [
      { src: `${config.publicUrl}/logo.png`, mimeType: 'image/png', sizes: ['512x512'] },
      { src: `${config.publicUrl}/favicon-64.png`, mimeType: 'image/png', sizes: ['64x64'] },
    ],
  }, {
    instructions:
      'Harbor Master tracks software development as projects > boards > columns > cards. Cards are referenced by key (e.g. SS-42). ' +
      'Start with get_project to learn the boards, column names, card fields and areas. Moving a card to another column is how status changes. ' +
      'Every change you make is recorded in the audit history under your account. Prefer add_comment for notes about work done, ' +
      'and log_progress to add a line to the current week\'s progress update. Feature requests (keys like SS-R4) are separate from cards: ' +
      'use create_request when someone asks for something, and triage_request to accept one into a card. ' +
      'Harbor Master is also the home of the team\'s Claude Code skills: list_skills, get_skill (install or update one under ~/.claude) and publish_skill. ' +
      'The wiki (wiki_* tools) holds markdown pages in folders; every save is a new version. Each project has a folder with Design and Operations ' +
      'subfolders, addressable by project key, e.g. "SS/Design". Read a page before updating it and pass its version as base_version.',
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

  // ---- Wiki ----
  const pageArg = z.string().describe('Page id, or its path "Folder/Sub/Title" (a project\'s folder can be named by its key: "SS/Design/Auth flow")');
  const folderArg = z.string().describe('Folder path, e.g. "SS/Design" or "Team/Runbooks"; "" is the top level');
  const tagsArg = z.array(z.string()).optional().describe('Tags, e.g. ["api", "auth"]');

  server.registerTool('wiki_tree', {
    title: 'Wiki contents',
    description: 'Folders and pages you can see, as paths. Pass a folder to list only what is under it.',
    inputSchema: { folder: z.string().optional().describe('Only under this folder path, e.g. "SS"') },
  }, wrap(async ({ folder }: { folder?: string }) => {
    const t = await wikiTree(ctx);
    const a = await loadAccess(ctx);
    const pathOf = (id: string | null) => a.path(id).join('/');
    let root: string | null = null;
    if (folder?.trim()) root = await a.folderByPath(folder);
    const under = (id: string | null) => root === null || id === root || (id !== null && a.isWithin(id, root));
    return {
      folders: t.folders.filter((f) => under(f.id)).map((f) => ({ path: pathOf(f.id), ...(f.project_key ? { project: f.project_key, kind: f.system_kind } : {}), can_edit: f.level === 'edit' })),
      pages: t.pages.filter((p) => under(p.folder_id)).map((p) => ({ id: p.id, path: p.path, version: p.current_version, tags: p.tags.length ? p.tags : undefined, updated_at: p.updated_at })),
    };
  }));

  server.registerTool('wiki_search', {
    title: 'Search the wiki',
    description: 'Full-text search over page titles and content. Words starting with # (or the tag argument) narrow to tagged pages.',
    inputSchema: { query: z.string().describe('Words to find, e.g. "deploy minio" or "#runbook backup"'), tag: z.string().optional() },
  }, wrap(async ({ query, tag }: { query: string; tag?: string }) =>
    (await searchWiki(ctx, query, { tag, limit: 20 })).map((p) => ({ id: p.id, path: [...p.path, p.title].join('/'), tags: p.tags, snippet: p.snippet, updated_at: p.updated_at }))));

  server.registerTool('wiki_tags', {
    title: 'Wiki tags',
    description: 'Every tag in use, with how many pages have it.',
    inputSchema: {},
  }, wrap(async () => wikiTags(ctx)));

  server.registerTool('wiki_get_page', {
    title: 'Read a wiki page',
    description: 'A page\'s markdown, tags and version (the current one, or an older one). Use the returned version as base_version when you update it.',
    inputSchema: { page: pageArg, version: z.number().int().positive().optional() },
  }, wrap(async ({ page, version }: { page: string; version?: number }) => {
    const p = await getPage(ctx, page, version);
    return {
      id: p.id, path: [...p.path, p.title].join('/'), title: p.title, tags: p.tags, project: p.project_key ?? undefined,
      version: p.version, current_version: p.current_version, updated_by: p.updated_by_name, updated_at: p.updated_at,
      open_comments: p.open_comments, can_edit: p.can_edit, content: p.content,
    };
  }));

  server.registerTool('wiki_create_page', {
    title: 'Create a wiki page',
    description: 'A new markdown page. The folder is created if it does not exist (inside folders you can edit).',
    inputSchema: {
      folder: folderArg, title: z.string().describe('Page title (no "/")'), content: z.string().describe('Markdown'),
      tags: tagsArg, summary: z.string().optional().describe('Note for the history, e.g. "First draft"'),
    },
  }, wrap(async ({ folder, title, content, tags, summary }: { folder: string; title: string; content: string; tags?: string[]; summary?: string }) => {
    const a = await loadAccess(ctx);
    const folderId = folder.trim() ? await a.folderByPath(folder, true) : null;
    const p = await createPage(ctx, { folder_id: folderId, title, content, tags, summary }, a);
    return { id: p.id, path: [...p.path, p.title].join('/'), version: p.version };
  }));

  server.registerTool('wiki_update_page', {
    title: 'Update a wiki page',
    description: 'Save a new version. Pass the version you read as base_version; if someone saved in between, this fails and you should re-read and redo the change. Omitted fields stay as they are.',
    inputSchema: {
      page: pageArg, base_version: z.number().int().positive(), content: z.string().optional().describe('The whole new markdown'),
      title: z.string().optional(), tags: tagsArg, summary: z.string().optional().describe('What changed, for the history'),
    },
  }, wrap(async ({ page, ...rest }: any) => savePage(ctx, page, rest)));

  server.registerTool('wiki_move_page', {
    title: 'Move a wiki page',
    description: 'Move a page to another folder (created if missing).',
    inputSchema: { page: pageArg, folder: folderArg },
  }, wrap(async ({ page, folder }: { page: string; folder: string }) => {
    const a = await loadAccess(ctx);
    await movePage(ctx, page, folder.trim() ? await a.folderByPath(folder, true) : null);
    return 'Moved';
  }));

  server.registerTool('wiki_delete_page', {
    title: 'Delete a wiki page',
    description: 'Move a page to the wiki trash (a wiki manager can restore it). Only when asked.',
    inputSchema: { page: pageArg },
  }, wrap(async ({ page }: { page: string }) => { await deletePage(ctx, page); return 'Moved to the trash'; }));

  server.registerTool('wiki_history', {
    title: 'Wiki page history',
    description: 'Every saved version of a page: who, when, and the edit note.',
    inputSchema: { page: pageArg },
  }, wrap(async ({ page }: { page: string }) => pageHistory(ctx, page)));

  server.registerTool('wiki_comments', {
    title: 'Comments on a wiki page',
    description: 'Comments and replies on a page, including whether each thread is resolved.',
    inputSchema: { page: pageArg },
  }, wrap(async ({ page }: { page: string }) => (await listWikiComments(ctx, page)).map((c: any) => ({
    id: c.id, reply_to: c.parent_id ?? undefined, author: c.author_name, body: c.body, on_version: c.page_version, at: c.created_at, resolved: c.resolved_at ? true : undefined,
  }))));

  server.registerTool('wiki_add_comment', {
    title: 'Comment on a wiki page',
    description: 'Add a comment, or reply to one (reply_to = its id).',
    inputSchema: { page: pageArg, body: z.string().describe('Markdown'), reply_to: z.string().optional() },
  }, wrap(async ({ page, body, reply_to }: { page: string; body: string; reply_to?: string }) => addWikiComment(ctx, page, { body, parent_id: reply_to ?? null })));

  server.registerTool('list_skills', {
    title: 'List Claude skills',
    description: 'Claude Code skills hosted in Harbor Master, with their latest version. Compare with ~/.claude/skills/<name>/' + MANIFEST + ' to see what is installed and whether it is current.',
    inputSchema: {},
  }, wrap(async () => (await listSkills()).map((s: any) => ({
    name: s.name, version: s.version, description: s.description, files: s.file_count, published_by: s.published_by_name, published_at: s.published_at, notes: s.notes || undefined,
  }))));

  server.registerTool('get_skill', {
    title: 'Get a Claude skill (to install or update it)',
    description:
      'Every file of a skill version, with paths relative to ~/.claude. To install or update on this machine: ' +
      '(1) if ~/.claude/skills/<name>/' + MANIFEST + ' exists, delete each file in its "files" list that is not in this version; ' +
      '(2) write every returned file to ~/.claude/<path> with exactly the given content, creating folders, and chmod +x the ones marked executable ' +
      '(the ' + MANIFEST + ' manifest is included and records the version); ' +
      '(3) tell the user what was installed. Skills and agents that do not show up yet load in a new Claude Code session.',
    inputSchema: {
      name: z.string().describe('Skill name, e.g. "factory"'),
      version: z.number().int().positive().optional().describe('A specific version; default latest'),
    },
  }, wrap(async ({ name, version }: { name: string; version?: number }) => {
    const s = await getSkill(name, version);
    return { name: s.name, version: s.version, latest_version: s.latest_version, description: s.description, notes: s.notes || undefined, published_by: s.published_by_name, published_at: s.published_at, files: s.files };
  }));

  server.registerTool('publish_skill', {
    title: 'Publish a Claude skill',
    description:
      'Upload a new version of a skill from this machine so every other machine can install it (needs the skills.publish permission). ' +
      'Read each file from ~/.claude and pass its exact content: everything under skills/<name>/ plus any agents/*.md or commands/*.md it uses. ' +
      'Leave out caches (__pycache__, .DS_Store) and the ' + MANIFEST + ' file. Publishing identical files keeps the current version.',
    inputSchema: {
      name: z.string().describe('Skill folder name under ~/.claude/skills'),
      notes: z.string().optional().describe('What changed in this version'),
      files: z.array(z.object({
        path: z.string().describe('Relative to ~/.claude, e.g. "skills/factory/SKILL.md" or "agents/factory-builder.md"'),
        content: z.string(),
        executable: z.boolean().optional(),
      })),
    },
  }, wrap(async (args: any) => {
    const r = await publishSkill(ctx, args);
    if (!r.unchanged) {
      // Keep this machine's manifest in step with what was just published.
      return { ...r, next: `Write ~/.claude/skills/${r.name}/${MANIFEST} from get_skill so this machine shows as current.` };
    }
    return r;
  }));

  return server;
}

export default async function mcpRoutes(app: FastifyInstance) {
  app.post('/api/mcp', async (req, reply) => {
    // A 401 points OAuth clients (Claude Desktop, claude.ai) at the sign-in metadata.
    const challenge = (error?: string) => {
      const params = [`resource_metadata="${resourceMetadataUrl()}"`, ...(error ? [`error="${error}"`] : [])];
      return reply.code(401).header('www-authenticate', `Bearer ${params.join(', ')}`)
        .send({ error: error ? 'Invalid or expired token' : 'Sign in required: connect with OAuth or use an API token (Authorization: Bearer hsl_…)', code: 'unauthorized' });
    };
    try {
      await authenticate(req, 'mcp');
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return challenge('invalid_token');
      throw e;
    }
    if (!req.ctx || !req.ctx.tokenId) return challenge();
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
