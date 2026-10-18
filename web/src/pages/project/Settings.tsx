import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type Board, type Column, type FieldDef, type Project, type Role } from '../../api';
import { Avatar, Confirm, ErrorBox, Modal, useToast } from '../../components/ui';
import { COLORS, colorVar, dateTime } from '../../lib/format';
import { canDo } from '../../lib/project';
import { useProjectCtx } from './ProjectLayout';

type Member = { id: string; name: string; email: string; kind: string; is_active: boolean; role_id: string; role_name: string; avatar_updated_at: string | null };

function useRefresh(p: Project) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['project', p.key] });
    qc.invalidateQueries({ queryKey: ['summary', p.key] });
    qc.invalidateQueries({ queryKey: ['cards', p.key] });
    qc.invalidateQueries({ queryKey: ['me'] });
  };
}

function General({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [err, setErr] = useState<unknown>(null);
  const refresh = useRefresh(project);
  const toast = useToast();
  return (
    <div className="card-box">
      <div className="hd"><h2>General</h2></div>
      <div className="bd form-grid">
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field">Description<textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <ErrorBox error={err} />
        <div className="btn-row">
          <button className="btn primary" onClick={async () => { try { await api.patch(`/api/projects/${project.key}`, { name, description }); refresh(); toast('Saved'); } catch (e) { setErr(e); } }}>Save</button>
          <span className="grow" />
          <button className="btn" onClick={async () => { await api.patch(`/api/projects/${project.key}`, { archived: !project.archived_at }); refresh(); }}>{project.archived_at ? 'Unarchive project' : 'Archive project'}</button>
        </div>
      </div>
    </div>
  );
}

function Members({ project }: { project: Project }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', project.key], queryFn: () => api.get<Member[]>(`/api/projects/${project.key}/members`) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/api/roles') });
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get<{ id: string; name: string; email: string; kind: string }[]>('/api/users/directory') });
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const projectRoles = (roles.data ?? []).filter((r) => r.scope === 'project');
  const set = async (userId: string, roleId: string | null) => {
    setErr(null);
    try {
      if (roleId) await api.put(`/api/projects/${project.key}/members/${userId}`, { role_id: roleId });
      else await api.del(`/api/projects/${project.key}/members/${userId}`);
      qc.invalidateQueries({ queryKey: ['members', project.key] });
    } catch (e) { setErr(e); }
  };
  const memberIds = new Set((members.data ?? []).map((m) => m.id));
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Members</h2><span className="faint small">Administrators can see every project without being members.</span></div>
      <div className="bd stack-sm">
        {(members.data ?? []).map((m) => (
          <div key={m.id} className="row">
            <Avatar name={m.name} service={m.kind === 'service'} userId={m.id} photoAt={m.avatar_updated_at} />
            <div className="grow"><div style={{ fontWeight: 550 }}>{m.name}{m.kind === 'service' && <span className="badge warn" style={{ marginLeft: 6 }}>service</span>}{!m.is_active && <span className="badge" style={{ marginLeft: 6 }}>inactive</span>}</div><div className="faint small">{m.email}</div></div>
            <select className="input sm" style={{ width: 160 }} value={m.role_id} onChange={(e) => set(m.id, e.target.value)}>
              {projectRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="btn ghost sm danger" onClick={() => set(m.id, null)}>Remove</button>
          </div>
        ))}
        <hr />
        <div className="row">
          <select className="input sm grow" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a person…</option>
            {(dir.data ?? []).filter((u) => !memberIds.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
          </select>
          <select className="input sm" style={{ width: 160 }} value={addRole} onChange={(e) => setAddRole(e.target.value)}>
            <option value="">Role…</option>
            {projectRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="btn sm primary" disabled={!adding || !addRole} onClick={async () => { await set(adding, addRole); setAdding(''); }}>Add</button>
        </div>
        <ErrorBox error={err} />
      </div>
    </div>
  );
}

function ColumnRow({ project, board, col, idx, total }: { project: Project; board: Board; col: Column; idx: number; total: number }) {
  const refresh = useRefresh(project);
  const [err, setErr] = useState<unknown>(null);
  const [del, setDel] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const save = async (patch: Partial<Column>) => {
    setErr(null);
    try { await api.patch(`/api/projects/${project.key}/boards/${board.id}/columns/${col.id}`, patch); refresh(); } catch (e) { setErr(e); }
  };
  const swap = async (dir: -1 | 1) => {
    const other = board.columns[idx + dir];
    if (!other) return;
    await api.patch(`/api/projects/${project.key}/boards/${board.id}/columns/${col.id}`, { sort: other.sort });
    await api.patch(`/api/projects/${project.key}/boards/${board.id}/columns/${other.id}`, { sort: col.sort });
    refresh();
  };
  return (
    <tr>
      <td><div className="row" style={{ gap: 2 }}><button className="btn ghost sm icon" disabled={idx === 0} onClick={() => swap(-1)}>↑</button><button className="btn ghost sm icon" disabled={idx === total - 1} onClick={() => swap(1)}>↓</button></div></td>
      <td><input className="input sm" defaultValue={col.name} onBlur={(e) => e.target.value.trim() && e.target.value !== col.name && save({ name: e.target.value.trim() })} />{err ? <ErrorBox error={err} /> : null}</td>
      <td><select className="input sm" value={col.category} onChange={(e) => save({ category: e.target.value as Column['category'] })}><option value="todo">To do</option><option value="active">Active</option><option value="done">Done</option><option value="closed">Closed (collapsed)</option></select></td>
      <td><div className="row"><span className="dot" style={{ background: colorVar(col.color) }} /><select className="input sm" value={col.color} onChange={(e) => save({ color: e.target.value })}><option value="">default</option>{COLORS.map((c) => <option key={c}>{c}</option>)}</select></div></td>
      {board.parity_enabled && <td><select className="input sm" value={col.parity_weight === null ? '' : String(col.parity_weight)} onChange={(e) => save({ parity_weight: e.target.value === '' ? null : Number(e.target.value) })}><option value="">Excluded</option><option value="1">Full (1)</option><option value="0.5">Half (½)</option><option value="0">Zero (0)</option></select></td>}
      <td><input className="input sm" style={{ width: 70 }} defaultValue={col.wip_limit ?? ''} placeholder="—" onBlur={(e) => { const v = e.target.value.trim(); const n = v ? Number(v) : null; if (n !== col.wip_limit) save({ wip_limit: n }); }} /></td>
      <td className="num">{col.card_count}</td>
      <td><button className="btn ghost sm danger" onClick={() => setDel(true)}>Delete</button>
        {del && <Confirm title={`Delete column "${col.name}"?`} danger confirmLabel="Delete column" onClose={() => setDel(false)}
          body={col.card_count ? (
            <div className="stack-sm"><div>It has {col.card_count} cards. Move them to:</div>
              <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}><option value="">Choose a column…</option>{board.columns.filter((c) => c.id !== col.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          ) : 'The column is empty.'}
          onConfirm={async () => { await api.del(`/api/projects/${project.key}/boards/${board.id}/columns/${col.id}${moveTo ? `?move_to=${moveTo}` : ''}`); refresh(); }} />}
      </td>
    </tr>
  );
}

function FieldsEditor({ project, board, onClose }: { project: Project; board: Board; onClose: () => void }) {
  const [defs, setDefs] = useState<FieldDef[]>(board.field_defs);
  const [err, setErr] = useState<unknown>(null);
  const refresh = useRefresh(project);
  const upd = (i: number, patch: Partial<FieldDef>) => setDefs((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal wide title={`Card fields on ${board.name}`} onClose={onClose} footer={
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={async () => {
          try { await api.patch(`/api/projects/${project.key}/boards/${board.id}`, { field_defs: defs.map((d) => ({ ...d, options: d.type === 'select' ? d.options ?? [] : undefined })) }); refresh(); onClose(); } catch (e) { setErr(e); }
        }}>Save fields</button></>
    }>
      <div className="stack-sm">
        <div className="faint small">Extra fields shown on every card of this board. Removing a field hides it; values already stored on cards stay in their history.</div>
        <table className="t">
          <thead><tr><th>Key</th><th>Label</th><th>Type</th><th>Options (select)</th><th /></tr></thead>
          <tbody>
            {defs.map((d, i) => (
              <tr key={i}>
                <td><input className="input sm mono" value={d.key} disabled={board.field_defs.some((x) => x.key === d.key)} onChange={(e) => upd(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></td>
                <td><input className="input sm" value={d.label} onChange={(e) => upd(i, { label: e.target.value })} /></td>
                <td><select className="input sm" value={d.type} onChange={(e) => upd(i, { type: e.target.value as FieldDef['type'] })}>{['text', 'longtext', 'bool', 'number', 'date', 'url', 'select'].map((t) => <option key={t}>{t}</option>)}</select></td>
                <td><input className="input sm" disabled={d.type !== 'select'} value={(d.options ?? []).join(', ')} onChange={(e) => upd(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></td>
                <td><button className="btn ghost sm danger" onClick={() => setDefs((x) => x.filter((_, j) => j !== i))}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div><button className="btn sm" onClick={() => setDefs((d) => [...d, { key: `field_${d.length + 1}`, label: 'New field', type: 'text' }])}>Add field</button></div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function Boards({ project }: { project: Project }) {
  const refresh = useRefresh(project);
  const [fields, setFields] = useState<Board | null>(null);
  const [newCol, setNewCol] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [nb, setNb] = useState({ name: '', key: '' });
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Boards &amp; columns</h2><button className="btn sm" onClick={() => setCreating(true)}>New board</button></div>
      <div className="bd stack">
        {project.boards.map((b) => (
          <div key={b.id} className="stack-sm">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input className="input" style={{ maxWidth: 260, fontWeight: 600 }} defaultValue={b.name} onBlur={async (e) => { if (e.target.value.trim() && e.target.value !== b.name) { await api.patch(`/api/projects/${project.key}/boards/${b.id}`, { name: e.target.value.trim() }); refresh(); } }} />
              <span className="mono faint small">{b.key}</span>
              <label className="check"><input type="checkbox" checked={b.parity_enabled} onChange={async (e) => { await api.patch(`/api/projects/${project.key}/boards/${b.id}`, { parity_enabled: e.target.checked }); refresh(); }} /> Parity scoring</label>
              <span className="grow" />
              <button className="btn sm" onClick={() => setFields(b)}>Card fields ({b.field_defs.length})</button>
              <button className="btn sm" onClick={async () => { await api.patch(`/api/projects/${project.key}/boards/${b.id}`, { archived: !b.archived_at }); refresh(); }}>{b.archived_at ? 'Unarchive' : 'Archive'}</button>
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th /><th>Column</th><th>Category</th><th>Color</th>{b.parity_enabled && <th>Parity weight</th>}<th>WIP limit</th><th className="num">Cards</th><th /></tr></thead>
                <tbody>{b.columns.map((c, i) => <ColumnRow key={c.id} project={project} board={b} col={c} idx={i} total={b.columns.length} />)}</tbody>
              </table>
            </div>
            <form className="row" onSubmit={async (e) => {
              e.preventDefault();
              const name = (newCol[b.id] ?? '').trim();
              if (!name) return;
              try { await api.post(`/api/projects/${project.key}/boards/${b.id}/columns`, { name }); setNewCol((s) => ({ ...s, [b.id]: '' })); refresh(); } catch (e2) { setErr(e2); }
            }}>
              <input className="input sm" style={{ maxWidth: 240 }} placeholder="New column name" value={newCol[b.id] ?? ''} onChange={(e) => setNewCol((s) => ({ ...s, [b.id]: e.target.value }))} />
              <button className="btn sm">Add column</button>
            </form>
          </div>
        ))}
        <ErrorBox error={err} />
      </div>
      {fields && <FieldsEditor project={project} board={fields} onClose={() => setFields(null)} />}
      {creating && (
        <Modal title="New board" onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>Cancel</button>
          <button className="btn primary" onClick={async () => { try { await api.post(`/api/projects/${project.key}/boards`, nb); refresh(); setCreating(false); } catch (e) { setErr(e); } }}>Create</button></>}>
          <div className="form-grid">
            <label className="field">Name<input className="input" value={nb.name} onChange={(e) => setNb({ name: e.target.value, key: nb.key || '' })} autoFocus /></label>
            <label className="field">Key <span className="hint">Used in URLs; lowercase letters, digits, dashes</span><input className="input mono" value={nb.key || nb.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')} onChange={(e) => setNb({ ...nb, key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></label>
            <div className="faint small">Starts with Backlog, To Do, In Progress, Review and Done. Edit columns afterwards.</div>
            <ErrorBox error={err} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Areas({ project }: { project: Project }) {
  const refresh = useRefresh(project);
  const [name, setName] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [del, setDel] = useState<string | null>(null);
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Areas</h2><span className="faint small">Functional areas group cards across boards. Priority, dates and notes are edited on the Summary.</span></div>
      <div className="bd stack-sm">
        {project.areas.map((a, i) => (
          <div key={a.id} className="row">
            <button className="btn ghost sm icon" disabled={i === 0} onClick={async () => { const o = project.areas[i - 1]; await api.patch(`/api/projects/${project.key}/areas/${a.id}`, { sort: o.sort }); await api.patch(`/api/projects/${project.key}/areas/${o.id}`, { sort: a.sort }); refresh(); }}>↑</button>
            <input className="input sm grow" defaultValue={a.name} onBlur={async (e) => { if (e.target.value.trim() && e.target.value !== a.name) { try { await api.patch(`/api/projects/${project.key}/areas/${a.id}`, { name: e.target.value.trim() }); refresh(); } catch (e2) { setErr(e2); } } }} />
            <button className="btn ghost sm danger" onClick={() => setDel(a.id)}>Delete</button>
          </div>
        ))}
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; try { await api.post(`/api/projects/${project.key}/areas`, { name: name.trim() }); setName(''); refresh(); } catch (e2) { setErr(e2); } }}>
          <input className="input sm grow" placeholder="New area" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn sm">Add area</button>
        </form>
        <ErrorBox error={err} />
      </div>
      {del && <Confirm title="Delete area?" danger confirmLabel="Delete" body="Cards in this area keep everything else but lose their area." onClose={() => setDel(null)} onConfirm={async () => { await api.del(`/api/projects/${project.key}/areas/${del}`); refresh(); }} />}
    </div>
  );
}

type ImportResult = { dry_run: boolean; areas: { created: number; updated: number }; boards_created: string[]; cards: Record<string, { created: number; updated: number; unchanged: number }>; updates: { created: number; updated: number; unchanged: number }; warnings: string[] };

function Import({ project }: { project: Project }) {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const refresh = useRefresh(project);
  const qc = useQueryClient();
  const run = async (dry: boolean) => {
    setBusy(true); setErr(null); setRes(null);
    try {
      let r: ImportResult;
      if (file) {
        const fd = new FormData();
        fd.append('dry_run', String(dry));
        fd.append('file', file);
        r = await api.post(`/api/projects/${project.key}/import`, fd);
      } else r = await api.post(`/api/projects/${project.key}/import`, { url, dry_run: dry });
      setRes(r);
      if (!dry) { refresh(); qc.invalidateQueries({ queryKey: ['updates', project.key] }); }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="card-box">
      <div className="hd"><h2>Sync from the tracking spreadsheet</h2></div>
      <div className="bd stack-sm">
        <div className="muted small">
          Reads the Summary, Feature Parity, Gaps, New In V3, To-Do, Future Features and Weekly Summary tabs. Cards are matched to what is already here, so you can run it again whenever the sheet changes.
          A sync overwrites the sheet-sourced fields and status of matched cards; stop syncing once the team works in the board directly.
        </div>
        <label className="field">Google Sheets link <span className="hint">Shared as "Anyone with the link can view"</span>
          <input className="input" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value={url} onChange={(e) => { setUrl(e.target.value); setFile(null); }} /></label>
        <label className="field">…or upload an .xlsx export<input className="input" type="file" accept=".xlsx" style={{ paddingTop: 4 }} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUrl(''); }} /></label>
        <div className="btn-row">
          <button className="btn" disabled={busy || (!url && !file)} onClick={() => run(true)}>Preview changes</button>
          <button className="btn primary" disabled={busy || (!url && !file)} onClick={() => run(false)}>{busy ? 'Working…' : 'Sync now'}</button>
        </div>
        <ErrorBox error={err} />
        {res && (
          <div className={res.dry_run ? 'warn-box' : 'ok-box'}>
            <b>{res.dry_run ? 'Preview — nothing was saved.' : 'Sync complete.'}</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {Object.entries(res.cards).map(([b, s]) => <li key={b}>{b}: {s.created} new, {s.updated} changed, {s.unchanged} unchanged</li>)}
              <li>Progress updates: {res.updates.created} new, {res.updates.updated} changed</li>
              <li>Areas: {res.areas.created} new, {res.areas.updated} changed</li>
              {res.boards_created.length > 0 && <li>New boards: {res.boards_created.join(', ')}</li>}
              {res.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

type ExportSettings = {
  spreadsheet_id: string | null; url: string | null; enabled: boolean; hour: number; timezone: string;
  last_run_at: string | null; last_status: string | null; last_error: string | null; service_account_email: string | null;
};

function SheetExport({ project }: { project: Project }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['sheet-export', project.key];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<ExportSettings>(`/api/projects/${project.key}/sheet-export`) });
  const [sheet, setSheet] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'export'>('');
  const [err, setErr] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ dry_run: boolean; tabs: { title: string; rows: number }[] } | null>(null);
  useEffect(() => setSheet(q.data?.url ?? ''), [q.data?.url]);
  const s = q.data;
  const save = async (body: object, msg?: string) => {
    setErr(null);
    try {
      qc.setQueryData(key, await api.put<ExportSettings>(`/api/projects/${project.key}/sheet-export`, body));
      if (msg) toast(msg);
    } catch (e) {
      setErr(e);
    }
  };
  const run = async (dry: boolean) => {
    setBusy(dry ? 'preview' : 'export'); setErr(null); setPreview(null);
    try {
      setPreview(await api.post(`/api/projects/${project.key}/sheet-export/run`, { dry_run: dry }));
      if (!dry) toast('Exported to the Google Sheet');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy('');
      qc.invalidateQueries({ queryKey: key });
    }
  };
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Daily Google Sheet export</h2>{s?.enabled ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</div>
      <div className="bd stack-sm">
        <div className="muted small">
          Once a day, copies this project into a Google Sheet: a Summary tab, one tab per board, Weekly Summary and Requests.
          Those tabs are overwritten each time; other tabs in the sheet are left alone. Use a separate sheet from the one you sync from.
        </div>
        {!s ? <div className="faint small">Loading…</div> : (
          <>
            {s.service_account_email ? (
              <div className="small">
                Share the sheet with <span className="mono" style={{ userSelect: 'all' }}>{s.service_account_email}</span> as an <b>Editor</b>.{' '}
                <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(s.service_account_email!).then(() => toast('Email copied'), () => {}); }}>Copy</button>
              </div>
            ) : (
              <div className="warn-box">The server has no Google service account yet, so exports can't write to Google. Follow docs/SHEET-EXPORT.md in the repository, then reload this page. Preview works without it.</div>
            )}
            <label className="field">Google Sheet link
              <div className="row">
                <input className="input" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value={sheet} onChange={(e) => setSheet(e.target.value)} />
                <button className="btn" disabled={sheet === (s.url ?? '')} onClick={() => save({ sheet: sheet.trim() || null }, sheet.trim() ? 'Sheet saved' : 'Sheet removed')}>Save</button>
              </div>
            </label>
            {s.url && <a className="small" href={s.url} target="_blank" rel="noreferrer">Open the sheet ↗</a>}
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? 'Daily export turned on' : 'Daily export turned off')} /> Export every day at</label>
              <select className="input sm" style={{ width: 'auto' }} value={s.hour} onChange={(e) => save({ hour: Number(e.target.value) })} aria-label="Hour">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <span className="faint small">{s.timezone}</span>
            </div>
            <div className="btn-row">
              <button className="btn" disabled={!!busy} onClick={() => run(true)}>{busy === 'preview' ? 'Building preview…' : 'Preview'}</button>
              <button className="btn primary" disabled={!!busy || !s.spreadsheet_id || !s.service_account_email} onClick={() => run(false)}>{busy === 'export' ? 'Exporting…' : 'Export now'}</button>
            </div>
            {s.last_run_at && (
              s.last_status === 'ok'
                ? <div className="ok-box">Last export {dateTime(s.last_run_at)} succeeded.</div>
                : <div className="error-box">Last export {dateTime(s.last_run_at)} failed: {s.last_error}</div>
            )}
            {preview && (
              <div className={preview.dry_run ? 'warn-box' : 'ok-box'}>
                <b>{preview.dry_run ? 'Preview: nothing was written.' : 'Export complete.'}</b> Tabs: {preview.tabs.map((t) => `${t.title} (${t.rows} rows)`).join(', ')}
              </div>
            )}
            <ErrorBox error={err} />
          </>
        )}
      </div>
    </div>
  );
}

export default function Settings() {
  const { project } = useProjectCtx();
  if (!canDo(project, 'project.manage')) return <div className="page"><ErrorBox error="You need the Owner role to change project settings." /></div>;
  return (
    <div className="page page-narrow">
      <div className="stack">
        <General project={project} />
        <Members project={project} />
        <Boards project={project} />
        <Areas project={project} />
        {canDo(project, 'project.import') && <Import project={project} />}
        <SheetExport project={project} />
      </div>
    </div>
  );
}
