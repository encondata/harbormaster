import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useProviders, useSignOut } from '../lib/sso';
import Mark from './Mark';
import { AppSwitcher, UserMenu } from './Suite';
import TopBar from './TopBar';

/**
 * The user menu at the right of the top bar (the kit's): your photo (if you have one), name and role, Profile
 * (the HackSpaceLabs profile for a HackSpaceLabs account, this app's Account page for a local one), dark
 * mode, Sign out. Below 1200px the top bar has no room for the name, so only the avatar shows.
 */
function AccountMenu({ me }: { me: NonNullable<ReturnType<typeof useAuth>['me']> }) {
  const providers = useProviders();
  const signOut = useSignOut();
  const role = me.global_roles.map((r) => r.name).join(', ') || 'Member';
  const viaHsl = me.auth_source === 'oidc';
  const portal = providers.data?.portal_url;
  const photo = me.avatar_updated_at ? `/api/users/${me.id}/avatar?v=${Date.parse(me.avatar_updated_at)}` : undefined;
  return (
    <>
      <AppSwitcher apps={providers.data?.apps ?? []} current="harbormaster" />
      <UserMenu name={me.name} detail={`${role} · ${viaHsl ? 'HackSpaceLabs' : 'Local account'}`} avatarUrl={photo}
        profileUrl={viaHsl && portal ? `${portal}/me` : '/account'} compactBelow={1200} onSignOut={() => signOut()} />
    </>
  );
}

const NI = { width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, className: 'nav-icon' };
const NavIcons = {
  projects: <svg {...NI}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  wiki: <svg {...NI}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /><path d="M8 7h8M8 11h6" /></svg>,
  skills: <svg {...NI}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></svg>,
  users: <svg {...NI}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20" /></svg>,
  roles: <svg {...NI}><path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  audit: <svg {...NI}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></svg>,
  collapse: <svg {...NI}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M16 10l-2 2 2 2" /></svg>,
  expand: <svg {...NI}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M14 10l2 2-2 2" /></svg>,
  account: <svg {...NI}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>,
};

const COLLAPSE_KEY = 'hsl-sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } };

export default function Layout() {
  const { me, can } = useAuth();
  // Desktop only: the sidebar can shrink to an icon rail. Under 900px the kit shows it as a strip.
  const [collapsed, setCollapsed] = useState(readCollapsed);
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
  const item = 'hsl-nav-item';
  return (
    <>
      <a className="hsl-skip" href="#main">Skip to content</a>
      <div className={`hsl-shell hm-shell ${collapsed ? 'is-collapsed' : ''}`}>
        <aside className="hsl-sidebar">
          <Link to="/" className="hsl-brand" aria-label="Harbor Master home" title="Harbor Master"><Mark size={34} /><span className="hsl-wordmark">Harbor Master</span></Link>
          <nav className="hsl-nav" aria-label="Main">
            <div className="hsl-nav-group">
              <div className="hsl-nav-label">Workspace</div>
              <NavLink className={item} to="/" end title="All projects">{NavIcons.projects}<span className="nav-text">All projects</span></NavLink>
              <NavLink className={item} to="/wiki" title="Wiki">{NavIcons.wiki}<span className="nav-text">Wiki</span></NavLink>
              <NavLink className={item} to="/skills" title="Skills">{NavIcons.skills}<span className="nav-text">Skills</span></NavLink>
            </div>
            <div className="hsl-nav-group">
              <div className="hsl-nav-label">Projects</div>
              {projects.map((p) => (
                <NavLink className={item} key={p.id} to={`/p/${p.key}`} title={`${p.name} (${p.key})`}>
                  <span className="nav-chip" aria-hidden="true">{p.key.slice(0, 2)}</span>
                  <span className="nav-text">{p.name}</span><span className="key">{p.key}</span>
                </NavLink>
              ))}
              {!projects.length && <div className="faint small nav-empty">No projects yet</div>}
            </div>
            {anyAdmin && (
              <div className="hsl-nav-group">
                <div className="hsl-nav-label">Administration</div>
                {can('admin.users') && <NavLink className={item} to="/admin/users" title="Users">{NavIcons.users}<span className="nav-text">Users</span></NavLink>}
                {can('admin.roles') && <NavLink className={item} to="/admin/roles" title="Roles & permissions">{NavIcons.roles}<span className="nav-text">Roles &amp; permissions</span></NavLink>}
                {can('admin.audit') && <NavLink className={item} to="/admin/audit" title="Audit log">{NavIcons.audit}<span className="nav-text">Audit log</span></NavLink>}
              </div>
            )}
          </nav>
          {/* Harbor Master's own account page (password, API tokens, Claude, preferences) and the rail toggle. */}
          <div className="hsl-sidebar-foot">
            <NavLink className={item} to="/account" title="Account: password, API tokens, Claude and preferences">{NavIcons.account}<span className="nav-text">Account</span></NavLink>
            <button type="button" className={`${item} rail-toggle`} onClick={() => setCollapsed((c) => !c)} aria-label={toggleLabel} title={toggleLabel} aria-expanded={!collapsed}>
              {collapsed ? NavIcons.expand : NavIcons.collapse}<span className="nav-text">Collapse sidebar</span>
            </button>
          </div>
        </aside>
        <div className="hsl-main">
          <TopBar me={me}><AccountMenu me={me} /></TopBar>
          <main className="hsl-content hm-content" id="main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
