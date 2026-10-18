import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Board, type Project, type ProjectListItem } from '../api';
import { ErrorBox, Modal } from '../components/ui';
import { useAuth } from '../lib/auth';
import { colorVar, pct, pctClass } from '../lib/format';
import { useProject } from '../lib/project';

function NewProject({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <Modal title="New project" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={async () => {
          try {
            const p = await api.post<Project>('/api/projects', { key, name, description });
            await qc.invalidateQueries({ queryKey: ['me'] });
            nav(`/p/${p.key}`);
          } catch (e) {
            setErr(e);
          }
        }}>Create project</button>
      </>
    }>
      <div className="form-grid">
        <label className="field">Name<input className="input" value={name} onChange={(e) => {
          setName(e.target.value);
          if (!key || key === suggest(name)) setKey(suggest(e.target.value));
        }} autoFocus /></label>
        <label className="field">Key <span className="hint">2-10 capital letters or digits. Card numbers look like {key || 'KEY'}-12.</span>
          <input className="input mono" value={key} onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))} /></label>
        <label className="field">Description<textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="faint small">The project starts with one Kanban board (Backlog, To Do, In Progress, Review, Done). You become its Owner.</div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

const suggest = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || '';

const EXPANDED_KEY = 'hsl-projects-expanded';
function readExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveExpanded(v: Record<string, boolean>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Parity over a board's columns, as on the Summary page: weighted columns only. */
function boardParity(b: Board) {
  let num = 0;
  let den = 0;
  for (const c of b.columns) {
    if (c.parity_weight === null) continue;
    num += c.parity_weight * c.card_count;
    den += c.card_count;
  }
  return den ? num / den : null;
}

function ProjectDetails({ project }: { project: ProjectListItem }) {
  const q = useProject(project.key);
  if (q.isLoading) return <div className="faint small">Loading…</div>;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? 'Could not load project'} />;
  const boards = q.data.boards.filter((b) => !b.archived_at);
  return (
    <div className="stack-sm">
      {project.description && <div className="muted">{project.description}</div>}
      {boards.map((b) => {
        const total = b.card_count || 1;
        const parity = b.parity_enabled ? boardParity(b) : null;
        return (
          <div key={b.id} className="pboard">
            <div className="row">
              <Link to={`/p/${project.key}/b/${b.key}`} style={{ fontWeight: 600 }}>{b.name}</Link>
              <span className="faint small">{b.card_count} cards</span>
              <span className="grow" />
              {parity !== null && <span className={`pct small ${pctClass(parity)}`}>{pct(parity)} parity</span>}
            </div>
            <div className="bar">
              {b.columns.map((c) => (c.card_count ? <span key={c.id} title={`${c.name}: ${c.card_count}`} style={{ width: `${(c.card_count / total) * 100}%`, background: colorVar(c.color) }} /> : null))}
            </div>
            <div className="row small faint" style={{ flexWrap: 'wrap', gap: '2px 12px' }}>
              {b.columns.filter((c) => c.card_count).map((c) => (
                <span key={c.id} className="row" style={{ gap: 4 }}><span className="dot" style={{ background: colorVar(c.color) }} />{c.name} {c.card_count}</span>
              ))}
            </div>
          </div>
        );
      })}
      {!boards.length && <div className="faint small">No boards yet.</div>}
    </div>
  );
}

function ProjectCard({ project, expanded, onToggle }: { project: ProjectListItem; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="card-box pcard" style={{ opacity: project.archived_at ? 0.65 : 1 }}>
      <div className="pcard-hd">
        <button className="pcard-toggle" aria-expanded={expanded} aria-controls={`proj-${project.id}`} onClick={onToggle}>
          <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="pcard-name">{project.name}</span>
          <span className="mono faint">{project.key}</span>
          <span className="faint small">{project.card_count} cards · {project.member_count} members</span>
        </button>
        {project.archived_at ? <span className="badge">Archived</span> : project.my_role && <span className="badge accent">{project.my_role}</span>}
        <Link className="btn sm" to={`/p/${project.key}`}>Open</Link>
      </div>
      {expanded && <div className="pcard-bd" id={`proj-${project.id}`}><ProjectDetails project={project} /></div>}
    </div>
  );
}

export default function Projects() {
  const { me, can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(readExpanded);
  if (!me) return null;
  // Projects start expanded until you collapse them.
  const isOpen = (key: string) => expanded[key] ?? true;
  const set = (next: Record<string, boolean>) => {
    setExpanded(next);
    saveExpanded(next);
  };
  const all = (open: boolean) => set(Object.fromEntries(me.projects.map((p) => [p.key, open])));
  return (
    <>
      <div className="topbar">
        <h1 className="grow">Projects</h1>
        {me.projects.length > 1 && (
          <div className="btn-row">
            <button className="btn ghost sm" onClick={() => all(true)}>Expand all</button>
            <button className="btn ghost sm" onClick={() => all(false)}>Collapse all</button>
          </div>
        )}
        {can('projects.create') && <button className="btn primary" onClick={() => setCreating(true)}>New project</button>}
      </div>
      <div className="page page-narrow">
        <div className="stack-sm">
          {me.projects.map((p) => (
            <ProjectCard key={p.id} project={p} expanded={isOpen(p.key)} onToggle={() => set({ ...expanded, [p.key]: !isOpen(p.key) })} />
          ))}
        </div>
        {!me.projects.length && <div className="empty">You are not a member of any project yet. Ask an administrator to add you.</div>}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </>
  );
}
