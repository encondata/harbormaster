import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../lib/auth';
import TopBar from './TopBar';
import { Avatar } from './ui';

export type Theme = 'light' | 'dark' | 'system';

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : t === 'light' ? 'light' : 'system';
}

export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('hsl-theme-v2', t); } catch { /* ignore */ }
  window.dispatchEvent(new Event('hsl:theme'));
}

export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const on = () => setTheme(currentTheme());
    window.addEventListener('hsl:theme', on);
    return () => window.removeEventListener('hsl:theme', on);
  }, []);
  return theme;
}

/** Sidebar footer: your avatar and name; opens a menu with Profile, Settings and Sign out. */
function AccountMenu({ name, email, userId, photoAt }: { name: string; email: string; userId: string; photoAt: string | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLButtonElement>('.account-btn')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const go = (path: string) => { setOpen(false); nav(path); };
  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    // A full page load drops cached data, in-flight requests and the live-update
    // connection, so nothing can restore the signed-in view.
    qc.clear();
    window.location.replace('/login');
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items.current.filter(Boolean) as HTMLButtonElement[];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
  };
  const entries: [string, () => void][] = [['Profile', () => go('/account')], ['Settings', () => go('/account?tab=preferences')], ['Sign out', signOut]];
  return (
    <div className="account" ref={ref}>
      {open && (
        <div className="account-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          <div className="account-menu-hd"><div className="account-name">{name}</div><div className="faint small account-email">{email}</div></div>
          {entries.map(([label, fn], i) => (
            <button key={label} ref={(el) => { items.current[i] = el; }} role="menuitem" className={label === 'Sign out' ? 'danger' : ''} onClick={fn}>{label}</button>
          ))}
        </div>
      )}
      <button className="account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={`${name} (${email})`}>
        <Avatar name={name} userId={userId} photoAt={photoAt} />
        <span className="account-name">{name}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 15l5-5 5 5" /></svg>
      </button>
    </div>
  );
}

export default function Layout() {
  const { me, can } = useAuth();
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
        <div className="brand"><span className="logo" aria-hidden="true" /> Harbor Master</div>
        <nav className="nav">
          <NavLink to="/" end>All projects</NavLink>
          <NavLink to="/wiki">Wiki</NavLink>
          <NavLink to="/skills">Skills</NavLink>
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
          <AccountMenu name={me.name} email={me.email} userId={me.id} photoAt={me.avatar_updated_at} />
        </div>
      </aside>
      <main className="main">
        <TopBar me={me} onMenu={() => setOpen(true)} />
        <div className="main-body">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
