import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Role } from '../../api';
import { Confirm, ErrorBox, Modal, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';

type Catalog = { global: Record<string, string>; project: Record<string, string> };

function RoleEditor({ role, scope, catalog, onClose }: { role: Role | null; scope: 'global' | 'project'; catalog: Catalog; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [err, setErr] = useState<unknown>(null);
  const locked = role?.is_builtin && role.scope === 'global' && role.name === 'Administrator';
  const list = catalog[scope];
  return (
    <Modal wide title={role ? `Role: ${role.name}` : `New ${scope} role`} onClose={onClose} footer={
      <><button className="btn" onClick={onClose}>Cancel</button>
        {!locked && <button className="btn primary" onClick={async () => {
          try {
            const body = { name, description, permissions: [...perms] };
            if (role) await api.patch(`/api/admin/roles/${role.id}`, body);
            else await api.post('/api/admin/roles', { ...body, scope });
            qc.invalidateQueries({ queryKey: ['roles'] });
            onClose();
          } catch (e) { setErr(e); }
        }}>Save role</button>}</>
    }>
      <div className="form-grid">
        {locked && <div className="warn-box">The Administrator role always has every global permission and cannot be edited.</div>}
        <div className="form-grid two">
          <label className="field">Name<input className="input" value={name} disabled={role?.is_builtin} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">Description<input className="input" value={description} disabled={locked} onChange={(e) => setDescription(e.target.value)} /></label>
        </div>
        <div className="field">Permissions
          <div className="perm-grid">
            {Object.entries(list).map(([k, d]) => (
              <label key={k} className="check"><input type="checkbox" disabled={locked} checked={perms.has(k)} onChange={(e) => setPerms((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                <span><span className="mono">{k}</span><small>{d}</small></span></label>
            ))}
          </div>
        </div>
        {role && role.assignments > 0 && !locked && <div className="faint small">This role is assigned {role.assignments} time(s). Changes apply immediately to everyone who has it.</div>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

export default function RolesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/api/roles') });
  const catalog = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Catalog>('/api/permissions') });
  const [edit, setEdit] = useState<{ role: Role | null; scope: 'global' | 'project' } | null>(null);
  const [del, setDel] = useState<Role | null>(null);
  if (!can('admin.roles')) return <div className="page"><ErrorBox error="You do not have access to role administration." /></div>;
  if (roles.isLoading || catalog.isLoading) return <Spinner />;
  const section = (scope: 'global' | 'project', title: string, blurb: string) => {
    const list = (roles.data ?? []).filter((r) => r.scope === scope);
    const perms = Object.keys(catalog.data![scope]);
    return (
      <div className="card-box">
        <div className="hd"><div className="grow"><h2>{title}</h2><div className="faint small">{blurb}</div></div><button className="btn sm" onClick={() => setEdit({ role: null, scope })}>New role</button></div>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="t">
            <thead><tr><th>Permission</th>{list.map((r) => <th key={r.id} className="num" style={{ whiteSpace: 'nowrap' }}><a href="#" onClick={(e) => { e.preventDefault(); setEdit({ role: r, scope }); }}>{r.name}</a>{!r.is_builtin && <button className="btn ghost sm" title="Delete role" onClick={() => setDel(r)}>✕</button>}<div className="faint small" style={{ fontWeight: 400 }}>{r.assignments} assigned</div></th>)}</tr></thead>
            <tbody>
              {perms.map((p) => (
                <tr key={p}>
                  <td><div className="mono">{p}</div><div className="faint small">{catalog.data![scope][p]}</div></td>
                  {list.map((r) => <td key={r.id} className="num">{r.permissions.includes(p) ? <span style={{ color: 'var(--ok)', fontWeight: 700 }}>✓</span> : <span className="faint">·</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="topbar"><h1>Roles &amp; permissions</h1></div>
      <div className="page">
        <div className="stack">
          {section('global', 'Global roles', 'Apply everywhere. Assign them on a user’s page.')}
          {section('project', 'Project roles', 'Granted per project when adding a member. Owners manage members and settings.')}
        </div>
      </div>
      {edit && catalog.data && <RoleEditor role={edit.role} scope={edit.scope} catalog={catalog.data} onClose={() => setEdit(null)} />}
      {del && <Confirm title={`Delete role "${del.name}"?`} danger confirmLabel="Delete" body="Only roles that are not assigned to anyone can be deleted." onClose={() => setDel(null)}
        onConfirm={async () => { await api.del(`/api/admin/roles/${del.id}`); qc.invalidateQueries({ queryKey: ['roles'] }); }} />}
    </>
  );
}
