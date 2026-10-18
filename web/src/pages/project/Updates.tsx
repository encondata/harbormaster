import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Update } from '../../api';
import { Confirm, ErrorBox, Modal, Spinner } from '../../components/ui';
import { shortDate, timeAgo } from '../../lib/format';
import { Markdown } from '../../lib/markdown';
import { canDo } from '../../lib/project';
import { useProjectCtx } from './ProjectLayout';

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function thisWeek() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const t = (x: Date) => `${String(x.getDate()).padStart(2, '0')}${MON[x.getMonth()]}${String(x.getFullYear()).slice(2)}`;
  return { start: iso(s), end: iso(e), title: `${t(s)} to ${t(e)}` };
}

function Editor({ projectKey, update, onClose }: { projectKey: string; update: Update | null; onClose: () => void }) {
  const w = thisWeek();
  const [title, setTitle] = useState(update?.title ?? w.title);
  const [start, setStart] = useState(update?.period_start ?? w.start);
  const [end, setEnd] = useState(update?.period_end ?? w.end);
  const [body, setBody] = useState(update?.body ?? '');
  const [hours, setHours] = useState(update?.hours?.toString() ?? '');
  const [note, setNote] = useState(update?.hours_note ?? '');
  const [err, setErr] = useState<unknown>(null);
  const qc = useQueryClient();
  return (
    <Modal wide title={update ? 'Edit progress update' : 'New progress update'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={async () => {
          const payload = { title, period_start: start || null, period_end: end || null, body, hours: hours.trim() ? Number(hours) : null, hours_note: note };
          try {
            if (update) await api.patch(`/api/projects/${projectKey}/updates/${update.id}`, payload);
            else await api.post(`/api/projects/${projectKey}/updates`, payload);
            qc.invalidateQueries({ queryKey: ['updates', projectKey] });
            onClose();
          } catch (e) { setErr(e); }
        }}>Save</button>
      </>
    }>
      <div className="form-grid">
        <div className="form-grid two">
          <label className="field">Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="form-grid two">
            <label className="field">From<input type="date" className="input" value={start ?? ''} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field">To<input type="date" className="input" value={end ?? ''} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
        </div>
        <label className="field">What was done <span className="hint">Markdown. One "- " bullet per item works well.</span>
          <textarea className="input" style={{ minHeight: 300, fontFamily: 'var(--mono)', fontSize: 12 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <div className="form-grid two">
          <label className="field">Hours<input className="input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
          <label className="field">Time note<input className="input" value={note} placeholder="e.g. estimated from commit times" onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export default function Updates() {
  const { project } = useProjectCtx();
  const q = useQuery({ queryKey: ['updates', project.key], queryFn: () => api.get<Update[]>(`/api/projects/${project.key}/updates`) });
  const [editing, setEditing] = useState<Update | null | 'new'>(null);
  const [deleting, setDeleting] = useState<Update | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const can = canDo(project, 'update.write');
  const total = (q.data ?? []).reduce((s, u) => s + (u.hours ?? 0), 0);
  return (
    <div className="page page-narrow">
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="grow muted">{q.data?.length ?? 0} updates{total ? ` · ${total.toLocaleString()} hours logged` : ''}</div>
        {can && <button className="btn primary" onClick={() => setEditing('new')}>New update</button>}
      </div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="stack">
          {(q.data ?? []).map((u, i) => {
            const expanded = i === 0 || open.has(u.id);
            return (
              <div key={u.id} className="card-box">
                <div className="hd" style={{ cursor: 'pointer' }} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}>
                  <div className="grow">
                    <h2>Week of {u.title}</h2>
                    <div className="faint small">{u.period_start ? `${shortDate(u.period_start)} – ${shortDate(u.period_end)} · ` : ''}updated {timeAgo(u.updated_at)}{u.updated_by_name ? ` by ${u.updated_by_name}` : ''}</div>
                  </div>
                  {u.hours !== null && <span className="badge accent" title={u.hours_note}>{u.hours} h</span>}
                  {can && <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEditing(u); }}>Edit</button>}
                  {can && <button className="btn ghost sm danger" onClick={(e) => { e.stopPropagation(); setDeleting(u); }}>Delete</button>}
                </div>
                {expanded && <div className="bd"><Markdown text={u.body || '_No details_'} />{u.hours_note && <div className="faint small" style={{ marginTop: 10 }}>Time: {u.hours_note}</div>}</div>}
              </div>
            );
          })}
          {!q.data?.length && <div className="empty">No progress updates yet.</div>}
        </div>
      )}
      {editing && <Editor projectKey={project.key} update={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <Confirm title="Delete this update?" danger confirmLabel="Delete" body={`"${deleting.title}" will be removed. The deletion is recorded in the activity log.`}
        onClose={() => setDeleting(null)} onConfirm={async () => { await api.del(`/api/projects/${project.key}/updates/${deleting.id}`); qc.invalidateQueries({ queryKey: ['updates', project.key] }); }} />}
    </div>
  );
}
