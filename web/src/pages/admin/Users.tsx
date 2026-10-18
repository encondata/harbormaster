import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type AdminUser, type ProjectListItem, type Role } from '../../api';
import { Avatar, ErrorBox, Modal, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { timeAgo } from '../../lib/format';

function NewUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/api/roles') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectListItem[]>('/api/projects') });
  const [kind, setKind] = useState<'human' | 'service'>('human');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [globalRoles, setGlobalRoles] = useState<string[]>([]);
  const [projectRoles, setProjectRoles] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [temp, setTemp] = useState<{ id: string; password: string } | null>(null);
  const pRoles = (roles.data ?? []).filter((r) => r.scope === 'project');
  return (
    <Modal wide title={temp ? 'User created' : 'New user'} onClose={onClose} footer={temp ? <button className="btn primary" onClick={() => nav(`/admin/users/${temp.id}`)}>Open user</button> : (
      <><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={async () => {
          try {
            const u = await api.post<AdminUser & { temporary_password?: string }>('/api/admin/users', {
              kind, email, name, password: kind === 'human' && password ? password : undefined, must_change_password: mustChange, global_role_ids: globalRoles,
              projects: Object.entries(projectRoles).filter(([, r]) => r).map(([project_id, role_id]) => ({ project_id, role_id })),
            });
            qc.invalidateQueries({ queryKey: ['admin-users'] });
            if (u.temporary_password) setTemp({ id: u.id, password: u.temporary_password });
            else nav(`/admin/users/${u.id}`);
          } catch (e) { setErr(e); }
        }}>Create user</button></>
    )}>
      {temp ? (
        <div className="stack-sm">
          <div className="warn-box">Give this temporary password to {name}. It is shown only once; they will choose their own at first sign-in.</div>
          <div className="secret">{temp.password}</div>
        </div>
      ) : (
        <div className="form-grid">
          <div className="seg" style={{ justifySelf: 'start' }}>
            <button className={kind === 'human' ? 'on' : ''} onClick={() => setKind('human')}>Person</button>
            <button className={kind === 'service' ? 'on' : ''} onClick={() => setKind('service')}>Service account</button>
          </div>
          {kind === 'service' && <div className="faint small">Service accounts (like the Claude account) cannot sign in with a password. Give them an API token instead.</div>}
          <div className="form-grid two">
            <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
            <label className="field">Email<input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          </div>
          {kind === 'human' && (
            <div className="form-grid two">
              <label className="field">Initial password <span className="hint">Blank generates one</span><input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <label className="check" style={{ alignSelf: 'end', paddingBottom: 6 }}><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} /> Must change at first sign-in</label>
            </div>
          )}
          <div className="field">Global roles
            <div className="btn-row">{(roles.data ?? []).filter((r) => r.scope === 'global').map((r) => (
              <label key={r.id} className="check" title={r.description}><input type="checkbox" checked={globalRoles.includes(r.id)} onChange={(e) => setGlobalRoles((g) => (e.target.checked ? [...g, r.id] : g.filter((x) => x !== r.id)))} /> {r.name}</label>
            ))}</div>
          </div>
          <div className="field">Project access
            <div className="stack-sm">{(projects.data ?? []).map((p) => (
              <div key={p.id} className="row"><span className="grow">{p.name} <span className="mono faint">{p.key}</span></span>
                <select className="input sm" style={{ width: 180 }} value={projectRoles[p.id] ?? ''} onChange={(e) => setProjectRoles((s) => ({ ...s, [p.id]: e.target.value }))}>
                  <option value="">No access</option>{pRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select></div>
            ))}</div>
          </div>
          <ErrorBox error={err} />
        </div>
      )}
    </Modal>
  );
}

export default function UsersPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<AdminUser[]>('/api/admin/users'), enabled: can('admin.users') });
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  if (!can('admin.users')) return <div className="page"><ErrorBox error="You do not have access to user administration." /></div>;
  const users = (q.data ?? []).filter((u) => (showInactive || u.is_active) && (!filter || `${u.name} ${u.email}`.toLowerCase().includes(filter.toLowerCase())));
  return (
    <>
      <div className="topbar"><h1 className="grow">Users</h1><button className="btn primary" onClick={() => setCreating(true)}>New user</button></div>
      <div className="page">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input className="input sm" style={{ width: 240 }} placeholder="Filter by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show deactivated</label>
        </div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Name</th><th>Global roles</th><th>Projects</th><th>Last sign-in</th><th className="num">Tokens</th><th>Status</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><Link to={`/admin/users/${u.id}`} className="row" style={{ color: 'inherit' }}><Avatar name={u.name} service={u.kind === 'service'} /><div><div style={{ fontWeight: 600 }}>{u.name}</div><div className="faint small">{u.email}</div></div></Link></td>
                    <td>{u.global_roles.map((r) => <span key={r.id} className="badge accent" style={{ marginRight: 4 }}>{r.name}</span>)}</td>
                    <td className="small">{u.projects.map((p) => `${p.project_key} · ${p.role_name}`).join(', ') || <span className="faint">—</span>}</td>
                    <td className="small faint">{u.kind === 'service' ? 'token only' : timeAgo(u.last_login_at)}</td>
                    <td className="num">{u.active_tokens || ''}</td>
                    <td>{u.is_active ? (u.must_change_password ? <span className="badge warn">Password reset pending</span> : <span className="badge ok">Active</span>) : <span className="badge">Deactivated</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewUser onClose={() => setCreating(false)} />}
    </>
  );
}
