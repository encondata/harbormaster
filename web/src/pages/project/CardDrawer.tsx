import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, PRIORITIES, type Card, type FieldDef, type Project } from '../../api';
import { Avatar, Confirm, ErrorBox, Spinner, useToast } from '../../components/ui';
import { bytes, dateTime, timeAgo } from '../../lib/format';
import { Markdown } from '../../lib/markdown';
import { canDo } from '../../lib/project';

type CardDetail = Card & {
  comments: { id: string; body: string; created_at: string; author_id: string | null; author_name: string | null; author_kind: string | null }[];
  attachments: { id: string; filename: string; content_type: string; size_bytes: number; created_at: string; uploaded_by_name: string | null }[];
  history: { id: number; at: string; actor_name: string; via: string; action: string; summary: string; changes: Record<string, { from: unknown; to: unknown }> | null }[];
};
type Member = { id: string; name: string; kind: string };

/** Text that becomes an editor on click and saves on blur / Ctrl+Enter. */
function EditableText({ value, onSave, multiline, markdown, placeholder, disabled }: { value: string; onSave: (v: string) => Promise<void>; multiline?: boolean; markdown?: boolean; placeholder: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing || disabled) {
    return (
      <div className={disabled ? '' : 'editable'} onClick={() => !disabled && setEditing(true)}>
        {value ? markdown ? <Markdown text={value} /> : <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span> : <span className="placeholder">{disabled ? '—' : placeholder}</span>}
      </div>
    );
  }
  const save = async () => {
    if (v !== value) await onSave(v);
    setEditing(false);
  };
  return multiline ? (
    <div className="stack-sm">
      <textarea className="input" style={{ minHeight: 160 }} autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setV(value); setEditing(false); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }} />
      <div className="btn-row"><button className="btn primary sm" onClick={save}>Save</button><button className="btn sm" onClick={() => { setV(value); setEditing(false); }}>Cancel</button><span className="faint small">Markdown supported · Ctrl+Enter saves</span></div>
    </div>
  ) : (
    <input className="input sm" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { setV(value); setEditing(false); }
    }} />
  );
}

function FieldInput({ def, value, onSave, disabled }: { def: FieldDef; value: any; onSave: (v: any) => Promise<void>; disabled: boolean }) {
  switch (def.type) {
    case 'bool':
      return <select className="input sm" disabled={disabled} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onSave(e.target.value === '' ? null : e.target.value === 'yes')}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>;
    case 'select':
      return <select className="input sm" disabled={disabled} value={value ?? ''} onChange={(e) => onSave(e.target.value || null)}><option value="">—</option>{(def.options ?? []).map((o) => <option key={o}>{o}</option>)}</select>;
    case 'date':
      return <input type="date" className="input sm" disabled={disabled} value={value ?? ''} onChange={(e) => onSave(e.target.value || null)} />;
    case 'number':
      return <EditableText value={value === null || value === undefined ? '' : String(value)} placeholder="Add a number" disabled={disabled} onSave={async (v) => {
        const n = v.trim() === '' ? null : Number(v);
        if (n !== null && !Number.isFinite(n)) throw new Error('Not a number');
        await onSave(n);
      }} />;
    case 'longtext':
      return <EditableText value={value ?? ''} multiline markdown placeholder={`Add ${def.label.toLowerCase()}`} disabled={disabled} onSave={(v) => onSave(v || null)} />;
    case 'url':
      return disabled || value ? <div className="row">{value ? <a href={value} target="_blank" rel="noreferrer">{value}</a> : '—'}{!disabled && <button className="btn ghost sm" onClick={() => { const v = prompt(def.label, value ?? ''); if (v !== null) onSave(v || null); }}>Edit</button>}</div>
        : <EditableText value="" placeholder="Add a link" onSave={(v) => onSave(v || null)} />;
    default:
      return <EditableText value={value ?? ''} placeholder={`Add ${def.label.toLowerCase()}`} disabled={disabled} onSave={(v) => onSave(v || null)} />;
  }
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return <><div className="lbl">{label}</div><div>{children}</div></>;
}

function fmt(v: unknown) {
  if (v === null || v === undefined || v === '') return '∅';
  if (Array.isArray(v)) return v.join(', ') || '∅';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v);
  return s.length > 140 ? s.slice(0, 137) + '…' : s;
}

export default function CardDrawer({ cardKey, project, onClose }: { cardKey: string; project: Project; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['card', cardKey], queryFn: () => api.get<CardDetail>(`/api/cards/${cardKey}`) });
  const members = useQuery({ queryKey: ['members', project.key], queryFn: () => api.get<Member[]>(`/api/projects/${project.key}/members`) });
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const card = q.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['card', cardKey] });
    qc.invalidateQueries({ queryKey: ['cards', project.key] });
    qc.invalidateQueries({ queryKey: ['project', project.key] });
  };
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      await api.patch(`/api/cards/${cardKey}`, body);
      refresh();
    } catch (e) {
      setErr(e);
      throw e;
    }
  };

  const board = card ? project.boards.find((b) => b.id === card.board_id) : undefined;
  const canEdit = canDo(project, 'card.edit') && !card?.archived_at;
  const canMove = canDo(project, 'card.move') && !card?.archived_at;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Card ${cardKey}`}>
        <div className="drawer-hd">
          <span className="mono faint">{cardKey}</span>
          {board && <span className="faint small">· {board.name}</span>}
          {card?.archived_at && <span className="badge warn">Archived</span>}
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(window.location.href); toast('Link copied'); }}>Copy link</button>
          {card && canDo(project, 'card.archive') && (
            card.archived_at
              ? <button className="btn sm" onClick={async () => { await api.post(`/api/cards/${cardKey}/archive`, { archived: false }); refresh(); toast('Card restored'); }}>Restore</button>
              : <button className="btn sm" onClick={() => setConfirmArchive(true)}>Archive</button>
          )}
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="drawer-bd">
          {q.isLoading ? <Spinner /> : q.error || !card || !board ? <ErrorBox error={q.error ?? 'Card not found'} /> : (
            <>
              {canEdit ? (
                <textarea className="title-edit" rows={Math.min(4, Math.ceil(card.title.length / 52) || 1)} defaultValue={card.title} key={card.title}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== card.title) patch({ title: v }).catch(() => {}); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} />
              ) : <h2 style={{ fontSize: 19 }}>{card.title}</h2>}
              <div className="faint small" style={{ margin: '4px 0 16px' }}>
                Created {timeAgo(card.created_at)}{card.created_by_name ? ` by ${card.created_by_name}` : ''} · updated {timeAgo(card.updated_at)}{card.updated_by_name ? ` by ${card.updated_by_name}` : ''}
              </div>
              <ErrorBox error={err} />
              <div className="props" style={{ marginTop: 8 }}>
                <Prop label="Status">
                  <select className="input sm" disabled={!canMove} value={card.column_id} onChange={async (e) => {
                    try {
                      await api.post(`/api/cards/${cardKey}/move`, { column: e.target.value, index: 'bottom' });
                      refresh();
                    } catch (e2) { setErr(e2); }
                  }}>
                    {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </Prop>
                <Prop label="Area">
                  <select className="input sm" disabled={!canEdit} value={card.area_id ?? ''} onChange={(e) => patch({ area: e.target.value || null }).catch(() => {})}>
                    <option value="">—</option>
                    {project.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Prop>
                <Prop label="Priority">
                  <select className="input sm" disabled={!canEdit} value={card.priority ?? ''} onChange={(e) => patch({ priority: e.target.value || null }).catch(() => {})}>
                    <option value="">—</option>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                  </select>
                </Prop>
                <Prop label="Assignee">
                  <select className="input sm" disabled={!canEdit} value={card.assignee_id ?? ''} onChange={(e) => patch({ assignee_id: e.target.value || null }).catch(() => {})}>
                    <option value="">Unassigned</option>
                    {(members.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.kind === 'service' ? ' (service)' : ''}</option>)}
                  </select>
                </Prop>
                <Prop label="Tags">
                  <EditableText value={card.tags.join(', ')} placeholder="Add tags, comma separated" disabled={!canEdit} onSave={(v) => patch({ tags: v.split(',').map((t) => t.trim()).filter(Boolean) })} />
                </Prop>
                <Prop label="Estimate"><EditableText value={card.estimate} placeholder="e.g. 4 h" disabled={!canEdit} onSave={(v) => patch({ estimate: v })} /></Prop>
                <Prop label="Due date"><input type="date" className="input sm" disabled={!canEdit} value={card.due_date ?? ''} onChange={(e) => patch({ due_date: e.target.value || null }).catch(() => {})} /></Prop>
                {board.field_defs.filter((d) => d.type !== 'longtext').map((d) => (
                  <Prop key={d.key} label={d.label}><FieldInput def={d} value={card.fields[d.key]} disabled={!canEdit} onSave={(v) => patch({ fields: { [d.key]: v } })} /></Prop>
                ))}
              </div>

              <div className="section-title">Description</div>
              <EditableText value={card.description} multiline markdown placeholder="Add a description" disabled={!canEdit} onSave={(v) => patch({ description: v })} />

              {board.field_defs.filter((d) => d.type === 'longtext').map((d) => (
                <div key={d.key}>
                  <div className="section-title">{d.label}</div>
                  <FieldInput def={d} value={card.fields[d.key]} disabled={!canEdit} onSave={(v) => patch({ fields: { [d.key]: v } })} />
                </div>
              ))}

              <div className="section-title">
                Attachments <span className="faint">{card.attachments.length || ''}</span>
                {canDo(project, 'attachment.upload') && !card.archived_at && (
                  <>
                    <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Upload</button>
                    <input ref={fileRef} type="file" hidden onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const fd = new FormData();
                      fd.append('file', file);
                      try {
                        await api.post(`/api/cards/${cardKey}/attachments`, fd);
                        refresh();
                        toast(`Uploaded ${file.name}`);
                      } catch (e2) { setErr(e2); }
                    }} />
                  </>
                )}
              </div>
              {card.attachments.length ? (
                <div className="stack-sm">
                  {card.attachments.map((a) => (
                    <div key={a.id} className="row small">
                      <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">📎 {a.filename}</a>
                      <span className="faint">{bytes(a.size_bytes)} · {a.uploaded_by_name} · {timeAgo(a.created_at)}</span>
                      <span className="grow" />
                      <a className="faint" href={`/api/attachments/${a.id}?download=1`}>Download</a>
                      {(canDo(project, 'attachment.delete')) && <button className="btn ghost sm danger" onClick={async () => { await api.del(`/api/attachments/${a.id}`); refresh(); }}>Remove</button>}
                    </div>
                  ))}
                </div>
              ) : <div className="faint small">None</div>}

              <div className="section-title">
                <div className="seg">
                  <button className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>Comments {card.comments.length || ''}</button>
                  <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History {card.history.length || ''}</button>
                </div>
              </div>
              {tab === 'comments' ? (
                <div className="stack-sm">
                  {card.comments.map((c) => (
                    <div key={c.id} className="comment">
                      <div className="hd">
                        <Avatar name={c.author_name ?? '?'} service={c.author_kind === 'service'} />
                        <b>{c.author_name ?? 'Deleted user'}</b><span className="faint" title={dateTime(c.created_at)}>{timeAgo(c.created_at)}</span>
                        <span className="grow" />
                        <button className="btn ghost sm" onClick={async () => {
                          try { await api.del(`/api/comments/${c.id}`); refresh(); } catch (e2) { setErr(e2); }
                        }}>Delete</button>
                      </div>
                      <Markdown text={c.body} />
                    </div>
                  ))}
                  {canDo(project, 'card.comment') && (
                    <form className="stack-sm" onSubmit={async (e) => {
                      e.preventDefault();
                      if (!comment.trim()) return;
                      try {
                        await api.post(`/api/cards/${cardKey}/comments`, { body: comment });
                        setComment('');
                        refresh();
                      } catch (e2) { setErr(e2); }
                    }}>
                      <textarea className="input" placeholder="Write a comment (markdown)…" value={comment} onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit(); }} />
                      <div><button className="btn primary sm" disabled={!comment.trim()}>Comment</button></div>
                    </form>
                  )}
                </div>
              ) : (
                <div className="timeline">
                  {card.history.map((h) => (
                    <div key={h.id} className="tl-item">
                      <Avatar name={h.actor_name} service={h.via === 'mcp' || h.via === 'api'} />
                      <div>
                        <div className="row small" style={{ flexWrap: 'wrap' }}><b>{h.actor_name}</b>{h.via !== 'web' && <span className={`via ${h.via}`}>{h.via}</span>}<span className="when" title={dateTime(h.at)}>{timeAgo(h.at)}</span></div>
                        <div className="small">{h.summary}</div>
                        {h.changes && !('comment' in h.changes) && (
                          <div className="diff">
                            {Object.entries(h.changes).filter(([, v]) => v && typeof v === 'object' && 'from' in (v as object)).map(([k, v]) => (
                              <div key={k}><span className="faint">{k.replace(/^fields\./, '').replace(/_name$/, '')}:</span> <span className="from">{fmt(v.from)}</span> → {fmt(v.to)}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
      {confirmArchive && card && (
        <Confirm title={`Archive ${card.key}?`} body="It disappears from the board but keeps its history. You can restore it from the Archived view." confirmLabel="Archive"
          onClose={() => setConfirmArchive(false)} onConfirm={async () => { await api.post(`/api/cards/${cardKey}/archive`, { archived: true }); refresh(); onClose(); toast(`${card.key} archived`); }} />
      )}
    </>
  );
}
