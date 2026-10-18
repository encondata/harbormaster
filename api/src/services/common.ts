import { one, q, type Db } from '../db.js';
import { badRequest, notFound } from '../errors.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FieldDef = { key: string; label: string; type: 'text' | 'longtext' | 'bool' | 'number' | 'date' | 'url' | 'select'; options?: string[] };

/** Find a project by id or key (case-insensitive). */
export async function resolveProject(ref: string, db?: Db) {
  const p = UUID_RE.test(ref)
    ? await one(`select * from projects where id = $1`, [ref], db)
    : await one(`select * from projects where key = upper($1)`, [ref], db);
  if (!p) throw notFound(`Project ${ref} not found`);
  return p as { id: string; key: string; name: string; description: string; archived_at: string | null; next_card_number: number };
}

/** Find a board by id, or by key/name within a project. */
export async function resolveBoard(projectId: string, ref: string, db?: Db) {
  const b = UUID_RE.test(ref)
    ? await one(`select * from boards where id = $1 and project_id = $2`, [ref, projectId], db)
    : await one(`select * from boards where project_id = $1 and (key = lower($2) or lower(name) = lower($2)) order by key = lower($2) desc limit 1`, [projectId, ref], db);
  if (!b) throw notFound(`Board ${ref} not found`);
  return b as { id: string; project_id: string; key: string; name: string; field_defs: FieldDef[]; parity_enabled: boolean; archived_at: string | null };
}

export async function resolveColumn(boardId: string, ref: string, db?: Db) {
  const c = UUID_RE.test(ref)
    ? await one(`select * from board_columns where id = $1 and board_id = $2`, [ref, boardId], db)
    : await one(`select * from board_columns where board_id = $1 and lower(name) = lower($2)`, [boardId, ref.trim()], db);
  if (!c) {
    const names = (await q<{ name: string }>(`select name from board_columns where board_id = $1 order by sort`, [boardId], db)).map((r) => r.name);
    throw badRequest(`Column "${ref}" not found. Columns on this board: ${names.join(', ')}`);
  }
  return c as { id: string; board_id: string; name: string; category: string; parity_weight: number | null; wip_limit: number | null };
}

export async function resolveArea(projectId: string, ref: string, db?: Db) {
  const a = UUID_RE.test(ref)
    ? await one(`select * from areas where id = $1 and project_id = $2`, [ref, projectId], db)
    : await one(`select * from areas where project_id = $1 and lower(name) = lower($2)`, [projectId, ref.trim()], db);
  if (!a) {
    const names = (await q<{ name: string }>(`select name from areas where project_id = $1 order by sort, name`, [projectId], db)).map((r) => r.name);
    throw badRequest(`Area "${ref}" not found. Areas: ${names.join(', ') || '(none)'}`);
  }
  return a as { id: string; name: string };
}

export function validateFields(defs: FieldDef[], input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const d = defs.find((f) => f.key === k);
    if (!d) throw badRequest(`Unknown field "${k}". Fields on this board: ${defs.map((f) => f.key).join(', ') || '(none)'}`);
    if (v === null || v === '') {
      out[k] = null;
      continue;
    }
    switch (d.type) {
      case 'bool':
        if (typeof v !== 'boolean') throw badRequest(`Field "${k}" must be true or false`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`Field "${k}" must be a number`);
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`Field "${k}" must be a YYYY-MM-DD date`);
        break;
      case 'select':
        if (typeof v !== 'string' || !(d.options ?? []).includes(v)) throw badRequest(`Field "${k}" must be one of: ${(d.options ?? []).join(', ')}`);
        break;
      default:
        if (typeof v !== 'string') throw badRequest(`Field "${k}" must be text`);
        if (v.length > 20000) throw badRequest(`Field "${k}" is too long`);
    }
    out[k] = v;
  }
  return out;
}
