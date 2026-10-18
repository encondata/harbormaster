// One-way export of a project to a Google Sheet: Summary, one tab per board, Weekly Summary, Requests.
// The board is the source of truth; each run overwrites those tabs and leaves any other tabs alone.
import { audit } from '../audit.js';
import { requireProject, type Ctx } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { badRequest } from '../errors.js';
import type { FieldDef } from './common.js';
import { loadServiceAccount, parseSpreadsheetId, Sheets } from './google.js';
import { boardSummary } from './projects.js';

type Cell = string | number;
export type Tab = { title: string; rows: Cell[][] };

const MAX_CELL = 45_000; // Google's limit is 50,000 characters per cell.
const cell = (v: unknown): Cell => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL - 1) + '…' : s;
};
// Sheet tab names cannot contain : \ / ? * [ ] and are limited to 100 characters.
const tabName = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 100) || 'Board';

export const stamp = (d = new Date()) =>
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(d) + ` (${config.timezone})`;

const pct = (v: number | null) => (v === null ? '' : `${Math.round(v * 1000) / 10}%`);

export async function buildTabs(projectId: string): Promise<Tab[]> {
  const project = (await one<{ key: string; name: string }>(`select key, name from projects where id = $1`, [projectId]))!;
  const boards = await q<{ id: string; key: string; name: string; parity_enabled: boolean; field_defs: FieldDef[] }>(
    `select id, key, name, parity_enabled, field_defs from boards where project_id = $1 and archived_at is null order by sort, name`,
    [projectId],
  );
  const areas = await q<{ id: string; name: string; priority: string; expected_date: string; notes: string }>(
    `select id, name, priority, expected_date, notes from areas where project_id = $1 order by sort, name`,
    [projectId],
  );
  const areaName = new Map(areas.map((a) => [a.id, a.name]));
  const tabs: Tab[] = [];

  // ---- Summary ----
  const summary: Cell[][] = [[`${project.name} (${project.key})`], ['Exported from HSL KanBan', stamp()], ['This sheet is overwritten by the daily export. Make changes in HSL KanBan.'], []];
  for (const b of boards) {
    const s = await boardSummary(b.id);
    const cols = s.columns.filter((c) => s.totals.counts[c.id]);
    summary.push([b.name], ['Status', ...cols.map((c) => c.name), 'Total', ...(b.parity_enabled ? ['Parity'] : [])]);
    summary.push(['All cards', ...cols.map((c) => s.totals.counts[c.id] ?? 0), s.totals.total, ...(b.parity_enabled ? [pct(s.totals.parity)] : [])]);
    if (b.parity_enabled) {
      summary.push([], ['By area', ...cols.map((c) => c.name), 'Total', 'Parity', 'Priority', 'Expected date', 'Notes']);
      const rows = [...areas.map((a) => ({ a, row: s.areas.find((x) => x.area_id === a.id) })), ...s.areas.filter((x) => !x.area_id).map((row) => ({ a: null, row }))];
      for (const { a, row } of rows) {
        if (!row) continue;
        summary.push([a?.name ?? '(no area)', ...cols.map((c) => row.counts[c.id] ?? ''), row.total, pct(row.parity), a?.priority ?? '', a?.expected_date ?? '', a?.notes ?? ''].map(cell));
      }
    }
    summary.push([]);
  }
  tabs.push({ title: 'Summary', rows: summary });

  // ---- One tab per board ----
  for (const b of boards) {
    const cards = await q(
      `select p.key || '-' || c.number as key, c.title, c.description, c.area_id, col.name as status, c.priority, c.tags, c.fields,
              c.estimate, c.due_date, u.name as assignee, c.updated_at
         from cards c join projects p on p.id = c.project_id join board_columns col on col.id = c.column_id left join users u on u.id = c.assignee_id
        where c.board_id = $1 and c.archived_at is null order by col.sort, c.sort, c.number`,
      [b.id],
    );
    const fields = b.field_defs ?? [];
    const header = ['Card', 'Area', 'Title', 'Description', 'Status', 'Priority', ...fields.map((f) => f.label), 'Tags', 'Estimate', 'Due', 'Assignee', 'Last updated'];
    const rows: Cell[][] = [header];
    for (const c of cards) {
      rows.push([
        c.key, c.area_id ? areaName.get(c.area_id) ?? '' : '', c.title, c.description, c.status, c.priority ?? '',
        ...fields.map((f) => c.fields?.[f.key]),
        (c.tags ?? []).join(', '), c.estimate, c.due_date ?? '', c.assignee ?? '', stamp(new Date(c.updated_at)).replace(/ \(.*\)$/, ''),
      ].map(cell));
    }
    let title = tabName(b.name);
    if (['Summary', 'Weekly Summary', 'Requests'].includes(title) || tabs.some((t) => t.title === title)) title = tabName(`${b.name} (${b.key})`);
    tabs.push({ title, rows });
  }

  // ---- Weekly Summary ----
  const updates = await q(`select title, body, hours, hours_note from project_updates where project_id = $1 order by period_start nulls last, created_at`, [projectId]);
  tabs.push({
    title: 'Weekly Summary',
    rows: [['Week of', 'What was done', 'Estimated time'], ...updates.map((u) => [u.title, u.body.replace(/^- /gm, '• '), u.hours_note || (u.hours !== null ? `${u.hours} h` : '')].map(cell))],
  });

  // ---- Requests ----
  const reqs = await q(
    `select p.key || '-R' || r.number as key, r.title, r.status, r.area_id, ru.name as requested_by, r.requested_for,
            cp.key || '-' || c.number as card, r.decision_note, r.created_at,
            (select count(*) from request_votes v where v.request_id = r.id) as votes
       from feature_requests r join projects p on p.id = r.project_id left join users ru on ru.id = r.requested_by
       left join cards c on c.id = r.card_id left join projects cp on cp.id = c.project_id
      where r.project_id = $1 order by r.number`,
    [projectId],
  );
  const statusLabel: Record<string, string> = { new: 'New', reviewing: 'Under review', accepted: 'Accepted', declined: 'Declined', duplicate: 'Duplicate' };
  tabs.push({
    title: 'Requests',
    rows: [
      ['Request', 'Title', 'Status', 'Votes', 'Area', 'Requested by', 'Requested for', 'Card', 'Decision note', 'Submitted'],
      ...reqs.map((r) => [r.key, r.title, statusLabel[r.status] ?? r.status, r.votes, r.area_id ? areaName.get(r.area_id) ?? '' : '', r.requested_by ?? '', r.requested_for, r.card ?? '', r.decision_note, stamp(new Date(r.created_at)).replace(/ \(.*\)$/, '')].map(cell)),
    ],
  });
  return tabs;
}

export async function exportSettings(ctx: Ctx, projectId: string) {
  await requireProject(ctx, projectId, 'project.manage');
  const p = (await one(
    `select sheet_export_id, sheet_export_enabled, sheet_export_hour, sheet_export_last_run_at, sheet_export_last_status, sheet_export_last_error from projects where id = $1`,
    [projectId],
  ))!;
  const sa = await loadServiceAccount();
  return {
    spreadsheet_id: p.sheet_export_id,
    url: p.sheet_export_id ? `https://docs.google.com/spreadsheets/d/${p.sheet_export_id}/edit` : null,
    enabled: p.sheet_export_enabled,
    hour: p.sheet_export_hour,
    timezone: config.timezone,
    last_run_at: p.sheet_export_last_run_at,
    last_status: p.sheet_export_last_status,
    last_error: p.sheet_export_last_error,
    service_account_email: sa?.client_email ?? null,
  };
}

export async function saveExportSettings(ctx: Ctx, projectId: string, input: { sheet?: string | null; enabled?: boolean; hour?: number }) {
  await requireProject(ctx, projectId, 'project.manage');
  const id = input.sheet === undefined ? undefined : input.sheet ? parseSpreadsheetId(input.sheet) : null;
  const cur = (await one<{ sheet_export_id: string | null }>(`select sheet_export_id from projects where id = $1`, [projectId]))!;
  if (input.enabled && !(id ?? cur.sheet_export_id)) throw badRequest('Add the Google Sheet link before turning on the daily export');
  await q(
    `update projects set sheet_export_id = case when $2::boolean then $3 else sheet_export_id end,
       sheet_export_enabled = coalesce($4, sheet_export_enabled), sheet_export_hour = coalesce($5, sheet_export_hour) where id = $1`,
    [projectId, id !== undefined, id ?? null, input.enabled ?? null, input.hour ?? null],
  );
  const parts = [id !== undefined && (id ? 'sheet set' : 'sheet removed'), input.enabled !== undefined && (input.enabled ? 'daily export on' : 'daily export off'), input.hour !== undefined && `runs at ${input.hour}:00`].filter(Boolean);
  if (parts.length) await audit(ctx, { action: 'project.sheet_export_configured', entityType: 'project', entityId: projectId, projectId, summary: `Sheet export: ${parts.join(', ')}` });
  return exportSettings(ctx, projectId);
}

/** Runs the export now. dryRun builds the tabs without touching Google. */
export async function runExport(ctx: Ctx, projectId: string, opts: { dryRun?: boolean } = {}) {
  await requireProject(ctx, projectId, 'project.manage');
  const p = (await one<{ sheet_export_id: string | null }>(`select sheet_export_id from projects where id = $1`, [projectId]))!;
  const tabs = await buildTabs(projectId);
  const preview = tabs.map((t) => ({ title: t.title, rows: Math.max(t.rows.length - 1, 0) }));
  if (opts.dryRun) return { dry_run: true, tabs: preview };
  if (!p.sheet_export_id) throw badRequest('Add the Google Sheet link first');
  try {
    const sheets = await Sheets.open(p.sheet_export_id);
    await sheets.writeTabs(tabs);
    const status = `Wrote ${tabs.length} tabs: ${preview.map((t) => `${t.title} (${t.rows})`).join(', ')}`;
    await q(`update projects set sheet_export_last_run_at = now(), sheet_export_last_status = 'ok', sheet_export_last_error = null where id = $1`, [projectId]);
    await audit(ctx, { action: 'project.sheet_exported', entityType: 'project', entityId: projectId, projectId, summary: `Exported to Google Sheet. ${status}` });
    return { dry_run: false, tabs: preview };
  } catch (e: any) {
    await q(`update projects set sheet_export_last_run_at = now(), sheet_export_last_status = 'error', sheet_export_last_error = $2 where id = $1`, [projectId, String(e?.message ?? e).slice(0, 1000)]);
    await audit(ctx, { action: 'project.sheet_export_failed', entityType: 'project', entityId: projectId, projectId, summary: `Google Sheet export failed: ${String(e?.message ?? e).slice(0, 300)}` });
    throw e;
  }
}
