import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, PRIORITIES, qs, type FeatureRequest, type Project, type RequestStatus } from '../../api';
import { Avatar, ErrorBox, Modal, Spinner, useToast } from '../../components/ui';
import { dateTime, timeAgo } from '../../lib/format';
import { Markdown } from '../../lib/markdown';
import { canDo } from '../../lib/project';
import { useProjectCtx } from './ProjectLayout';

const STATUS_LABEL: Record<RequestStatus, string> = { new: 'New', reviewing: 'Under review', accepted: 'Accepted', declined: 'Declined', duplicate: 'Duplicate' };
const STATUS_CLASS: Record<RequestStatus, string> = { new: 'accent', reviewing: 'warn', accepted: 'ok', declined: '', duplicate: '' };

export function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

type RequestDetail = FeatureRequest & {
  can_edit: boolean;
  comments: { id: string; body: string; created_at: string; author_name: string | null; author_kind: string | null }[];
  history: { id: number; at: string; actor_name: string; via: string; summary: string }[];
};

function useRefresh(projectKey: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['requests', projectKey] });
    qc.invalidateQueries({ queryKey: ['request'] });
    qc.invalidateQueries({ queryKey: ['project', projectKey] });
  };
}

function RequestForm({ project, initial, onClose, onSaved }: { project: Project; initial?: FeatureRequest; onClose: () => void; onSaved: (r: FeatureRequest) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [area, setArea] = useState(initial?.area_id ?? '');
  const [requestedFor, setRequestedFor] = useState(initial?.requested_for ?? '');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { title, description, area: area || null, requested_for: requestedFor };
      const r = initial
        ? await api.patch<FeatureRequest>(`/api/requests/${initial.key}`, body)
        : await api.post<FeatureRequest>(`/api/projects/${project.key}/requests`, body);
      onSaved(r);
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };
  return (
    <Modal wide title={initial ? `Edit ${initial.key}` : 'New feature request'} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !title.trim()} onClick={save}>{initial ? 'Save' : 'Submit request'}</button>
      </>
    }>
      <div className="form-grid">
        <label className="field">What should it do?<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Export the rack diagram to PDF" autoFocus /></label>
        <label className="field">Details <span className="hint">Why it's needed, who it helps, any examples. Markdown works.</span>
          <textarea className="input" style={{ minHeight: 160 }} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="form-grid two">
          <label className="field">Area
            <select className="input" value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">—</option>
              {project.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field">Requested for <span className="hint">If someone else asked, e.g. "Mark (CSG)"</span>
            <input className="input" value={requestedFor} onChange={(e) => setRequestedFor(e.target.value)} /></label>
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function AcceptModal({ project, request, onClose, onDone }: { project: Project; request: FeatureRequest; onClose: () => void; onDone: () => void }) {
  const boards = project.boards.filter((b) => !b.archived_at);
  const [boardId, setBoardId] = useState(boards[0]?.id ?? '');
  const board = boards.find((b) => b.id === boardId);
  const [columnId, setColumnId] = useState(board?.columns[0]?.id ?? '');
  const [priority, setPriority] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setColumnId(board?.columns[0]?.id ?? ''), [boardId]);
  return (
    <Modal title={`Accept ${request.key}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!boardId} onClick={async () => {
          try {
            await api.post(`/api/requests/${request.key}/triage`, { action: 'accept', board: boardId, column: columnId || undefined, priority: priority || null, note: note || undefined });
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}>Accept and create card</button>
      </>
    }>
      <div className="form-grid">
        <div className="muted small">A card with this title and description is created on the board you choose. The request stays linked to it.</div>
        <div className="form-grid two">
          <label className="field">Board
            <select className="input" value={boardId} onChange={(e) => setBoardId(e.target.value)}>{boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </label>
          <label className="field">Column
            <select className="input" value={columnId} onChange={(e) => setColumnId(e.target.value)}>{board?.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        </div>
        <label className="field">Priority
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
          </select>
        </label>
        <label className="field">Note to the requester <span className="hint">Optional</span><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function CloseModal({ request, mode, open, onClose, onDone }: { request: FeatureRequest; mode: 'decline' | 'duplicate'; open: FeatureRequest[]; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [of, setOf] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const others = open.filter((r) => r.id !== request.id);
  return (
    <Modal title={mode === 'decline' ? `Decline ${request.key}` : `Mark ${request.key} as a duplicate`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${mode === 'decline' ? 'danger' : 'primary'}`} disabled={mode === 'decline' ? !note.trim() : !of} onClick={async () => {
          try {
            await api.post(`/api/requests/${request.key}/triage`, mode === 'decline' ? { action: 'decline', note } : { action: 'duplicate', of, note: note || undefined });
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}>{mode === 'decline' ? 'Decline request' : 'Mark as duplicate'}</button>
      </>
    }>
      <div className="form-grid">
        {mode === 'duplicate' && (
          <label className="field">Duplicate of
            <select className="input" value={of} onChange={(e) => setOf(e.target.value)}>
              <option value="">Choose a request…</option>
              {others.map((r) => <option key={r.id} value={r.key}>{r.key} · {r.title}</option>)}
            </select>
            <span className="hint">Votes move to that request.</span>
          </label>
        )}
        <label className="field">{mode === 'decline' ? 'Why is it declined?' : 'Note'} {mode === 'decline' && <span className="hint">The requester sees this</span>}
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus={mode === 'decline'} /></label>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function RequestDrawer({ project, requestKey, openList, onClose }: { project: Project; requestKey: string; openList: FeatureRequest[]; onClose: () => void }) {
  const q = useQuery({ queryKey: ['request', requestKey], queryFn: () => api.get<RequestDetail>(`/api/requests/${requestKey}`) });
  const refresh = useRefresh(project.key);
  const toast = useToast();
  const [modal, setModal] = useState<'edit' | 'accept' | 'decline' | 'duplicate' | null>(null);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !modal && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, modal]);
  const r = q.data;
  const triager = canDo(project, 'request.triage');
  const act = async (body: object, msg: string) => {
    setErr(null);
    try {
      await api.post(`/api/requests/${requestKey}/triage`, body);
      refresh();
      toast(msg);
    } catch (e) {
      setErr(e);
    }
  };
  const done = (msg: string) => () => {
    setModal(null);
    refresh();
    toast(msg);
  };
  const open = r && (r.status === 'new' || r.status === 'reviewing');
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Request ${requestKey}`}>
        <div className="drawer-hd">
          <span className="mono faint">{requestKey}</span>
          {r && <StatusPill status={r.status} />}
          <span className="grow" />
          {r?.can_edit && <button className="btn sm" onClick={() => setModal('edit')}>Edit</button>}
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-bd">
          {q.isLoading ? <Spinner /> : !r ? <ErrorBox error={q.error ?? 'Request not found'} /> : (
            <div className="stack">
              <div className="stack-sm">
                <h2 style={{ fontSize: 19 }}>{r.title}</h2>
                <div className="faint small">
                  Submitted by {r.requested_by_name ?? 'a deleted user'}{r.requested_for ? ` for ${r.requested_for}` : ''} · {timeAgo(r.created_at)}{r.area_name ? ` · ${r.area_name}` : ''}
                </div>
              </div>
              <div className="row">
                <VoteButton request={r} projectKey={project.key} disabled={!canDo(project, 'request.create')} />
                <span className="muted small">{r.votes === 1 ? '1 vote' : `${r.votes} votes`}{r.voted ? ' · including yours' : ''}</span>
              </div>

              {r.status === 'accepted' && r.card_key && (
                <div className="ok-box">Accepted{r.decided_by_name ? ` by ${r.decided_by_name}` : ''} as card <Link to={`/p/${project.key}/b/${r.card_board_key}?card=${r.card_key}`}><b>{r.card_key}</b></Link>{r.card_column ? ` (now in ${r.card_column})` : ''}.{r.decision_note && <div style={{ marginTop: 4 }}>{r.decision_note}</div>}</div>
              )}
              {r.status === 'declined' && <div className="warn-box">Declined{r.decided_by_name ? ` by ${r.decided_by_name}` : ''}: {r.decision_note}</div>}
              {r.status === 'duplicate' && <div className="warn-box">Duplicate of <a href={`?request=${r.duplicate_key}`}><b>{r.duplicate_key}</b></a> {r.duplicate_title}.{r.decision_note ? ` ${r.decision_note}` : ''}</div>}

              {triager && (
                <div className="btn-row">
                  {r.status === 'new' && <button className="btn" onClick={() => act({ action: 'review' }, `${r.key} is under review`)}>Start review</button>}
                  {open && <button className="btn primary" onClick={() => setModal('accept')}>Accept…</button>}
                  {open && <button className="btn" onClick={() => setModal('duplicate')}>Duplicate…</button>}
                  {open && <button className="btn danger" onClick={() => setModal('decline')}>Decline…</button>}
                  {(r.status === 'declined' || r.status === 'duplicate') && <button className="btn" onClick={() => act({ action: 'reopen' }, `${r.key} reopened`)}>Reopen</button>}
                </div>
              )}
              <ErrorBox error={err} />

              <div>
                <div className="section-title">Details</div>
                {r.description ? <Markdown text={r.description} /> : <span className="placeholder">No details given.</span>}
              </div>

              <div>
                <div className="section-title">Comments {r.comments.length || ''}</div>
                <div className="stack-sm">
                  {r.comments.map((c) => (
                    <div key={c.id} className="comment">
                      <div className="hd"><Avatar name={c.author_name ?? '?'} service={c.author_kind === 'service'} /><b>{c.author_name ?? 'Deleted user'}</b><span className="faint" title={dateTime(c.created_at)}>{timeAgo(c.created_at)}</span></div>
                      <Markdown text={c.body} />
                    </div>
                  ))}
                  {canDo(project, 'request.create') && (
                    <form className="stack-sm" onSubmit={async (e) => {
                      e.preventDefault();
                      if (!comment.trim()) return;
                      try {
                        await api.post(`/api/requests/${r.key}/comments`, { body: comment });
                        setComment('');
                        refresh();
                      } catch (e2) {
                        setErr(e2);
                      }
                    }}>
                      <textarea className="input" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
                      <div><button className="btn primary sm" disabled={!comment.trim()}>Comment</button></div>
                    </form>
                  )}
                </div>
              </div>

              <div>
                <div className="section-title">History</div>
                <div className="stack-sm small">
                  {r.history.map((h) => (
                    <div key={h.id} className="row" style={{ alignItems: 'baseline' }}>
                      <span className="faint" style={{ width: 70, flex: 'none' }} title={dateTime(h.at)}>{timeAgo(h.at)}</span>
                      <span><b>{h.actor_name}</b>{h.via !== 'web' && <span className={`via ${h.via}`} style={{ marginLeft: 6 }}>{h.via}</span>} <span className="muted">{h.summary}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>
      {r && modal === 'edit' && <RequestForm project={project} initial={r} onClose={() => setModal(null)} onSaved={() => done('Request saved')()} />}
      {r && modal === 'accept' && <AcceptModal project={project} request={r} onClose={() => setModal(null)} onDone={done(`${r.key} accepted and added to the board`)} />}
      {r && (modal === 'decline' || modal === 'duplicate') && <CloseModal request={r} mode={modal} open={openList} onClose={() => setModal(null)} onDone={done(modal === 'decline' ? `${r.key} declined` : `${r.key} closed as a duplicate`)} />}
    </>
  );
}

function VoteButton({ request, projectKey, disabled }: { request: FeatureRequest; projectKey: string; disabled: boolean }) {
  const refresh = useRefresh(projectKey);
  const toast = useToast();
  return (
    <button className={`vote ${request.voted ? 'on' : ''}`} disabled={disabled} aria-pressed={!!request.voted}
      title={request.voted ? 'Remove your vote' : 'Vote for this request'}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await api.post(`/api/requests/${request.key}/vote`, { vote: !request.voted });
          refresh();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Vote failed', 'error');
        }
      }}>
      <span aria-hidden="true">▲</span>
      <b>{request.votes}</b>
    </button>
  );
}

export default function Requests() {
  const { project } = useProjectCtx();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? 'open';
  const sort = sp.get('sort') ?? 'votes';
  const [query, setQuery] = useState(sp.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const refresh = useRefresh(project.key);
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const list = useQuery({
    queryKey: ['requests', project.key, status, sort, sp.get('q') ?? ''],
    queryFn: () => api.get<FeatureRequest[]>(`/api/projects/${project.key}/requests${qs({ status, sort, q: sp.get('q') })}`),
  });
  const openList = useQuery({ queryKey: ['requests', project.key, 'open', 'votes', ''], queryFn: () => api.get<FeatureRequest[]>(`/api/projects/${project.key}/requests?status=open`) });
  const openKey = sp.get('request');
  const rows = list.data ?? [];
  return (
    <div className="board-page">
      <div className="toolbar">
        <div className="seg">
          {[['open', 'Open'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['all', 'All']].map(([v, l]) => (
            <button key={v} className={status === v ? 'on' : ''} onClick={() => set('status', v === 'open' ? null : v)}>{l}</button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); set('q', query.trim() || null); }}>
          <input className="input sm search" placeholder="Search requests…" value={query} onChange={(e) => setQuery(e.target.value)} onBlur={() => set('q', query.trim() || null)} />
        </form>
        <select className="input sm" value={sort} onChange={(e) => set('sort', e.target.value === 'votes' ? null : e.target.value)} aria-label="Sort">
          <option value="votes">Most votes</option>
          <option value="new">Newest</option>
          <option value="updated">Recently updated</option>
        </select>
        <span className="grow" />
        {canDo(project, 'request.create') && <button className="btn primary" onClick={() => setCreating(true)}>New request</button>}
      </div>
      <div className="page" style={{ paddingTop: 16 }}>
        <div className="page-narrow">
          {list.isLoading ? <Spinner /> : list.error ? <ErrorBox error={list.error} /> : rows.length ? (
            <div className="card-box">
              {rows.map((r) => (
                <div key={r.id} className="req-row" onClick={() => set('request', r.key)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') set('request', r.key); }}>
                  <VoteButton request={r} projectKey={project.key} disabled={!canDo(project, 'request.create')} />
                  <div className="req-main">
                    <div className="req-title">{r.title}</div>
                    <div className="req-meta">
                      <span className="mono">{r.key}</span>
                      <StatusPill status={r.status} />
                      {r.area_name && <span>{r.area_name}</span>}
                      <span>by {r.requested_by_name ?? 'deleted user'}{r.requested_for ? ` for ${r.requested_for}` : ''}</span>
                      {r.comment_count > 0 && <span>💬 {r.comment_count}</span>}
                      <span>{timeAgo(r.created_at)}</span>
                    </div>
                  </div>
                  {r.card_key && <span className="mono small faint">→ {r.card_key}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">
              {status === 'open' ? 'No open feature requests.' : 'Nothing here.'}
              {canDo(project, 'request.create') && status === 'open' && <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => setCreating(true)}>Submit the first one</button></div>}
            </div>
          )}
        </div>
      </div>
      {openKey && <RequestDrawer project={project} requestKey={openKey} openList={openList.data ?? []} onClose={() => set('request', null)} />}
      {creating && <RequestForm project={project} onClose={() => setCreating(false)} onSaved={(r) => { setCreating(false); refresh(); toast(`Submitted ${r.key}`); set('request', r.key); }} />}
    </div>
  );
}
