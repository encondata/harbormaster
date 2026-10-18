import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project } from '../api';
import { ErrorBox, Modal } from '../components/ui';
import { useAuth } from '../lib/auth';

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

export default function Projects() {
  const { me, can } = useAuth();
  const [creating, setCreating] = useState(false);
  if (!me) return null;
  return (
    <>
      <div className="topbar"><h1 className="grow">Projects</h1>{can('projects.create') && <button className="btn primary" onClick={() => setCreating(true)}>New project</button>}</div>
      <div className="page page-narrow">
        <div className="stat-row">
          {me.projects.map((p) => (
            <Link key={p.id} to={`/p/${p.key}`} className="stat" style={{ color: 'inherit', textDecoration: 'none', opacity: p.archived_at ? 0.6 : 1 }}>
              <div className="row"><h2 className="grow">{p.name}</h2><span className="mono faint">{p.key}</span></div>
              <div className="muted small" style={{ margin: '6px 0 10px', minHeight: 36 }}>{p.description || 'No description'}</div>
              <div className="row small faint">
                <span>{p.card_count} cards</span>·<span>{p.member_count} members</span>
                <span className="grow" />{p.archived_at ? <span className="badge">Archived</span> : p.my_role && <span className="badge accent">{p.my_role}</span>}
              </div>
            </Link>
          ))}
        </div>
        {!me.projects.length && <div className="empty">You are not a member of any project yet. Ask an administrator to add you.</div>}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </>
  );
}
