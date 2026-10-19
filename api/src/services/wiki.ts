// The wiki: nested folders, markdown pages (every saved version is an object in MinIO),
// comments, embedded files, search and a trash.
//
// Access: any signed-in user can view, wiki.edit can edit, wiki.manage can do everything.
// Each project has its own folder (with Design and Operations inside) whose access follows the
// project instead: project.view to read, the project permission wiki.write to edit.
// A folder can override that for itself and everything below it (until a deeper folder sets
// its own): access rules grant view or edit to users or global roles, and a restricted folder
// is visible only to people a rule matches.
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { Ctx } from '../auth.js';
import { one, q, tx, type Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { deleteObject, getObject, putObject } from '../storage.js';
import { parse } from '../validate.js';
import { UUID_RE } from './common.js';

export type Level = 'none' | 'view' | 'edit';
type FolderRow = { id: string; parent_id: string | null; name: string; description: string; restricted: boolean; updated_at: string; project_id: string | null; system_kind: 'project' | 'design' | 'operations' | null; project_key?: string | null };
type Rule = { folder_id: string; principal_type: 'user' | 'role'; principal_id: string; level: 'view' | 'edit' };

const MAX_PAGE_BYTES = 1024 * 1024;
const rank: Record<Level, number> = { none: 0, view: 1, edit: 2 };
const best = (a: Level, b: Level) => (rank[a] >= rank[b] ? a : b);
const actorId = (ctx: Ctx) => (ctx.user.id === '00000000-0000-0000-0000-000000000000' ? null : ctx.user.id);

async function streamText(s: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

const uniqueViolation = (e: any) => e?.code === '23505';

// ---------- Access model ----------------------------------------------------------------------

export type Access = Awaited<ReturnType<typeof loadAccess>>;

/** Loads every live folder and rule once per request and answers "what can this user do here". */
export async function loadAccess(ctx: Ctx, db?: Db) {
  const [folders, rules, roles, memberships] = await Promise.all([
    q<FolderRow>(`select f.id, f.parent_id, f.name, f.description, f.restricted, f.updated_at, f.project_id, f.system_kind, p.key as project_key
                    from wiki_folders f left join projects p on p.id = f.project_id where f.deleted_at is null`, [], db),
    q<Rule>(`select folder_id, principal_type, principal_id, level from wiki_folder_access`, [], db),
    q<{ role_id: string }>(`select role_id from user_roles where user_id = $1`, [ctx.user.id], db),
    q<{ project_id: string; permissions: string[] }>(`select m.project_id, r.permissions from project_members m join roles r on r.id = m.role_id where m.user_id = $1`, [ctx.user.id], db),
  ]);
  const projectPerms = new Map(memberships.map((m) => [m.project_id, new Set(m.permissions)]));
  const allProjects = ctx.global.has('projects.all');
  const projectLevel = (projectId: string): Level => {
    if (allProjects) return 'edit';
    const perms = projectPerms.get(projectId);
    return perms?.has('wiki.write') ? 'edit' : perms?.has('project.view') ? 'view' : 'none';
  };
  const byId = new Map(folders.map((f) => [f.id, f]));
  const rulesBy = new Map<string, Rule[]>();
  for (const r of rules) rulesBy.set(r.folder_id, [...(rulesBy.get(r.folder_id) ?? []), r]);
  const roleIds = new Set(roles.map((r) => r.role_id));
  const manage = ctx.global.has('wiki.manage');
  const base: Level = manage || ctx.global.has('wiki.edit') ? 'edit' : 'view';
  const cache = new Map<string, Level>();

  /** null is the top level. A folder that is missing (deleted, or under a deleted folder) is 'none'. */
  function level(folderId: string | null): Level {
    if (manage) return folderId === null || byId.has(folderId) ? 'edit' : 'none';
    if (folderId === null) return base;
    const hit = cache.get(folderId);
    if (hit) return hit;
    let result: Level = base;
    let cur = byId.get(folderId);
    if (!cur) result = 'none';
    while (cur) {
      const own = rulesBy.get(cur.id) ?? [];
      const projectRoot = cur.system_kind === 'project' && cur.project_id;
      if (cur.restricted || own.length || projectRoot) {
        let granted: Level = 'none';
        for (const r of own) {
          if ((r.principal_type === 'user' && r.principal_id === ctx.user.id) || (r.principal_type === 'role' && roleIds.has(r.principal_id))) granted = best(granted, r.level);
        }
        const inherited = projectRoot ? projectLevel(cur.project_id!) : base;
        result = cur.restricted ? granted : best(inherited, granted);
        break;
      }
      if (!cur.parent_id) break;
      const parent = byId.get(cur.parent_id);
      if (!parent) { result = 'none'; break; }
      cur = parent;
    }
    // A folder under a hidden folder stays hidden, whatever its own rules say.
    if (result !== 'none' && byId.get(folderId)?.parent_id) {
      const parentLevel = level(byId.get(folderId)!.parent_id);
      if (parentLevel === 'none') result = 'none';
    }
    cache.set(folderId, result);
    return result;
  }

  function require(folderId: string | null, need: 'view' | 'edit') {
    const l = level(folderId);
    if (l === 'none') throw notFound('Not found');
    if (need === 'edit' && l !== 'edit') throw forbidden('You can view this part of the wiki but not change it');
  }

  function path(folderId: string | null): string[] {
    const out: string[] = [];
    let cur = folderId ? byId.get(folderId) : undefined;
    while (cur) { out.unshift(cur.name); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
    return out;
  }

  /** True when `id` is `ancestor` or sits somewhere under it. */
  function isWithin(id: string | null, ancestor: string) {
    let cur = id ? byId.get(id) : undefined;
    while (cur) { if (cur.id === ancestor) return true; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
    return false;
  }

  /** Folder id for "A/B/C" (case-insensitive). With create, missing folders are made. */
  async function folderByPath(p: string, create = false): Promise<string | null> {
    const names = p.split('/').map((s) => s.trim()).filter(Boolean);
    let parent: string | null = null;
    for (const name of names) {
      // At the top level a project's key also names its folder: "STRTSWP/Design".
      const found: FolderRow | undefined = folders.find((f) => f.parent_id === parent && f.name.toLowerCase() === name.toLowerCase())
        ?? (parent === null ? folders.find((f) => f.system_kind === 'project' && f.project_key?.toLowerCase() === name.toLowerCase()) : undefined);
      if (found) { parent = found.id; continue; }
      if (!create) throw notFound(`No folder "${names.slice(0, names.indexOf(name) + 1).join('/')}"`);
      const made: { id: string } = await createFolder(ctx, { parent_id: parent, name }, access);
      const row: FolderRow = { id: made.id, parent_id: parent, name, description: '', restricted: false, updated_at: new Date().toISOString(), project_id: null, system_kind: null };
      folders.push(row);
      byId.set(row.id, row);
      cache.clear();
      parent = made.id;
    }
    return parent;
  }

  const access = { folders, byId, rulesBy, manage, canEdit: base === 'edit', level, require, path, isWithin, folderByPath };
  return access;
}

// ---------- Tree, recent, search -------------------------------------------------------------

export async function wikiTree(ctx: Ctx) {
  const a = await loadAccess(ctx);
  const pages = await q<{ id: string; folder_id: string | null; title: string; current_version: number; updated_at: string; tags: string[] }>(
    `select id, folder_id, title, current_version, updated_at, tags from wiki_pages where deleted_at is null order by lower(title)`);
  return {
    can_edit_top: a.level(null) === 'edit',
    can_manage: a.manage,
    folders: a.folders
      .filter((f) => a.level(f.id) !== 'none')
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name, restricted: f.restricted, has_rules: a.rulesBy.has(f.id), level: a.level(f.id), system_kind: f.system_kind, project_key: f.project_key ?? null })),
    pages: pages.filter((p) => a.level(p.folder_id) !== 'none').map((p) => ({ ...p, path: [...a.path(p.folder_id), p.title].join('/') })),
  };
}

export async function recentPages(ctx: Ctx, limit = 20) {
  const a = await loadAccess(ctx);
  const rows = await q<{ id: string; folder_id: string | null; title: string; current_version: number; updated_at: string; updated_by_name: string | null; tags: string[] }>(
    `select p.id, p.folder_id, p.title, p.tags, p.current_version, p.updated_at, u.name as updated_by_name
       from wiki_pages p left join users u on u.id = p.updated_by where p.deleted_at is null order by p.updated_at desc limit 200`);
  return rows.filter((p) => a.level(p.folder_id) !== 'none').slice(0, limit).map((p) => ({ ...p, path: a.path(p.folder_id) }));
}

/** Full-text search; `tag` (or "#tag" words in the text) narrows to pages with those tags. */
export async function searchWiki(ctx: Ctx, text: string, opts: { tag?: string; limit?: number } = {}) {
  const words = text.trim().slice(0, 200).split(/\s+/).filter(Boolean);
  const tags = cleanTags([...words.filter((w) => w.startsWith('#')), ...(opts.tag ? [opts.tag] : [])]) ?? [];
  const t = words.filter((w) => !w.startsWith('#')).join(' ');
  if (!t && !tags.length) return [];
  const a = await loadAccess(ctx);
  const rows = await q<{ id: string; folder_id: string | null; title: string; snippet: string; updated_at: string; tags: string[] }>(
    `select id, folder_id, title, tags, updated_at,
            case when $1 = '' then left(body_text, 160)
                 else ts_headline('english', body_text, websearch_to_tsquery('english', $1), 'StartSel=«,StopSel=»,MaxWords=24,MinWords=8,MaxFragments=1') end as snippet
       from wiki_pages
      where deleted_at is null and tags @> $3
        and ($1 = '' or search @@ websearch_to_tsquery('english', $1) or title ilike $2)
      order by (title ilike $2) desc, case when $1 = '' then 0 else ts_rank(search, websearch_to_tsquery('english', $1)) end desc, updated_at desc
      limit 100`,
    [t, `%${t.replace(/[%_\\]/g, (m) => '\\' + m)}%`, tags]);
  return rows.filter((p) => a.level(p.folder_id) !== 'none').slice(0, opts.limit ?? 20).map((p) => ({ ...p, path: a.path(p.folder_id) }));
}

/** Every tag on pages you can see, most used first. */
export async function wikiTags(ctx: Ctx) {
  const a = await loadAccess(ctx);
  const rows = await q<{ folder_id: string | null; tags: string[] }>(`select folder_id, tags from wiki_pages where deleted_at is null and tags <> '{}'`);
  const counts = new Map<string, number>();
  for (const r of rows) if (a.level(r.folder_id) !== 'none') for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, pages]) => ({ tag, pages })).sort((x, y) => y.pages - x.pages || x.tag.localeCompare(y.tag));
}

/** The project key a folder belongs to, if it's inside a project's folder. */
function projectOf(a: Access, folderId: string | null): string | null {
  for (let cur = folderId ? a.byId.get(folderId) : undefined; cur; cur = cur.parent_id ? a.byId.get(cur.parent_id) : undefined) {
    if (cur.system_kind === 'project') return cur.project_key ?? null;
  }
  return null;
}

/** A project's wiki folders: { project, design, operations } ids. */
export async function projectFolders(projectId: string) {
  const rows = await q<{ id: string; system_kind: string }>(`select id, system_kind from wiki_folders where project_id = $1 and deleted_at is null`, [projectId]);
  const by = Object.fromEntries(rows.map((r) => [r.system_kind, r.id]));
  return { project: by.project as string | undefined, design: by.design as string | undefined, operations: by.operations as string | undefined };
}

/**
 * Makes sure every project has its folder (named after the project) with Design and Operations
 * inside, and keeps the folder name in step with the project name. Safe to run any time.
 */
export async function syncProjectFolders(log?: (m: string) => void) {
  // Archived projects keep a folder they already have, but get no new one.
  const projects = await q<{ id: string; key: string; name: string }>(
    `select id, key, name from projects p where archived_at is null or exists (select 1 from wiki_folders f where f.project_id = p.id) order by created_at`);
  for (const p of projects) {
    await tx(async (db) => {
      await db.query('select pg_advisory_xact_lock(7342008)');
      let root = (await db.query<{ id: string; name: string }>(`select id, name from wiki_folders where project_id = $1 and system_kind = 'project' and deleted_at is null`, [p.id])).rows[0];
      const freeName = async (want: string, except?: string) => {
        const taken = await db.query(`select 1 from wiki_folders where parent_id is null and deleted_at is null and lower(name) = lower($1) and id is distinct from $2`, [want, except ?? null]);
        return taken.rowCount ? `${want} (${p.key})` : want;
      };
      if (!root) {
        const name = await freeName(p.name);
        root = (await db.query<{ id: string; name: string }>(
          `insert into wiki_folders (name, description, project_id, system_kind) values ($1, $2, $3, 'project') returning id, name`,
          [name, `Wiki for the ${p.name} project (${p.key}).`, p.id])).rows[0];
        log?.(`created wiki folder for project ${p.key}`);
      } else if (root.name !== p.name && root.name !== `${p.name} (${p.key})`) {
        await db.query(`update wiki_folders set name = $2, updated_at = now() where id = $1`, [root.id, await freeName(p.name, root.id)]);
      }
      for (const [kind, name, description] of [['design', 'Design', 'Design documents: architecture, data model, APIs and the decisions behind them.'], ['operations', 'Operations', 'Operations and instructions: setup, deployment, runbooks and how-tos.']] as const) {
        const exists = await db.query(`select 1 from wiki_folders where project_id = $1 and system_kind = $2 and deleted_at is null`, [p.id, kind]);
        if (exists.rowCount) continue;
        const clash = await db.query(`select 1 from wiki_folders where parent_id = $1 and deleted_at is null and lower(name) = lower($2)`, [root.id, name]);
        await db.query(`insert into wiki_folders (parent_id, name, description, project_id, system_kind) values ($1, $2, $3, $4, $5)`,
          [root.id, clash.rowCount ? `${name} (project)` : name, description, p.id, kind]);
      }
    });
  }
}

// ---------- Folders ---------------------------------------------------------------------------

const folderInput = z.object({
  parent_id: z.string().regex(UUID_RE).nullable().optional(),
  name: z.string().trim().min(1, 'Name is required').max(120).refine((s) => !s.includes('/'), 'Name cannot contain "/"'),
  description: z.string().trim().max(2000).optional(),
});

export async function createFolder(ctx: Ctx, raw: unknown, given?: Access) {
  const input = parse(folderInput, raw);
  const a = given ?? (await loadAccess(ctx));
  const parent = input.parent_id ?? null;
  a.require(parent, 'edit');
  try {
    const f = (await one<{ id: string; name: string }>(
      `insert into wiki_folders (parent_id, name, description, created_by) values ($1, $2, $3, $4) returning id, name`,
      [parent, input.name, input.description ?? '', actorId(ctx)]))!;
    await audit(ctx, { action: 'wiki.folder_created', entityType: 'wiki_folder', entityId: f.id, summary: `Created wiki folder "${[...a.path(parent), f.name].join('/')}"` });
    return f;
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`There's already a folder called "${input.name}" here`);
    throw e;
  }
}

export async function getFolder(ctx: Ctx, id: string) {
  const a = await loadAccess(ctx);
  const f = a.byId.get(id);
  if (!f || a.level(id) === 'none') throw notFound('Folder not found');
  const rules = a.manage
    ? await q(`select r.principal_type, r.principal_id, r.level, coalesce(u.name, ro.name) as name, u.email
                 from wiki_folder_access r left join users u on r.principal_type = 'user' and u.id = r.principal_id
                 left join roles ro on r.principal_type = 'role' and ro.id = r.principal_id
                where r.folder_id = $1 order by r.principal_type, name`, [id])
    : [];
  // Where this folder's access comes from: itself, an ancestor, or the wiki default.
  let policyFrom: { id: string; name: string } | null = null;
  for (let cur: FolderRow | undefined = f; cur; cur = cur.parent_id ? a.byId.get(cur.parent_id) : undefined) {
    if (cur.restricted || a.rulesBy.has(cur.id)) { policyFrom = { id: cur.id, name: cur.name }; break; }
  }
  return { ...f, path: a.path(id), level: a.level(id), can_manage: a.manage, rules, policy_from: policyFrom };
}

export async function updateFolder(ctx: Ctx, id: string, raw: unknown) {
  const input = parse(z.object({
    name: folderInput.shape.name.optional(),
    description: z.string().trim().max(2000).optional(),
    parent_id: z.string().regex(UUID_RE).nullable().optional(),
  }), raw);
  const a = await loadAccess(ctx);
  const f = a.byId.get(id);
  if (!f) throw notFound('Folder not found');
  a.require(id, 'edit');
  if (f.system_kind && ((input.name && input.name !== f.name) || (input.parent_id !== undefined && input.parent_id !== f.parent_id))) {
    throw badRequest(f.system_kind === 'project' ? "A project's folder is named after the project and can't be moved; rename the project instead" : "The project's Design and Operations folders can't be renamed or moved");
  }
  const moving = input.parent_id !== undefined && input.parent_id !== f.parent_id;
  if (moving) {
    a.require(f.parent_id, 'edit');
    a.require(input.parent_id ?? null, 'edit');
    if (input.parent_id && a.isWithin(input.parent_id, id)) throw badRequest("A folder can't move inside itself");
  }
  try {
    await q(`update wiki_folders set name = coalesce($2, name), description = coalesce($3, description), parent_id = $4, updated_at = now() where id = $1`,
      [id, input.name ?? null, input.description ?? null, moving ? input.parent_id ?? null : f.parent_id]);
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`There's already a folder called "${input.name ?? f.name}" there`);
    throw e;
  }
  const what = [input.name && input.name !== f.name ? `renamed to "${input.name}"` : '', moving ? `moved to "${a.path(input.parent_id ?? null).join('/') || 'top level'}"` : '', input.description !== undefined ? 'description edited' : ''].filter(Boolean).join(', ');
  await audit(ctx, { action: 'wiki.folder_updated', entityType: 'wiki_folder', entityId: id, summary: `Wiki folder "${a.path(id).join('/')}": ${what || 'saved'}` });
}

export async function setFolderAccess(ctx: Ctx, id: string, raw: unknown) {
  if (!ctx.global.has('wiki.manage')) throw forbidden();
  const input = parse(z.object({
    restricted: z.boolean(),
    rules: z.array(z.object({ principal_type: z.enum(['user', 'role']), principal_id: z.string().regex(UUID_RE), level: z.enum(['view', 'edit']) })).max(100),
  }), raw);
  const a = await loadAccess(ctx);
  if (!a.byId.has(id)) throw notFound('Folder not found');
  await tx(async (db) => {
    await db.query(`update wiki_folders set restricted = $2, updated_at = now() where id = $1`, [id, input.restricted]);
    await db.query(`delete from wiki_folder_access where folder_id = $1`, [id]);
    for (const r of input.rules) {
      await db.query(`insert into wiki_folder_access (folder_id, principal_type, principal_id, level) values ($1, $2, $3, $4) on conflict do nothing`,
        [id, r.principal_type, r.principal_id, r.level]);
    }
    await audit(ctx, {
      action: 'wiki.folder_access', entityType: 'wiki_folder', entityId: id,
      summary: `Set access on wiki folder "${a.path(id).join('/')}": ${input.restricted ? 'restricted' : 'open'}, ${input.rules.length} rule${input.rules.length === 1 ? '' : 's'}`,
      changes: input,
    }, db);
  });
}

/** Moves a folder and everything in it to the trash. */
export async function deleteFolder(ctx: Ctx, id: string) {
  if (!ctx.global.has('wiki.manage')) throw forbidden('Only wiki managers can delete folders');
  const a = await loadAccess(ctx);
  if (!a.byId.has(id)) throw notFound('Folder not found');
  if (a.byId.get(id)!.system_kind) throw badRequest("A project's wiki folders can't be deleted; delete the pages in them instead");
  const ids = a.folders.filter((f) => a.isWithin(f.id, id)).map((f) => f.id);
  const batch = randomUUID();
  const label = a.path(id).join('/');
  await tx(async (db) => {
    await db.query(`update wiki_folders set deleted_at = now(), deleted_batch = $2 where id = any($1) and deleted_at is null`, [ids, batch]);
    await db.query(`update wiki_pages set deleted_at = now(), deleted_batch = $2 where folder_id = any($1) and deleted_at is null`, [ids, batch]);
    await audit(ctx, { action: 'wiki.folder_deleted', entityType: 'wiki_folder', entityId: id, summary: `Moved wiki folder "${label}" to the trash` }, db);
  });
}

// ---------- Pages -----------------------------------------------------------------------------

type PageRow = { id: string; folder_id: string | null; title: string; tags: string[]; current_version: number; created_at: string; updated_at: string; deleted_at: string | null; created_by_name: string | null; updated_by_name: string | null };

async function loadPage(id: string, db?: Db) {
  if (!UUID_RE.test(id)) throw notFound('Page not found');
  const p = await one<PageRow>(
    `select p.id, p.folder_id, p.title, p.tags, p.current_version, p.created_at, p.updated_at, p.deleted_at, cu.name as created_by_name, uu.name as updated_by_name
       from wiki_pages p left join users cu on cu.id = p.created_by left join users uu on uu.id = p.updated_by where p.id = $1`, [id], db);
  if (!p || p.deleted_at) throw notFound('Page not found');
  return p;
}

/** A page by id, or by path "Folder/Sub/Title". */
export async function resolvePage(ctx: Ctx, ref: string, a?: Access) {
  if (UUID_RE.test(ref)) return loadPage(ref);
  const access = a ?? (await loadAccess(ctx));
  const parts = ref.split('/').map((s) => s.trim()).filter(Boolean);
  const title = parts.pop();
  if (!title) throw notFound('Page not found');
  const folderId = parts.length ? await access.folderByPath(parts.join('/')) : null;
  const row = await one<{ id: string }>(
    `select id from wiki_pages where deleted_at is null and folder_id is not distinct from $1 and lower(title) = lower($2)`, [folderId, title]);
  if (!row) throw notFound(`No page "${ref}"`);
  return loadPage(row.id);
}

async function writeVersion(ctx: Ctx, db: Db, pageId: string, version: number, title: string, content: string, summary: string) {
  const buf = Buffer.from(content, 'utf8');
  const key = `wiki/pages/${pageId}/v${version}.md`;
  await putObject(key, buf, 'text/markdown; charset=utf-8');
  await db.query(
    `insert into wiki_page_versions (page_id, version, title, object_key, size_bytes, sha256, summary, created_by, created_by_name, via)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [pageId, version, title, key, buf.length, createHash('sha256').update(buf).digest('hex'), summary, actorId(ctx), ctx.user.name, ctx.via]);
}

const pageInput = z.object({
  folder_id: z.string().regex(UUID_RE).nullable().optional(),
  title: z.string().trim().min(1, 'Title is required').max(200).refine((s) => !s.includes('/'), 'Title cannot contain "/"'),
  content: z.string().default(''),
  summary: z.string().trim().max(500).optional(),
  tags: z.array(z.string()).max(30).optional(),
});

/** Tags are lowercase words joined by dashes: "API Design" becomes "api-design". */
export function cleanTags(tags: string[] | undefined) {
  if (!tags) return undefined;
  const out = new Set<string>();
  for (const t of tags) {
    const c = t.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (c) out.add(c);
  }
  return [...out].slice(0, 30);
}

export async function createPage(ctx: Ctx, raw: unknown, given?: Access) {
  const input = parse(pageInput, raw);
  if (Buffer.byteLength(input.content) > MAX_PAGE_BYTES) throw badRequest('A page can be at most 1 MB');
  const a = given ?? (await loadAccess(ctx));
  const folderId = input.folder_id ?? null;
  a.require(folderId, 'edit');
  try {
    const id = await tx(async (db) => {
      const p = (await db.query<{ id: string }>(
        `insert into wiki_pages (folder_id, title, current_version, body_text, tags, created_by, updated_by) values ($1, $2, 1, $3, $4, $5, $5) returning id`,
        [folderId, input.title, input.content, cleanTags(input.tags) ?? [], actorId(ctx)])).rows[0];
      await writeVersion(ctx, db, p.id, 1, input.title, input.content, input.summary || 'Created');
      await audit(ctx, { action: 'wiki.page_created', entityType: 'wiki_page', entityId: p.id, summary: `Created wiki page "${[...a.path(folderId), input.title].join('/')}"` }, db);
      return p.id;
    });
    return getPage(ctx, id);
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`There's already a page called "${input.title}" in this folder`);
    throw e;
  }
}

export async function getPage(ctx: Ctx, ref: string, version?: number) {
  const a = await loadAccess(ctx);
  const p = await resolvePage(ctx, ref, a);
  a.require(p.folder_id, 'view');
  const v = await one<{ version: number; title: string; object_key: string; summary: string; created_by_name: string; created_at: string; via: string }>(
    `select version, title, object_key, summary, created_by_name, created_at, via from wiki_page_versions where page_id = $1 and version = $2`,
    [p.id, version ?? p.current_version]);
  if (!v) throw notFound(`Version ${version} not found`);
  const content = await streamText(await getObject(v.object_key));
  const counts = (await one<{ comments: number; open_comments: number; files: number }>(
    `select (select count(*)::int from wiki_comments where page_id = $1 and deleted_at is null) as comments,
            (select count(*)::int from wiki_comments where page_id = $1 and deleted_at is null and resolved_at is null and parent_id is null) as open_comments,
            (select count(*)::int from wiki_files where page_id = $1) as files`, [p.id]))!;
  return {
    id: p.id, folder_id: p.folder_id, path: a.path(p.folder_id), title: version ? v.title : p.title, tags: p.tags,
    project_key: projectOf(a, p.folder_id),
    content, version: v.version, current_version: p.current_version,
    version_summary: v.summary, version_by: v.created_by_name, version_at: v.created_at, version_via: v.via,
    created_at: p.created_at, created_by_name: p.created_by_name, updated_at: p.updated_at, updated_by_name: p.updated_by_name,
    can_edit: a.level(p.folder_id) === 'edit', can_manage: a.manage, ...counts,
  };
}

const saveInput = z.object({
  title: pageInput.shape.title.optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).max(30).optional(),
  base_version: z.number().int().positive(),
  summary: z.string().trim().max(500).optional(),
});

/** Saves a new version. base_version is the version the edit started from; a stale one is a conflict. */
export async function savePage(ctx: Ctx, ref: string, raw: unknown) {
  const input = parse(saveInput, raw);
  if (input.content !== undefined && Buffer.byteLength(input.content) > MAX_PAGE_BYTES) throw badRequest('A page can be at most 1 MB');
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'edit');
  try {
    const result = await tx(async (db) => {
      const cur = (await db.query<{ current_version: number; title: string; body_text: string; tags: string[] }>(
        `select current_version, title, body_text, tags from wiki_pages where id = $1 for update`, [page.id])).rows[0];
      // Tags aren't versioned: they change in place, even when the text doesn't.
      const tags = cleanTags(input.tags);
      if (tags && tags.join(',') !== cur.tags.join(',')) {
        await db.query(`update wiki_pages set tags = $2 where id = $1`, [page.id, tags]);
        await audit(ctx, { action: 'wiki.page_tagged', entityType: 'wiki_page', entityId: page.id, summary: `Tags on wiki page "${cur.title}": ${tags.length ? tags.join(', ') : 'none'}` }, db);
      }
      if (input.base_version !== cur.current_version) {
        throw conflict(`This page changed since you started editing (you have v${input.base_version}, it's now v${cur.current_version}). Copy your changes, reload, and apply them again.`);
      }
      const title = input.title ?? cur.title;
      const content = input.content ?? cur.body_text;
      if (title === cur.title && content === cur.body_text) return { version: cur.current_version, unchanged: true, tags: tags ?? cur.tags };
      const version = cur.current_version + 1;
      await writeVersion(ctx, db, page.id, version, title, content, input.summary ?? '');
      await db.query(`update wiki_pages set title = $2, body_text = $3, current_version = $4, updated_by = $5, updated_at = now() where id = $1`,
        [page.id, title, content, version, actorId(ctx)]);
      await audit(ctx, {
        action: 'wiki.page_edited', entityType: 'wiki_page', entityId: page.id,
        summary: `Edited wiki page "${[...a.path(page.folder_id), title].join('/')}" (v${version})${title !== cur.title ? `, renamed from "${cur.title}"` : ''}${input.summary ? `: ${input.summary}` : ''}`,
      }, db);
      return { version, unchanged: false, tags: tags ?? cur.tags };
    });
    return result;
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`There's already a page called "${input.title}" in this folder`);
    throw e;
  }
}

export async function restoreVersion(ctx: Ctx, ref: string, version: number) {
  const page = await getPage(ctx, ref, version);
  if (!page.can_edit) throw forbidden();
  if (version === page.current_version) throw badRequest(`v${version} is already the current version`);
  return savePage(ctx, page.id, { title: page.title, content: page.content, base_version: page.current_version, summary: `Restored v${version}` });
}

export async function movePage(ctx: Ctx, ref: string, folderId: string | null) {
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'edit');
  a.require(folderId, 'edit');
  if (page.folder_id === folderId) return;
  try {
    await q(`update wiki_pages set folder_id = $2, updated_at = now() where id = $1`, [page.id, folderId]);
  } catch (e) {
    if (uniqueViolation(e)) throw conflict(`There's already a page called "${page.title}" in that folder`);
    throw e;
  }
  await audit(ctx, { action: 'wiki.page_moved', entityType: 'wiki_page', entityId: page.id, summary: `Moved wiki page "${page.title}" from "${a.path(page.folder_id).join('/') || 'top level'}" to "${a.path(folderId).join('/') || 'top level'}"` });
}

export async function deletePage(ctx: Ctx, ref: string) {
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'edit');
  await q(`update wiki_pages set deleted_at = now(), deleted_batch = $2 where id = $1`, [page.id, randomUUID()]);
  await audit(ctx, { action: 'wiki.page_deleted', entityType: 'wiki_page', entityId: page.id, summary: `Moved wiki page "${[...a.path(page.folder_id), page.title].join('/')}" to the trash` });
}

export async function pageHistory(ctx: Ctx, ref: string) {
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'view');
  return q(`select version, title, summary, size_bytes, created_by_name, via, created_at from wiki_page_versions where page_id = $1 order by version desc`, [page.id]);
}

// ---------- Comments --------------------------------------------------------------------------

export async function listComments(ctx: Ctx, ref: string) {
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'view');
  return q(
    `select c.id, c.parent_id, c.body, c.page_version, c.created_at, c.updated_at, c.resolved_at, c.author_id,
            u.name as author_name, u.avatar_updated_at as author_photo_at, u.kind as author_kind, ru.name as resolved_by_name
       from wiki_comments c left join users u on u.id = c.author_id left join users ru on ru.id = c.resolved_by
      where c.page_id = $1 and c.deleted_at is null order by c.created_at`, [page.id]);
}

export async function addWikiComment(ctx: Ctx, ref: string, raw: unknown) {
  const input = parse(z.object({ body: z.string().trim().min(1, 'Comment is empty').max(20000), parent_id: z.string().regex(UUID_RE).nullable().optional() }), raw);
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'view');
  let parent: string | null = null;
  if (input.parent_id) {
    const p = await one<{ id: string; parent_id: string | null }>(`select id, parent_id from wiki_comments where id = $1 and page_id = $2 and deleted_at is null`, [input.parent_id, page.id]);
    if (!p) throw notFound('The comment you replied to is gone');
    parent = p.parent_id ?? p.id; // replies stay one level deep
  }
  const c = (await one(`insert into wiki_comments (page_id, parent_id, author_id, body, page_version) values ($1, $2, $3, $4, $5) returning id, created_at`,
    [page.id, parent, actorId(ctx), input.body, page.current_version]))!;
  await audit(ctx, { action: 'wiki.commented', entityType: 'wiki_page', entityId: page.id, summary: `Commented on wiki page "${page.title}"`, changes: { comment: input.body.slice(0, 500) } });
  return c;
}

async function loadComment(ctx: Ctx, id: string) {
  if (!UUID_RE.test(id)) throw notFound('Comment not found');
  const c = await one<{ id: string; page_id: string; author_id: string | null; title: string; folder_id: string | null }>(
    `select c.id, c.page_id, c.author_id, p.title, p.folder_id from wiki_comments c join wiki_pages p on p.id = c.page_id
      where c.id = $1 and c.deleted_at is null and p.deleted_at is null`, [id]);
  if (!c) throw notFound('Comment not found');
  const a = await loadAccess(ctx);
  a.require(c.folder_id, 'view');
  return { c, a };
}

export async function editWikiComment(ctx: Ctx, id: string, raw: unknown) {
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Comment is empty').max(20000) }), raw);
  const { c } = await loadComment(ctx, id);
  if (c.author_id !== ctx.user.id) throw forbidden('You can only edit your own comments');
  await q(`update wiki_comments set body = $2, updated_at = now() where id = $1`, [id, body]);
}

export async function deleteWikiComment(ctx: Ctx, id: string) {
  const { c, a } = await loadComment(ctx, id);
  if (c.author_id !== ctx.user.id && !a.manage) throw forbidden('You can only delete your own comments');
  await q(`update wiki_comments set deleted_at = now() where id = $1 or parent_id = $1`, [id]);
  await audit(ctx, { action: 'wiki.comment_deleted', entityType: 'wiki_page', entityId: c.page_id, summary: `Deleted a comment on wiki page "${c.title}"` });
}

export async function resolveWikiComment(ctx: Ctx, id: string, resolved: boolean) {
  const { c, a } = await loadComment(ctx, id);
  if (c.author_id !== ctx.user.id && a.level(c.folder_id) !== 'edit') throw forbidden();
  await q(`update wiki_comments set resolved_at = ${resolved ? 'now()' : 'null'}, resolved_by = $2 where id = $1 and parent_id is null`, [id, resolved ? actorId(ctx) : null]);
  await audit(ctx, { action: resolved ? 'wiki.comment_resolved' : 'wiki.comment_reopened', entityType: 'wiki_page', entityId: c.page_id, summary: `${resolved ? 'Resolved' : 'Reopened'} a comment on wiki page "${c.title}"` });
}

// ---------- Files embedded in pages -----------------------------------------------------------

export async function addWikiFile(ctx: Ctx, ref: string, file: { filename: string; contentType: string; data: Buffer }) {
  const a = await loadAccess(ctx);
  const page = await resolvePage(ctx, ref, a);
  a.require(page.folder_id, 'edit');
  const id = randomUUID();
  const key = `wiki/files/${id}`;
  await putObject(key, file.data, file.contentType);
  const row = (await one(
    `insert into wiki_files (id, page_id, filename, content_type, size_bytes, object_key, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7) returning id, filename, content_type, size_bytes, created_at`,
    [id, page.id, file.filename, file.contentType, file.data.length, key, actorId(ctx)]))!;
  await audit(ctx, { action: 'wiki.file_added', entityType: 'wiki_page', entityId: page.id, summary: `Uploaded "${file.filename}" to wiki page "${page.title}"` });
  return row;
}

export async function getWikiFile(ctx: Ctx, id: string) {
  if (!UUID_RE.test(id)) throw notFound('File not found');
  const f = await one<{ filename: string; content_type: string; size_bytes: number; object_key: string; folder_id: string | null }>(
    `select f.filename, f.content_type, f.size_bytes, f.object_key, p.folder_id from wiki_files f join wiki_pages p on p.id = f.page_id where f.id = $1 and p.deleted_at is null`, [id]);
  if (!f) throw notFound('File not found');
  (await loadAccess(ctx)).require(f.folder_id, 'view');
  return { ...f, body: await getObject(f.object_key) };
}

// ---------- Trash -----------------------------------------------------------------------------

export async function listTrash(ctx: Ctx) {
  if (!ctx.global.has('wiki.manage')) throw forbidden();
  // One entry per delete: the folder or page that was deleted, not everything inside it.
  return q(
    `select * from (
       select 'folder' as type, f.id, f.name as title, f.deleted_at, f.deleted_batch,
              (select count(*)::int from wiki_pages p where p.deleted_batch = f.deleted_batch) as pages
         from wiki_folders f
        where f.deleted_at is null is false
          and not exists (select 1 from wiki_folders pf where pf.id = f.parent_id and pf.deleted_batch = f.deleted_batch)
       union all
       select 'page', p.id, p.title, p.deleted_at, p.deleted_batch, 1
         from wiki_pages p
        where p.deleted_at is not null
          and not exists (select 1 from wiki_folders pf where pf.id = p.folder_id and pf.deleted_batch = p.deleted_batch)
     ) t order by deleted_at desc limit 200`);
}

export async function restoreTrash(ctx: Ctx, batch: string) {
  if (!ctx.global.has('wiki.manage')) throw forbidden();
  if (!UUID_RE.test(batch)) throw notFound('Nothing to restore');
  await tx(async (db) => {
    const folders = (await db.query<{ id: string; parent_id: string | null; name: string }>(`select id, parent_id, name from wiki_folders where deleted_batch = $1`, [batch])).rows;
    const pages = (await db.query<{ id: string; folder_id: string | null; title: string }>(`select id, folder_id, title from wiki_pages where deleted_batch = $1`, [batch])).rows;
    if (!folders.length && !pages.length) throw notFound('Nothing to restore');
    const inBatch = new Set(folders.map((f) => f.id));
    const liveParent = async (id: string | null) => !id || inBatch.has(id) || !!(await db.query(`select 1 from wiki_folders where id = $1 and deleted_at is null`, [id])).rowCount;
    const freeName = async (table: 'wiki_folders' | 'wiki_pages', col: 'name' | 'title', parentCol: 'parent_id' | 'folder_id', parent: string | null, name: string) => {
      for (let i = 0; ; i++) {
        const candidate = i === 0 ? name : `${name} (restored${i > 1 ? ` ${i}` : ''})`;
        const taken = await db.query(`select 1 from ${table} where deleted_at is null and ${parentCol} is not distinct from $1 and lower(${col}) = lower($2)`, [parent, candidate]);
        if (!taken.rowCount) return candidate;
      }
    };
    // Top items go back where they were, or to the top level if that folder is gone.
    for (const f of folders.filter((f) => !f.parent_id || !inBatch.has(f.parent_id))) {
      const parent = (await liveParent(f.parent_id)) ? f.parent_id : null;
      const name = await freeName('wiki_folders', 'name', 'parent_id', parent, f.name);
      await db.query(`update wiki_folders set parent_id = $2, name = $3, deleted_at = null, deleted_batch = null where id = $1`, [f.id, parent, name]);
    }
    await db.query(`update wiki_folders set deleted_at = null, deleted_batch = null where deleted_batch = $1`, [batch]);
    for (const p of pages.filter((p) => !p.folder_id || !inBatch.has(p.folder_id))) {
      const parent = (await liveParent(p.folder_id)) ? p.folder_id : null;
      const title = await freeName('wiki_pages', 'title', 'folder_id', parent, p.title);
      await db.query(`update wiki_pages set folder_id = $2, title = $3, deleted_at = null, deleted_batch = null where id = $1`, [p.id, parent, title]);
    }
    await db.query(`update wiki_pages set deleted_at = null, deleted_batch = null where deleted_batch = $1`, [batch]);
    const label = folders.find((f) => !f.parent_id || !inBatch.has(f.parent_id))?.name ?? pages[0]?.title;
    await audit(ctx, { action: 'wiki.restored', entityType: folders.length ? 'wiki_folder' : 'wiki_page', entityId: folders[0]?.id ?? pages[0]?.id, summary: `Restored "${label}" from the wiki trash` }, db);
  });
}

/** Deletes trashed items for good, including their stored versions and files. */
export async function purgeTrash(ctx: Ctx, batch: string) {
  if (!ctx.global.has('wiki.manage')) throw forbidden();
  if (!UUID_RE.test(batch)) throw notFound('Nothing to delete');
  const keys = (await q<{ key: string }>(
    `select v.object_key as key from wiki_page_versions v join wiki_pages p on p.id = v.page_id where p.deleted_batch = $1
     union all select f.object_key from wiki_files f join wiki_pages p on p.id = f.page_id where p.deleted_batch = $1`, [batch])).map((r) => r.key);
  const label = (await one<{ t: string }>(`select coalesce((select name from wiki_folders where deleted_batch = $1 limit 1), (select title from wiki_pages where deleted_batch = $1 limit 1)) as t`, [batch]))?.t;
  if (!label) throw notFound('Nothing to delete');
  await tx(async (db) => {
    await db.query(`delete from wiki_pages where deleted_batch = $1`, [batch]);
    await db.query(`delete from wiki_folders where deleted_batch = $1`, [batch]);
    await audit(ctx, { action: 'wiki.purged', entityType: 'wiki_folder', summary: `Permanently deleted "${label}" from the wiki trash (${keys.length} stored objects)` }, db);
  });
  for (const k of keys) await deleteObject(k).catch(() => {});
}
