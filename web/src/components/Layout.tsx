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

const NI = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: 'nav-icon' };
const NavIcons = {
  projects: <svg {...NI}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  wiki: <svg {...NI}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8 7h8M8 11h6" /></svg>,
  skills: <svg {...NI}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></svg>,
  users: <svg {...NI}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20" /></svg>,
  roles: <svg {...NI}><path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  audit: <svg {...NI}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  collapse: <svg {...NI}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M16 10l-2 2 2 2" /></svg>,
  expand: <svg {...NI}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 10l2 2-2 2" /></svg>,
};

const COLLAPSE_KEY = 'hsl-sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

export default function Layout() {
  const { me, can } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  // Desktop only: the sidebar can shrink to an icon rail. Phones keep the slide-out menu.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ } }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '\\' || e.code === 'Backslash')) { e.preventDefault(); setCollapsed((c) => !c); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!me) return null;
  const projects = me.projects.filter((p) => !p.archived_at);
  const anyAdmin = can('admin.users') || can('admin.roles') || can('admin.audit');
  const toggleLabel = collapsed ? 'Expand sidebar (Ctrl/⌘ \\)' : 'Collapse sidebar (Ctrl/⌘ \\)';
  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      {open && <div className="scrim" style={{ zIndex: 39 }} onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">
          <span className="logo" aria-hidden="true" /> <span className="brand-name">Harbor Master</span>
          <button type="button" className="rail-toggle" onClick={() => setCollapsed((c) => !c)} aria-label={toggleLabel} title={toggleLabel} aria-expanded={!collapsed}>
            {collapsed ? NavIcons.expand : NavIcons.collapse}
          </button>
        </div>
        <nav className="nav">
          <NavLink to="/" end title="All projects">{NavIcons.projects}<span className="nav-text">All projects</span></NavLink>
          <NavLink to="/wiki" title="Wiki">{NavIcons.wiki}<span className="nav-text">Wiki</span></NavLink>
          <NavLink to="/skills" title="Skills">{NavIcons.skills}<span className="nav-text">Skills</span></NavLink>
          <div className="nav-label">Projects</div>
          {projects.map((p) => (
            <div key={p.id}>
              <NavLink to={`/p/${p.key}`} end title={`${p.name} (${p.key})`}>
                <span className="nav-chip" aria-hidden="true">{p.key.slice(0, 2)}</span>
                <span className="nav-text">{p.name}</span><span className="key">{p.key}</span>
              </NavLink>
            </div>
          ))}
          {!projects.length && <div className="faint small nav-empty" style={{ padding: '4px 8px' }}>No projects yet</div>}
          {anyAdmin && <div className="nav-label">Administration</div>}
          {can('admin.users') && <NavLink to="/admin/users" title="Users">{NavIcons.users}<span className="nav-text">Users</span></NavLink>}
          {can('admin.roles') && <NavLink to="/admin/roles" title="Roles & permissions">{NavIcons.roles}<span className="nav-text">Roles &amp; permissions</span></NavLink>}
          {can('admin.audit') && <NavLink to="/admin/audit" title="Audit log">{NavIcons.audit}<span className="nav-text">Audit log</span></NavLink>}
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
