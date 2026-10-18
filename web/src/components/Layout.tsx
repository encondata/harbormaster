import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../lib/auth';
import { Avatar } from './ui';

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'auto');
  const next = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto';
  return (
    <button className="btn ghost sm icon" title={`Theme: ${theme} (click for ${next})`} onClick={() => {
      if (next === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      try { localStorage.setItem('hsl-theme', next); } catch { /* ignore */ }
      setTheme(next);
    }}>{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</button>
  );
}

export default function Layout() {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!me) return null;
  const projects = me.projects.filter((p) => !p.archived_at);
  const anyAdmin = can('admin.users') || can('admin.roles') || can('admin.audit');
  return (
    <div className="shell">
      {open && <div className="scrim" style={{ zIndex: 39 }} onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><img src="/favicon.svg" alt="" /> HSL KanBan</div>
        <nav className="nav">
          <NavLink to="/" end>All projects</NavLink>
          <div className="nav-label">Projects</div>
          {projects.map((p) => (
            <div key={p.id}>
              <NavLink to={`/p/${p.key}`} end>{p.name}<span className="key">{p.key}</span></NavLink>
            </div>
          ))}
          {!projects.length && <div className="faint small" style={{ padding: '4px 8px' }}>No projects yet</div>}
          {anyAdmin && <div className="nav-label">Administration</div>}
          {can('admin.users') && <NavLink to="/admin/users">Users</NavLink>}
          {can('admin.roles') && <NavLink to="/admin/roles">Roles &amp; permissions</NavLink>}
          {can('admin.audit') && <NavLink to="/admin/audit">Audit log</NavLink>}
        </nav>
        <div className="sidebar-foot">
          <Avatar name={me.name} />
          <div className="who small">
            <div style={{ fontWeight: 600 }}>{me.name}</div>
            <div className="faint"><NavLink to="/account">Account</NavLink> · <a href="#" onClick={async (e) => {
              e.preventDefault();
              await api.post('/api/auth/logout').catch(() => {});
              qc.clear();
              qc.setQueryData(['me'], null);
              nav('/login');
            }}>Sign out</a></div>
          </div>
          <ThemeToggle />
        </div>
      </aside>
      <main className="main">
        <button className="btn ghost menu-btn" style={{ position: 'fixed', top: 10, left: 8, zIndex: 30 }} onClick={() => setOpen(true)} aria-label="Menu">☰</button>
        <Outlet />
      </main>
    </div>
  );
}
