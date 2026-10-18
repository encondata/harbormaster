import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Area } from '../../api';
import { ErrorBox, Modal, Spinner } from '../../components/ui';
import { colorVar, pct, pctClass, timeAgo } from '../../lib/format';
import { canDo } from '../../lib/project';
import { useProjectCtx } from './ProjectLayout';

type Col = { id: string; name: string; category: string; parity_weight: number | null; color: string };
type BoardSum = {
  board: { id: string; key: string; name: string; parity_enabled: boolean };
  columns: Col[];
  areas: { area_id: string | null; counts: Record<string, number>; total: number; parity: number | null }[];
  totals: { counts: Record<string, number>; total: number; counted: number; parity: number | null };
};
type SummaryData = { boards: BoardSum[]; recent: { id: number; at: string; actor_name: string; via: string; summary: string }[]; latest_update: { title: string; hours: number | null; updated_at: string } | null };

function AreaEditor({ area, projectKey, onClose }: { area: Area; projectKey: string; onClose: () => void }) {
  const [priority, setPriority] = useState(area.priority);
  const [expected, setExpected] = useState(area.expected_date);
  const [notes, setNotes] = useState(area.notes);
  const [err, setErr] = useState<unknown>(null);
  const qc = useQueryClient();
  return (
    <Modal title={`Area: ${area.name}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={async () => {
          try {
            await api.patch(`/api/projects/${projectKey}/areas/${area.id}`, { priority, expected_date: expected, notes });
            qc.invalidateQueries({ queryKey: ['project', projectKey] });
            qc.invalidateQueries({ queryKey: ['summary', projectKey] });
            onClose();
          } catch (e) {
            setErr(e);
          }
        }}>Save</button>
      </>
    }>
      <div className="form-grid">
        <div className="form-grid two">
          <label className="field">Priority<input className="input" list="area-prio" value={priority} onChange={(e) => setPriority(e.target.value)} /></label>
          <label className="field">Expected date<input className="input" value={expected} placeholder="e.g. 24Nov26 or No ETA" onChange={(e) => setExpected(e.target.value)} /></label>
        </div>
        <datalist id="area-prio">{['High', 'Med', 'Low', 'Long Term', 'Ongoing', 'Complete', 'Retired'].map((p) => <option key={p} value={p} />)}</datalist>
        <label className="field">Notes<textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function StatusBar({ b }: { b: BoardSum }) {
  const total = b.totals.total || 1;
  return (
    <div className="bar" style={{ height: 8 }}>
      {b.columns.map((c) => {
        const n = b.totals.counts[c.id] ?? 0;
        return n ? <span key={c.id} title={`${c.name}: ${n}`} style={{ width: `${(n / total) * 100}%`, background: colorVar(c.color) }} /> : null;
      })}
    </div>
  );
}

export default function Summary() {
  const { project } = useProjectCtx();
  const q = useQuery({ queryKey: ['summary', project.key], queryFn: () => api.get<SummaryData>(`/api/projects/${project.key}/summary`) });
  const [editing, setEditing] = useState<Area | null>(null);
  const areas = new Map(project.areas.map((a) => [a.id, a]));
  const manage = canDo(project, 'area.edit');
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <div className="page"><ErrorBox error={q.error} /></div>;
  const s = q.data;
  const parityBoard = s.boards.find((b) => b.board.parity_enabled);

  return (
    <div className="page">
      <div className="stack">
        {project.description && <div className="muted">{project.description}</div>}

        {parityBoard && (() => {
          const byName = (n: string) => parityBoard.columns.filter((c) => c.name.toLowerCase().startsWith(n)).reduce((sum, c) => sum + (parityBoard.totals.counts[c.id] ?? 0), 0);
          const pending = parityBoard.columns.filter((c) => c.name.toLowerCase().startsWith('pending')).reduce((sum, c) => sum + (parityBoard.totals.counts[c.id] ?? 0), 0);
          return (
            <div className="stat-row">
              <div className="stat"><div className={`v pct ${pctClass(parityBoard.totals.parity)}`}>{pct(parityBoard.totals.parity)}</div><div className="l">Parity ({parityBoard.board.name})</div></div>
              <div className="stat"><div className="v">{parityBoard.totals.counted}</div><div className="l">Features carried forward</div></div>
              <div className="stat"><div className="v">{byName('complete')}</div><div className="l">Built</div></div>
              <div className="stat"><div className="v">{byName('partial')}</div><div className="l">Partially built</div></div>
              <div className="stat"><div className="v">{byName('not built')}</div><div className="l">Not built yet</div></div>
              <div className="stat"><div className="v">{pending}</div><div className="l">Pending</div></div>
              <div className="stat"><div className="v">{byName('retired') + byName('abandoned')}</div><div className="l">Retired</div></div>
              <div className="stat"><div className="v">{byName('new in')}</div><div className="l">New capabilities</div></div>
            </div>
          );
        })()}

        <div className="stat-row">
          {s.boards.filter((b) => b !== parityBoard).map((b) => (
            <Link key={b.board.id} to={`/p/${project.key}/b/${b.board.key}`} className="stat" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="row" style={{ marginBottom: 8 }}><h3 className="grow">{b.board.name}</h3><span className="faint small">{b.totals.total} cards</span></div>
              <StatusBar b={b} />
              <div className="row small" style={{ flexWrap: 'wrap', gap: '4px 12px', marginTop: 8 }}>
                {b.columns.map((c) => (
                  <span key={c.id} className="row" style={{ gap: 4 }}><span className="dot" style={{ background: colorVar(c.color) }} />{c.name} <b>{b.totals.counts[c.id] ?? 0}</b></span>
                ))}
              </div>
            </Link>
          ))}
          {s.latest_update && (
            <Link to={`/p/${project.key}/updates`} className="stat" style={{ color: 'inherit', textDecoration: 'none' }}>
              <h3>Latest update</h3>
              <div style={{ margin: '6px 0' }}>{s.latest_update.title}</div>
              <div className="faint small">{s.latest_update.hours ? `${s.latest_update.hours} h · ` : ''}updated {timeAgo(s.latest_update.updated_at)}</div>
            </Link>
          )}
        </div>

        {parityBoard && (
          <div className="card-box">
            <div className="hd"><h2 className="grow">By area</h2><StatusBar b={parityBoard} /></div>
            <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>Area</th>
                    {parityBoard.columns.filter((c) => parityBoard.totals.counts[c.id]).map((c) => <th key={c.id} className="num" title={c.name}><span className="dot" style={{ background: colorVar(c.color), marginRight: 4 }} />{c.name}</th>)}
                    <th className="num">Parity</th><th>Priority</th><th>Expected</th><th>Notes</th>{manage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {[...project.areas.map((a) => parityBoard.areas.find((x) => x.area_id === a.id) ?? { area_id: a.id, counts: {}, total: 0, parity: null }), ...parityBoard.areas.filter((x) => !x.area_id)].map((row) => {
                    const a = row.area_id ? areas.get(row.area_id) : null;
                    return (
                      <tr key={row.area_id ?? 'none'}>
                        <td style={{ fontWeight: 550, whiteSpace: 'nowrap' }}>{a?.name ?? <span className="faint">(no area)</span>}</td>
                        {parityBoard.columns.filter((c) => parityBoard.totals.counts[c.id]).map((c) => (
                          <td key={c.id} className="num">{row.counts[c.id] ? <Link to={`/p/${project.key}/b/${parityBoard.board.key}?view=table&column=${c.id}${a ? `&area=${a.id}` : ''}`}>{row.counts[c.id]}</Link> : ''}</td>
                        ))}
                        <td className={`num pct ${pctClass(row.parity)}`}>{pct(row.parity)}</td>
                        <td>{a?.priority}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{a?.expected_date}</td>
                        <td className="muted small" style={{ minWidth: 200 }}>{a?.notes}</td>
                        {manage && <td>{a && <button className="btn ghost sm" onClick={() => setEditing(a)}>Edit</button>}</td>}
                      </tr>
                    );
                  })}
                  <tr className="total">
                    <td>Total</td>
                    {parityBoard.columns.filter((c) => parityBoard.totals.counts[c.id]).map((c) => <td key={c.id} className="num">{parityBoard.totals.counts[c.id]}</td>)}
                    <td className={`num pct ${pctClass(parityBoard.totals.parity)}`}>{pct(parityBoard.totals.parity)}</td><td colSpan={manage ? 4 : 3} />
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="bd faint small">
              Parity counts {parityBoard.columns.filter((c) => c.parity_weight === 1).map((c) => c.name).join(', ')} as full;{' '}
              {parityBoard.columns.filter((c) => c.parity_weight === 0.5).map((c) => c.name).join(', ')} as half;{' '}
              {parityBoard.columns.filter((c) => c.parity_weight === 0).map((c) => c.name).join(', ')} as zero. Others are excluded.
            </div>
          </div>
        )}

        <div className="card-box">
          <div className="hd"><h2 className="grow">Recent activity</h2>{canDo(project, 'project.audit') && <Link to={`/p/${project.key}/activity`} className="small">See all</Link>}</div>
          <div className="bd timeline">
            {s.recent.map((r) => (
              <div key={r.id} className="row small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="faint" style={{ width: 70, flex: 'none' }}>{timeAgo(r.at)}</span>
                <b style={{ flex: 'none' }}>{r.actor_name}</b>
                {r.via !== 'web' && <span className={`via ${r.via}`}>{r.via}</span>}
                <span className="muted grow">{r.summary}</span>
              </div>
            ))}
            {!s.recent.length && <div className="faint">Nothing yet.</div>}
          </div>
        </div>
      </div>
      {editing && <AreaEditor area={editing} projectKey={project.key} onClose={() => setEditing(null)} />}
    </div>
  );
}
