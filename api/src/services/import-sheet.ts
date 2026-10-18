// Imports the BaseCamp/ServerSherpa tracking workbook (Google Sheets export) into a project.
// Re-running is safe: cards are matched by a stable key per tab and updated in place, so the
// sheet can stay the source of truth until the team switches over.
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { one, pool, q } from '../db.js';
import { badRequest } from '../errors.js';
import { publish } from '../events.js';
import type { FieldDef } from './common.js';
import { createBoard, type BoardSpec } from './projects.js';
import { weekTitle } from './updates.js';

export const PARITY_BOARD: BoardSpec = {
  key: 'parity',
  name: 'Feature Parity',
  description: 'Every V2 feature and what V3 does about it. Parity counts Complete as 1, Partial and Pending Testing as 1/2.',
  parity_enabled: true,
  field_defs: [
    { key: 'in_v2', label: 'In V2', type: 'bool' },
    { key: 'where', label: 'Where it lives in V3', type: 'text' },
    { key: 'notes', label: 'Notes / gap', type: 'longtext' },
    { key: 'gap_notes', label: 'Gap notes (Gaps tab)', type: 'longtext' },
  ],
  columns: [
    { name: 'Not built', category: 'todo', color: 'red', parity_weight: 0 },
    { name: 'Pending Future', category: 'todo', color: 'slate', parity_weight: 0 },
    { name: 'Pending CSG Decision', category: 'todo', color: 'orange', parity_weight: 0 },
    { name: 'Partial', category: 'active', color: 'amber', parity_weight: 0.5 },
    { name: 'Pending Testing', category: 'active', color: 'violet', parity_weight: 0.5 },
    { name: 'Pending Future Testing', category: 'active', color: 'violet', parity_weight: 0.5 },
    { name: 'Complete', category: 'done', color: 'green', parity_weight: 1 },
    { name: 'New in V3', category: 'done', color: 'teal', parity_weight: null },
    { name: 'Future Enhancement Beyond V2', category: 'todo', color: 'blue', parity_weight: null },
    { name: 'Retired', category: 'closed', color: 'gray', parity_weight: null },
    { name: 'Abandoned', category: 'closed', color: 'gray', parity_weight: null },
  ],
};

export const TODO_BOARD: BoardSpec = {
  key: 'todo',
  name: 'To-Do',
  description: 'The prioritized build list that closes the remaining parity gaps.',
  field_defs: [
    { key: 'sheet_number', label: '#', type: 'number' },
    { key: 'status_notes', label: 'Status notes', type: 'longtext' },
    { key: 'features_closed', label: 'Features it closes', type: 'longtext' },
    { key: 'rows', label: 'Rows', type: 'number' },
  ],
  columns: [
    { name: 'Not started', category: 'todo', color: 'slate' },
    { name: 'In progress', category: 'active', color: 'amber' },
    { name: 'Deferred', category: 'todo', color: 'orange' },
    { name: 'Done', category: 'done', color: 'green' },
  ],
};

export const FUTURE_BOARD: BoardSpec = {
  key: 'future',
  name: 'Future Features',
  description: 'Enhancement requests and suggestions beyond parity.',
  field_defs: [
    { key: 'feature_type', label: 'Feature type', type: 'text' },
    { key: 'stack', label: 'Software stack affected', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  columns: [
    { name: 'Future', category: 'todo', color: 'slate' },
    { name: 'In progress', category: 'active', color: 'amber' },
    { name: 'Complete', category: 'done', color: 'green' },
  ],
};

export const SHEET_BOARDS = [PARITY_BOARD, TODO_BOARD, FUTURE_BOARD];

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const o = v as any;
  if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text).join('');
  if (o.text !== undefined) return cellText(o.text);
  if (o.result !== undefined) return cellText(o.result);
  return String(v);
}

type Table = { header: string[]; rows: Record<string, string>[] };

/** Find the header row (the first row whose cells include all `must` labels) and read rows under it until a blank row. */
function readTable(ws: ExcelJS.Worksheet | undefined, must: string[], stopAtBlank = true): Table | null {
  if (!ws) return null;
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map((v) => cellText(v).trim());
    all.push(vals);
  });
  const hi = all.findIndex((r) => must.every((m) => r.some((c) => c.toLowerCase() === m.toLowerCase())));
  if (hi < 0) return null;
  const header = all[hi];
  const rows: Record<string, string>[] = [];
  for (const r of all.slice(hi + 1)) {
    if (!r.some((c) => c)) {
      if (stopAtBlank) break;
      continue;
    }
    const rec: Record<string, string> = {};
    header.forEach((h, i) => h && (rec[h] = (r[i] ?? '').trim()));
    rows.push(rec);
  }
  return { header, rows };
}

const keyOf = (area: string, feature: string) => `${area.trim().toLowerCase()}|${feature.trim().toLowerCase()}`;

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
function parseSheetDate(s: string): string | null {
  const m = /^(\d{1,2})([A-Za-z]{3})(\d{2})$/.exec(s.trim());
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  return `20${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
}

function todoColumn(status: string) {
  const s = status.toLowerCase();
  if (s.startsWith('done')) return 'Done';
  if (s.startsWith('in progress')) return 'In progress';
  if (s.startsWith('deferred')) return 'Deferred';
  return 'Not started';
}

const PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);
const normPriority = (p: string) => {
  const s = p.trim().toLowerCase();
  if (s === 'med') return 'medium';
  return PRIORITIES.has(s) ? s : null;
};

export type ImportResult = {
  dry_run: boolean;
  areas: { created: number; updated: number };
  boards_created: string[];
  cards: Record<string, { created: number; updated: number; unchanged: number }>;
  updates: { created: number; updated: number; unchanged: number };
  warnings: string[];
};

const GOOGLE_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/;

export async function fetchGoogleSheet(url: string): Promise<Buffer> {
  const m = GOOGLE_RE.exec(url.trim());
  if (!m) throw badRequest('Give a Google Sheets link like https://docs.google.com/spreadsheets/d/<id>/edit');
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=xlsx`, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw badRequest(`Google returned ${res.status}. The sheet must be shared as "Anyone with the link can view", or upload an .xlsx export instead.`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('spreadsheetml')) throw badRequest('Google did not return a spreadsheet. Check that the sheet is shared as "Anyone with the link can view".');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 30 * 1024 * 1024) throw badRequest('Spreadsheet is larger than 30 MB');
  return buf;
}

type Want = { external_key: string; title: string; description: string; column: string; area: string | null; priority?: string | null; estimate?: string; fields: Record<string, unknown>; tags: string[]; sort?: number };

export async function importWorkbook(ctx: Ctx, projectId: string, data: Buffer, opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  await requireProject(ctx, projectId, 'project.import');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as any);
  } catch {
    throw badRequest('Could not read that file as an .xlsx workbook');
  }
  const sheet = (name: string) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());

  const result: ImportResult = {
    dry_run: !!opts.dryRun,
    areas: { created: 0, updated: 0 },
    boards_created: [],
    cards: {},
    updates: { created: 0, updated: 0, unchanged: 0 },
    warnings: [],
  };

  const summary = readTable(sheet('Summary'), ['Area', 'Complete', 'Priority']);
  const parity = readTable(sheet('Feature Parity'), ['Area', 'Feature', 'V3 status']);
  const gaps = readTable(sheet('Gaps'), ['Area', 'Feature'], false);
  const newIn = readTable(sheet('New In V3'), ['Area', 'Feature'], false);
  const todo = readTable(sheet('To-Do'), ['What to build', 'Status'], false);
  const future = readTable(sheet('Future Features'), ['Feature Name', 'Status'], false);
  const weekly = readTable(sheet('Weekly Summary'), ['Week of', 'What was done'], false);
  if (!parity && !todo && !future && !weekly) throw badRequest('This workbook has none of the expected tabs (Feature Parity, To-Do, Future Features, Weekly Summary)');

  const client = await pool.connect();
  const importCtx: Ctx = { ...ctx, via: 'import' };
  const uid = ctx.user.id === '00000000-0000-0000-0000-000000000000' ? null : ctx.user.id;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`import:${projectId}`]);

    // ----- Areas (Summary "By area" table plus any area named on a tab) -----
    const areaIds = new Map<string, string>();
    for (const a of await q<{ id: string; name: string }>(`select id, name from areas where project_id = $1`, [projectId], client)) areaIds.set(a.name.toLowerCase(), a.id);
    let areaSort = (await one<{ n: number }>(`select coalesce(max(sort), -1) + 1 as n from areas where project_id = $1`, [projectId], client))!.n;
    const ensureArea = async (name: string, meta?: { priority: string; expected_date: string; notes: string }, sort?: number) => {
      const n = name.trim();
      if (!n) return null;
      const existing = areaIds.get(n.toLowerCase());
      if (existing) {
        if (meta) {
          const r = await client.query(
            `update areas set priority = $2, expected_date = $3, notes = $4, sort = coalesce($5, sort), updated_at = now()
              where id = $1 and (priority, expected_date, notes) is distinct from ($2, $3, $4)`,
            [existing, meta.priority, meta.expected_date, meta.notes, sort ?? null],
          );
          if (r.rowCount) result.areas.updated++;
        }
        return existing;
      }
      const row = (await one<{ id: string }>(
        `insert into areas (project_id, name, sort, priority, expected_date, notes) values ($1, $2, $3, $4, $5, $6) returning id`,
        [projectId, n, sort ?? areaSort++, meta?.priority ?? '', meta?.expected_date ?? '', meta?.notes ?? ''],
        client,
      ))!;
      areaIds.set(n.toLowerCase(), row.id);
      result.areas.created++;
      return row.id;
    };
    if (summary) {
      for (const [i, r] of summary.rows.entries()) {
        if (!r['Area']) continue;
        await ensureArea(r['Area'], { priority: r['Priority'] ?? '', expected_date: r['Expected Date'] ?? '', notes: r['Notes'] ?? '' }, i);
      }
    }

    // ----- Boards -----
    const ensureBoard = async (spec: BoardSpec) => {
      let b = await one<{ id: string; field_defs: FieldDef[] }>(`select id, field_defs from boards where project_id = $1 and key = $2`, [projectId, spec.key], client);
      if (!b) {
        await createBoard(importCtx, projectId, spec, client);
        b = (await one<{ id: string; field_defs: FieldDef[] }>(`select id, field_defs from boards where project_id = $1 and key = $2`, [projectId, spec.key], client))!;
        result.boards_created.push(spec.name);
      }
      // Make sure every field and column the sheet needs exists, without touching ones users added.
      const missing = (spec.field_defs ?? []).filter((f) => !b!.field_defs.some((d) => d.key === f.key));
      if (missing.length) await client.query(`update boards set field_defs = field_defs || $2::jsonb where id = $1`, [b.id, JSON.stringify(missing)]);
      const cols = new Map<string, string>();
      for (const c of await q<{ id: string; name: string }>(`select id, name from board_columns where board_id = $1`, [b.id], client)) cols.set(c.name.toLowerCase(), c.id);
      let colSort = cols.size;
      for (const col of spec.columns) {
        if (cols.has(col.name.toLowerCase())) continue;
        const r = (await one<{ id: string }>(
          `insert into board_columns (board_id, name, sort, color, category, parity_weight) values ($1, $2, $3, $4, $5, $6) returning id`,
          [b.id, col.name, colSort++, col.color ?? '', col.category ?? 'todo', col.parity_weight ?? null],
          client,
        ))!;
        cols.set(col.name.toLowerCase(), r.id);
      }
      const columnId = async (name: string) => {
        const n = name.trim() || spec.columns[0].name;
        let id = cols.get(n.toLowerCase());
        if (!id) {
          id = (await one<{ id: string }>(`insert into board_columns (board_id, name, sort, category) values ($1, $2, $3, 'todo') returning id`, [b!.id, n, colSort++], client))!.id;
          cols.set(n.toLowerCase(), id);
          result.warnings.push(`${spec.name}: added a column for the unrecognised status "${n}"`);
        }
        return id;
      };
      return { id: b.id, columnId };
    };

    const syncCards = async (spec: BoardSpec, wants: Want[]) => {
      const board = await ensureBoard(spec);
      const stats = { created: 0, updated: 0, unchanged: 0 };
      result.cards[spec.name] = stats;
      const existing = new Map<string, any>();
      for (const c of await q(
        `select c.*, col.name as column_name, a.name as area_name, p.key || '-' || c.number as key
           from cards c join board_columns col on col.id = c.column_id left join areas a on a.id = c.area_id join projects p on p.id = c.project_id
          where c.board_id = $1 and c.external_key is not null`,
        [board.id],
        client,
      )) existing.set(c.external_key, c);
      const seen = new Set<string>();
      let sort = 1024;
      for (const w of wants) {
        if (seen.has(w.external_key)) {
          result.warnings.push(`${spec.name}: duplicate row "${w.title}" skipped`);
          continue;
        }
        seen.add(w.external_key);
        const colId = await board.columnId(w.column);
        const areaId = w.area ? await ensureArea(w.area) : null;
        const cur = existing.get(w.external_key);
        const cardSort = w.sort ?? (sort += 1024);
        if (!cur) {
          const { n } = (await one<{ n: number }>(`update projects set next_card_number = next_card_number + 1 where id = $1 returning next_card_number - 1 as n`, [projectId], client))!;
          const row = (await one<{ id: string }>(
            `insert into cards (project_id, board_id, column_id, number, title, description, area_id, priority, tags, fields, estimate, sort, external_key, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) returning id`,
            [projectId, board.id, colId, n, w.title, w.description, areaId, w.priority ?? null, w.tags, JSON.stringify(w.fields), w.estimate ?? '', cardSort, w.external_key, uid],
            client,
          ))!;
          await audit(importCtx, { action: 'card.created', entityType: 'card', entityId: row.id, projectId, summary: `Imported ${spec.name} card "${w.title}" into ${w.column}` }, client);
          stats.created++;
          continue;
        }
        const fields = { ...cur.fields };
        for (const [k, v] of Object.entries(w.fields)) {
          if (v === null || v === '') delete fields[k];
          else fields[k] = v;
        }
        const tags = [...new Set([...cur.tags, ...w.tags])];
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        const cmp = (k: string, a: unknown, b: unknown) => {
          if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[k] = { from: a ?? null, to: b ?? null };
        };
        cmp('title', cur.title, w.title);
        cmp('description', cur.description, w.description);
        cmp('column', cur.column_name, (await one(`select name from board_columns where id = $1`, [colId], client))!.name);
        cmp('area', cur.area_name, w.area);
        if (w.priority !== undefined) cmp('priority', cur.priority, w.priority);
        if (w.estimate !== undefined) cmp('estimate', cur.estimate, w.estimate);
        cmp('tags', [...cur.tags].sort(), [...tags].sort());
        for (const k of new Set([...Object.keys(cur.fields), ...Object.keys(fields)])) cmp(`fields.${k}`, cur.fields[k], fields[k]);
        if (!Object.keys(changes).length) {
          stats.unchanged++;
          continue;
        }
        await client.query(
          `update cards set title = $2, description = $3, column_id = $4, area_id = $5, priority = $6, tags = $7, fields = $8, estimate = $9,
             sort = case when column_id = $4 then sort else $10 end, updated_by = $11, updated_at = now() where id = $1`,
          [cur.id, w.title, w.description, colId, areaId, w.priority === undefined ? cur.priority : w.priority, tags, JSON.stringify(fields), w.estimate ?? cur.estimate, cardSort, uid],
        );
        const moved = changes.column ? ` (moved ${changes.column.from} → ${changes.column.to})` : '';
        await audit(importCtx, { action: changes.column ? 'card.moved' : 'card.updated', entityType: 'card', entityId: cur.id, projectId, summary: `Sheet sync updated ${cur.key}${moved}: ${Object.keys(changes).map((k) => k.replace(/^fields\./, '')).join(', ')}`, changes }, client);
        stats.updated++;
      }
      const stale = [...existing.keys()].filter((k) => !seen.has(k) && !existing.get(k).archived_at);
      if (stale.length) result.warnings.push(`${spec.name}: ${stale.length} previously imported card(s) are no longer in the sheet and were left as they are`);
    };

    // ----- Feature Parity (+ Gaps and New In V3 cross references) -----
    if (parity) {
      const gapMap = new Map((gaps?.rows ?? []).filter((r) => r['Feature']).map((r) => [keyOf(r['Area'], r['Feature']), r]));
      const newMap = new Map((newIn?.rows ?? []).filter((r) => r['Feature']).map((r) => [keyOf(r['Area'], r['Feature']), r]));
      const wants: Want[] = [];
      for (const r of parity.rows) {
        if (!r['Feature'] || !r['Area']) continue;
        const k = keyOf(r['Area'], r['Feature']);
        const gap = gapMap.get(k);
        const nv = newMap.get(k);
        const notes = r['Notes / gap'] ?? '';
        const gapNotes = gap?.['Notes / gap'] ?? '';
        wants.push({
          external_key: k,
          title: r['Feature'],
          description: r['What it does'] ?? '',
          column: r['V3 status'] || 'Not built',
          area: r['Area'],
          fields: { in_v2: (r['In V2'] ?? '').toLowerCase() === 'yes', where: r['Where it lives in V3'] || nv?.['Where it lives in V3'] || null, notes: notes || null, gap_notes: gapNotes && gapNotes !== notes ? gapNotes : null },
          tags: [...(gap ? ['gap'] : []), ...(nv ? ['new-in-v3'] : [])],
        });
      }
      const inParity = new Set(wants.map((w) => w.external_key));
      for (const [k, r] of newMap) {
        if (inParity.has(k)) continue;
        wants.push({ external_key: k, title: r['Feature'], description: r['What it does'] ?? '', column: 'New in V3', area: r['Area'], fields: { in_v2: false, where: r['Where it lives in V3'] || null }, tags: ['new-in-v3'] });
      }
      for (const [k, r] of gapMap) {
        if (inParity.has(k) || newMap.has(k)) continue;
        wants.push({ external_key: k, title: r['Feature'], description: r['What it does'] ?? '', column: r['V3 status'] || 'Not built', area: r['Area'], fields: { in_v2: (r['In V2'] ?? '').toLowerCase() === 'yes', notes: r['Notes / gap'] || null }, tags: ['gap'] });
      }
      await syncCards(PARITY_BOARD, wants);
    }

    // ----- To-Do -----
    if (todo) {
      const wants: Want[] = [];
      for (const r of todo.rows) {
        if (!r['What to build']) continue;
        const num = Number(r['#']);
        const status = r['Status'] ?? '';
        wants.push({
          external_key: Number.isFinite(num) && r['#'] ? `#${num}` : `title:${r['What to build'].toLowerCase()}`,
          title: r['What to build'],
          description: r['Why it matters'] ?? '',
          column: todoColumn(status),
          area: r['Area'] || null,
          priority: normPriority(r['Priority'] ?? ''),
          estimate: r['Time Estimate'] ?? '',
          fields: {
            sheet_number: Number.isFinite(num) && r['#'] ? num : null,
            status_notes: status || null,
            features_closed: r['Features it closes'] || null,
            rows: r['Rows'] && Number.isFinite(Number(r['Rows'])) ? Number(r['Rows']) : null,
          },
          tags: [],
          sort: Number.isFinite(num) ? num * 1024 : undefined,
        });
      }
      await syncCards(TODO_BOARD, wants);
    }

    // ----- Future Features -----
    if (future) {
      const wants: Want[] = [];
      for (const r of future.rows) {
        if (!r['Feature Name']) continue;
        const s = (r['Status'] ?? '').trim().toLowerCase();
        wants.push({
          external_key: r['Feature Name'].trim().toLowerCase(),
          title: r['Feature Name'],
          description: r['Description'] ?? '',
          column: s.startsWith('complete') ? 'Complete' : s.startsWith('in progress') ? 'In progress' : 'Future',
          area: null,
          fields: { feature_type: r['Feature Type'] || null, stack: r['Software Stack Affected'] || null, notes: r['Notes'] || null },
          tags: [],
        });
      }
      await syncCards(FUTURE_BOARD, wants);
    }

    // ----- Weekly Summary -> progress updates -----
    if (weekly) {
      for (const r of weekly.rows) {
        const week = r['Week of'];
        if (!week) continue;
        const [a, b] = week.split(/\s+to\s+/i);
        const start = a ? parseSheetDate(a) : null;
        const end = b ? parseSheetDate(b) : null;
        const title = start && end ? weekTitle(start, end) : week;
        const body = (r['What was done'] ?? '').replace(/^\s*•\s*/gm, '- ');
        const note = r['Estimated time'] ?? '';
        const hm = /~?\s*([\d.]+)\s*h/i.exec(note);
        const hours = hm ? Number(hm[1]) : null;
        const cur = await one(`select * from project_updates where project_id = $1 and title = $2`, [projectId, title], client);
        if (!cur) {
          const row = (await one(
            `insert into project_updates (project_id, title, period_start, period_end, body, hours, hours_note, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
            [projectId, title, start, end, body, hours, note, uid],
            client,
          ))!;
          await audit(importCtx, { action: 'update.created', entityType: 'update', entityId: row.id, projectId, summary: `Imported progress update "${title}"` }, client);
          result.updates.created++;
        } else if (cur.body !== body || cur.hours !== hours || cur.hours_note !== note || cur.period_start !== start || cur.period_end !== end) {
          await client.query(`update project_updates set body = $2, hours = $3, hours_note = $4, period_start = $5, period_end = $6, updated_by = $7, updated_at = now() where id = $1`, [cur.id, body, hours, note, start, end, uid]);
          await audit(importCtx, { action: 'update.edited', entityType: 'update', entityId: cur.id, projectId, summary: `Sheet sync updated progress update "${title}"` }, client);
          result.updates.updated++;
        } else result.updates.unchanged++;
      }
    }

    const counts = Object.entries(result.cards).map(([b, s]) => `${b}: ${s.created} new, ${s.updated} changed`).join('; ');
    await audit(importCtx, { action: 'project.imported', entityType: 'project', entityId: projectId, projectId, summary: `Synced from spreadsheet. ${counts}. Updates: ${result.updates.created} new, ${result.updates.updated} changed.`, changes: result }, client);
    await client.query(opts.dryRun ? 'rollback' : 'commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!opts.dryRun) publish({ projectId, type: 'project.imported', actor: ctx.user.name });
  return result;
}
