// Claude skills hosted in Harbor Master. A skill version is the full set of files it installs
// under ~/.claude: its folder in skills/, plus any agents/ or commands/ files it brings along.
// Any signed-in user can read and install skills; publishing needs skills.publish.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireGlobal, type Ctx } from '../auth.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';

export type SkillFile = { path: string; content: string; executable?: boolean };

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024;
export const MANIFEST = '.harbormaster.json';

export const publishInput = z.object({
  name: z.string().trim().regex(NAME_RE, 'Skill name must be lowercase letters, digits and dashes'),
  description: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(2000).optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(300),
    content: z.string(),
    executable: z.boolean().optional(),
  })).min(1).max(200),
});

/** Paths are relative to ~/.claude and may only touch this skill's folder, agents/ or commands/. */
function checkPath(name: string, path: string) {
  const parts = path.split('/');
  if (path.startsWith('/') || parts.some((p) => !SEGMENT_RE.test(p))) throw badRequest(`Bad file path "${path}"`);
  const ok =
    (parts[0] === 'skills' && parts[1] === name && parts.length >= 3) ||
    ((parts[0] === 'agents' || parts[0] === 'commands') && parts.length === 2 && parts[1].endsWith('.md'));
  if (!ok) throw badRequest(`"${path}" is outside what a skill may install (skills/${name}/…, agents/*.md, commands/*.md)`);
  if (parts.at(-1) === MANIFEST) throw badRequest(`${MANIFEST} is written by Harbor Master; leave it out`);
}

function frontmatterDescription(skillMd: string) {
  const m = /^---\n([\s\S]*?)\n---/.exec(skillMd);
  const line = m?.[1].split('\n').find((l) => l.startsWith('description:'));
  return line ? line.slice('description:'.length).trim().replace(/^["']|["']$/g, '') : '';
}

const hashFiles = (files: SkillFile[]) =>
  createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.content, !!f.executable]))).digest('hex');

export async function listSkills() {
  return q(
    `select s.name, s.description, s.latest_version as version, s.updated_at, v.published_by_name, v.published_at, v.notes,
            jsonb_array_length(v.files) as file_count, v.total_bytes
       from skills s left join skill_versions v on v.skill_id = s.id and v.version = s.latest_version
      where s.archived_at is null order by s.name`,
  );
}

/** One version (latest by default), with its files and the manifest the installer writes. */
export async function getSkill(name: string, version?: number) {
  const s = await one<{ id: string; name: string; description: string; latest_version: number; archived_at: string | null }>(
    `select id, name, description, latest_version, archived_at from skills where name = $1`, [name]);
  if (!s || !s.latest_version) throw notFound(`No skill named "${name}"`);
  const v = await one<{ version: number; notes: string; files: SkillFile[]; published_by_name: string; published_at: string; total_bytes: number }>(
    `select version, notes, files, published_by_name, published_at, total_bytes from skill_versions where skill_id = $1 and version = $2`,
    [s.id, version ?? s.latest_version]);
  if (!v) throw notFound(`${name} has no version ${version}`);
  const manifest = {
    name: s.name,
    version: v.version,
    published_at: v.published_at,
    server: config.publicUrl,
    files: v.files.map((f) => f.path),
  };
  const versions = await q(`select version, notes, published_by_name, published_at from skill_versions where skill_id = $1 order by version desc`, [s.id]);
  return {
    name: s.name,
    description: s.description,
    latest_version: s.latest_version,
    archived: !!s.archived_at,
    ...v,
    files: [...v.files, { path: `skills/${s.name}/${MANIFEST}`, content: JSON.stringify(manifest, null, 2) + '\n' }],
    versions,
  };
}

export async function publishSkill(ctx: Ctx, raw: unknown) {
  requireGlobal(ctx, 'skills.publish');
  const input = parse(publishInput, raw);
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ path: f.path, content: f.content, ...(f.executable ? { executable: true } : {}) }));
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    checkPath(input.name, f.path);
    if (seen.has(f.path)) throw badRequest(`"${f.path}" appears twice`);
    seen.add(f.path);
    const bytes = Buffer.byteLength(f.content);
    if (bytes > MAX_FILE) throw badRequest(`"${f.path}" is larger than 512 KB`);
    total += bytes;
  }
  if (total > MAX_TOTAL) throw badRequest('A skill can be at most 2 MB in total');
  const skillMd = files.find((f) => f.path === `skills/${input.name}/SKILL.md`);
  if (!skillMd) throw badRequest(`skills/${input.name}/SKILL.md is required`);
  const description = input.description ?? frontmatterDescription(skillMd.content);
  const hash = hashFiles(files);

  // Another skill must not install over this one's agents or commands.
  const shared = files.filter((f) => !f.path.startsWith('skills/')).map((f) => f.path);
  if (shared.length) {
    const clash = await one<{ name: string; path: string }>(
      `select s.name, f->>'path' as path from skills s join skill_versions v on v.skill_id = s.id and v.version = s.latest_version,
              jsonb_array_elements(v.files) f
        where s.name <> $1 and s.archived_at is null and f->>'path' = any($2) limit 1`, [input.name, shared]);
    if (clash) throw conflict(`${clash.path} already belongs to the skill "${clash.name}"`);
  }

  return tx(async (db) => {
    await db.query(`insert into skills (name, description) values ($1, $2) on conflict (name) do nothing`, [input.name, description]);
    const s = (await db.query<{ id: string; latest_version: number }>(`select id, latest_version from skills where name = $1 for update`, [input.name])).rows[0];
    const last = (await db.query<{ content_hash: string }>(`select content_hash from skill_versions where skill_id = $1 and version = $2`, [s.id, s.latest_version])).rows[0];
    if (last?.content_hash === hash) {
      await db.query(`update skills set description = $2, archived_at = null where id = $1`, [s.id, description]);
      return { name: input.name, version: s.latest_version, unchanged: true };
    }
    const version = s.latest_version + 1;
    await db.query(
      `insert into skill_versions (skill_id, version, notes, files, content_hash, total_bytes, published_by, published_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [s.id, version, input.notes ?? '', JSON.stringify(files), hash, total, ctx.user.id === '00000000-0000-0000-0000-000000000000' ? null : ctx.user.id, ctx.user.name]);
    await db.query(`update skills set latest_version = $2, description = $3, updated_at = now(), archived_at = null where id = $1`, [s.id, version, description]);
    await audit(ctx, { action: 'skill.published', entityType: 'skill', entityId: s.id, summary: `Published skill "${input.name}" v${version} (${files.length} files)${input.notes ? `: ${input.notes}` : ''}` }, db);
    return { name: input.name, version, unchanged: false };
  });
}

export async function setSkillArchived(ctx: Ctx, name: string, archived: boolean) {
  requireGlobal(ctx, 'skills.publish');
  const s = await one<{ id: string }>(`update skills set archived_at = ${archived ? 'coalesce(archived_at, now())' : 'null'} where name = $1 returning id`, [name]);
  if (!s) throw notFound(`No skill named "${name}"`);
  await audit(ctx, { action: archived ? 'skill.archived' : 'skill.restored', entityType: 'skill', entityId: s.id, summary: `${archived ? 'Archived' : 'Restored'} skill "${name}"` });
}
