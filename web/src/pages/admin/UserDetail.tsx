import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type AdminUser, type ProjectListItem, type Role } from '../../api';
import AuditList from '../../components/AuditList';
import Tokens from '../../components/Tokens';
import { Avatar, Confirm, ErrorBox, Modal, Spinner, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dateTime, timeAgo } from '../../lib/format';

type Detail = AdminUser & { sessions: { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null }[] };

export default function UserDetail() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin-user', id], queryFn: () => api.get<Detail>(`/api/admin/users/${id}`) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/api/roles') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<ProjectListItem[]>('/api/projects') });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [reset, setReset] = useState<string | null | 'ask'>(null);
  const [confirm, setConfirm] = useState<'deactivate' | 'sessions' | null>(null);
  const u = q.data;
  useEffect(() => { if (u) { setName(u.name); setEmail(u.email); } }, [u?.id, u?.name, u?.email]);
  if (!can('admin.users')) return <div className="page"><ErrorBox error="You do not have access to user administration." /></div>;
  if (q.isLoading) return <Spinner />;
  if (!u) return <div className="page"><ErrorBox error={q.error ?? 'User not found'} /></div>;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-user', id] }); qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['me'] }); };
  const patch = async (body: object) => { setErr(null); try { await api.patch(`/api/admin/users/${id}`, body); refresh(); toast('Saved'); } catch (e) { setErr(e); } };
  const globalRoles = (roles.data ?? []).filter((r) => r.scope === 'global');
  const projectRoles = (roles.data ?? []).filter((r) => r.scope === 'project');
  const mine = new Set(u.global_roles.map((r) => r.id));
  return (
    <>
      <div className="topbar">
        <Avatar name={u.name} service={u.kind === 'service'} />
        <h1>{u.name}</h1>
        {u.kind === 'service' && <span className="badge warn">Service account</span>}
        {!u.is_active && <span className="badge">Deactivated</span>}
        <span className="grow" />
        {u.kind === 'human' && <button className="btn" onClick={() => setReset('ask')}>Reset password</button>}
        <button className="btn" onClick={() => setConfirm('sessions')}>Sign out everywhere</button>
        {u.id !== me?.id && (u.is_active ? <button className="btn danger" onClick={() => setConfirm('deactivate')}>Deactivate</button> : <button className="btn" onClick={() => patch({ is_active: true })}>Reactivate</button>)}
      </div>
      <div className="page page-narrow">
        <div className="stack">
          <ErrorBox error={err} />
          <div className="card-box">
            <div className="hd"><h2>Details</h2></div>
            <div className="bd form-grid">
              <div className="form-grid two">
                <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field">Email<input className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              </div>
              <div className="faint small">Created {dateTime(u.created_at)} · last sign-in {u.kind === 'service' ? 'n/a (token only)' : timeAgo(u.last_login_at)}{u.must_change_password ? ' · must change password at next sign-in' : ''}</div>
              <div><button className="btn primary" disabled={name === u.name && email === u.email} onClick={() => patch({ name, email })}>Save</button></div>
            </div>
          </div>
          <div className="card-box">
            <div className="hd"><h2>Global roles</h2></div>
            <div className="bd stack-sm">
              {globalRoles.map((r) => (
                <label key={r.id} className="check" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={mine.has(r.id)} onChange={(e) => patch({ global_role_ids: e.target.checked ? [...mine, r.id] : [...mine].filter((x) => x !== r.id) })} />
                  <span><b>{r.name}</b> <span className="faint">— {r.description}</span></span>
                </label>
              ))}
            </div>
          </div>
          <div className="card-box">
            <div className="hd"><h2>Project access</h2></div>
            <div className="bd stack-sm">
              {(projects.data ?? []).map((p) => {
                const m = u.projects.find((x) => x.project_id === p.id);
                return (
                  <div key={p.id} className="row">
                    <span className="grow">{p.name} <span className="mono faint">{p.key}</span></span>
                    <select className="input sm" style={{ width: 180 }} value={m?.role_id ?? ''} onChange={async (e) => {
                      try { await api.put(`/api/admin/users/${id}/projects/${p.id}`, { role_id: e.target.value || null }); refresh(); toast('Access updated'); } catch (e2) { setErr(e2); }
                    }}>
                      <option value="">No access</option>{projectRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
          {(can('admin.tokens') || u.id === me?.id) && <Tokens base={`/api/admin/users/${id}/tokens`} showSetup={u.kind === 'service'} />}
          {u.kind === 'human' && (
            <div className="card-box">
              <div className="hd"><h2>Active sessions</h2></div>
              <div className="bd stack-sm">
                {u.sessions.map((s) => <div key={s.id} className="small"><b>{s.ip ?? 'unknown IP'}</b> <span className="faint">· signed in {dateTime(s.created_at)} · last seen {timeAgo(s.last_seen_at)}</span><div className="faint">{s.user_agent}</div></div>)}
                {!u.sessions.length && <div className="faint small">None</div>}
              </div>
            </div>
          )}
          {can('admin.audit') && (
            <div className="card-box">
              <div className="hd"><h2>Recent actions by {u.name}</h2></div>
              <div className="bd"><AuditList endpoint={`/api/admin/audit?actor_id=${id}`} showProject /></div>
            </div>
          )}
        </div>
      </div>
      {reset === 'ask' && <Confirm title={`Reset ${u.name}'s password?`} confirmLabel="Reset password" body="A temporary password is generated and they are signed out everywhere. They must choose a new one at next sign-in."
        onClose={() => setReset((r) => (r === 'ask' ? null : r))} onConfirm={async () => { const r = await api.post<{ temporary_password: string }>(`/api/admin/users/${id}/reset-password`, { must_change_password: true }); setReset(r.temporary_password); refresh(); }} />}
      {reset && reset !== 'ask' && (
        <Modal title="Temporary password" onClose={() => setReset(null)} footer={<button className="btn primary" onClick={() => setReset(null)}>Done</button>}>
          <div className="stack-sm"><div className="warn-box">Give this to {u.name}. It is shown only once.</div><div className="secret">{reset}</div></div>
        </Modal>
      )}
      {confirm === 'deactivate' && <Confirm title={`Deactivate ${u.name}?`} danger confirmLabel="Deactivate" body="They are signed out and cannot sign in or use API tokens until reactivated. Their history stays." onClose={() => setConfirm(null)} onConfirm={() => patch({ is_active: false })} />}
      {confirm === 'sessions' && <Confirm title="Sign out everywhere?" confirmLabel="Sign out" body={`Ends all of ${u.name}'s browser sessions. API tokens keep working; revoke them separately.`} onClose={() => setConfirm(null)} onConfirm={async () => { await api.post(`/api/admin/users/${id}/revoke-sessions`); refresh(); }} />}
    </>
  );
}
