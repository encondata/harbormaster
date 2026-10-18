import type { Ctx } from './auth.js';
import { pool, type Db } from './db.js';

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  summary: string;
  changes?: unknown;
};

const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';

export async function audit(ctx: Ctx, e: AuditEntry, db: Db = pool) {
  const actorId = ctx.user.id === SYSTEM_ID ? null : ctx.user.id;
  await db.query(
    `insert into audit_log (actor_id, actor_name, token_id, via, ip, action, entity_type, entity_id, project_id, summary, changes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [actorId, ctx.user.name, ctx.tokenId, ctx.via, ctx.ip, e.action, e.entityType, e.entityId ?? null, e.projectId ?? null, e.summary, e.changes === undefined ? null : JSON.stringify(e.changes)],
  );
}

/** Field-level diff of two flat records, limited to the given keys. */
export function diff(before: Record<string, any>, after: Record<string, any>, keys: string[]) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
