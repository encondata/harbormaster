// Header across the top of the main area: breadcrumbs, global search, and quick tools
// (help, Claude, notifications, command palette).
import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, type Me } from '../api';
import { timeAgo } from '../lib/format';
import { useProject } from '../lib/project';
import { applyTheme } from './Layout';
import { Modal } from './ui';

const I = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const Icons = {
  search: <svg {...I}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>,
  help: <svg {...I}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5V14" /><path d="M12 17h.01" /></svg>,
  spark: <svg {...I}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></svg>,
  bell: <svg {...I}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></svg>,
  cmd: <svg {...I}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z" /></svg>,
  menu: <svg {...I}><path d="M4 7h16M4 12h16M4 17h16" /></svg>,
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

// ---------- Breadcrumbs ----------

function Crumbs() {
  const loc = useLocation();
  const parts = loc.pathname.split('/').filter(Boolean);
  const sp = new URLSearchParams(loc.search);
  const projectKey = parts[0] === 'p' ? parts[1] : undefined;
  const project = useProject(projectKey);
  const crumbs: { label: string; to?: string }[] = [];
  if (projectKey) {
    const p = project.data;
    crumbs.push({ label: 'Projects', to: '/' }, { label: p?.name ?? projectKey, to: `/p/${projectKey}` });
    const sub = parts[2];
    if (sub === 'b') {
      const board = p?.boards.find((b) => b.key === parts[3]);
      crumbs.push({ label: board?.name ?? parts[3], to: `/p/${projectKey}/b/${parts[3]}` });
      if (sp.get('card')) crumbs.push({ label: sp.get('card')! });
    } else if (sub) {
      const names: Record<string, string> = { requests: 'Requests', updates: 'Updates', activity: 'Activity', settings: 'Settings' };
      crumbs.push({ label: names[sub] ?? sub, to: `/p/${projectKey}/${sub}` });
      if (sub === 'requests' && sp.get('request')) crumbs.push({ label: sp.get('request')! });
    } else crumbs.push({ label: 'Summary' });
  } else if (parts[0] === 'admin') {
    const names: Record<string, string> = { users: 'Users', roles: 'Roles & permissions', audit: 'Audit log' };
    crumbs.push({ label: 'Administration' }, { label: names[parts[1]] ?? parts[1], to: `/admin/${parts[1]}` });
    if (parts[2]) crumbs.push({ label: 'User' });
  } else if (parts[0] === 'account') crumbs.push({ label: 'Account', to: '/account' }, { label: ({ claude: 'Claude', preferences: 'Preferences', notifications: 'Notifications', history: 'History' } as Record<string, string>)[sp.get('tab') ?? ''] ?? 'My profile' });
  else crumbs.push({ label: 'Projects' }, { label: 'All projects' });
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
          {i === crumbs.length - 1 ? <span className="crumb-current" aria-current="page">{c.label}</span> : c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
        </Fragment>
      ))}
    </nav>
  );
}

// ---------- Search (shared by the header box and the command palette) ----------

type SearchResults = {
  projects: { key: string; name: string }[];
  boards: { key: string; name: string; project_key: string; project_name: string }[];
  cards: { key: string; title: string; board_key: string; board_name: string; column_name: string; project_key: string }[];
  requests: { key: string; title: string; status: string; project_key: string }[];
};
type Item = { id: string; group: string; label: ReactNode; text: string; meta?: string; run: () => void };

function useDebounced<T>(v: T, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function useSearchItems(text: string, go: (to: string) => void): { items: Item[]; loading: boolean } {
  const q = useDebounced(text.trim());
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.length >= 2, staleTime: 10_000 });
  const d = res.data;
  const items: Item[] = [];
  if (q.length >= 2 && d) {
    for (const c of d.cards) items.push({ id: `c${c.key}`, group: 'Cards', label: <><span className="mono faint">{c.key}</span> {c.title}</>, text: c.title, meta: `${c.board_name} · ${c.column_name}`, run: () => go(`/p/${c.project_key}/b/${c.board_key}?card=${c.key}`) });
    for (const r of d.requests) items.push({ id: `r${r.key}`, group: 'Requests', label: <><span className="mono faint">{r.key}</span> {r.title}</>, text: r.title, meta: r.status, run: () => go(`/p/${r.project_key}/requests?request=${r.key}`) });
    for (const p of d.projects) items.push({ id: `p${p.key}`, group: 'Projects', label: p.name, text: p.name, meta: p.key, run: () => go(`/p/${p.key}`) });
    for (const b of d.boards) items.push({ id: `b${b.project_key}${b.key}`, group: 'Boards', label: b.name, text: b.name, meta: b.project_name, run: () => go(`/p/${b.project_key}/b/${b.key}`) });
  }
  return { items, loading: q.length >= 2 && res.isFetching };
}

function ResultList({ items, active, onPick, empty }: { items: Item[]; active: number; onPick: (i: number) => void; empty?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (!items.length) return <div className="results-empty">{empty}</div>;
  let last = '';
  return (
    <div className="results" ref={ref} role="listbox">
      {items.map((it, i) => {
        const head = it.group !== last ? <div className="results-group">{it.group}</div> : null;
        last = it.group;
        return (
          <Fragment key={it.id}>
            {head}
            <button type="button" role="option" aria-selected={i === active} data-i={i} className={`result ${i === active ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(i)}>
              <span className="result-label">{it.label}</span>
              {it.meta && <span className="result-meta">{it.meta}</span>}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function listKeys(e: React.KeyboardEvent, count: number, active: number, setActive: (n: number) => void, pick: () => void) {
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(count ? (active + 1) % count : 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(count ? (active - 1 + count) % count : 0); }
  else if (e.key === 'Enter') { e.preventDefault(); pick(); }
}

function SearchBox({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const nav = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const go = (to: string) => { setOpen(false); setText(''); inputRef.current?.blur(); nav(to); };
  const { items, loading } = useSearchItems(text, go);
  useEffect(() => setActive(0), [items.length, text]);
  return (
    <div className="search">
      <span className="search-icon">{Icons.search}</span>
      <input ref={inputRef} id="global-search" type="search" placeholder="Search everywhere…" value={text} autoComplete="off"
        aria-label="Search everywhere" aria-expanded={open && text.trim().length >= 2} aria-controls="search-results"
        onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setText(''); inputRef.current?.blur(); return; }
          listKeys(e, items.length, active, setActive, () => items[active]?.run());
        }} />
      <kbd className="search-kbd" aria-hidden="true">/</kbd>
      {open && text.trim().length >= 2 && (
        <div className="search-pop" id="search-results">
          <ResultList items={items} active={active} onPick={(i) => items[i].run()} empty={loading ? 'Searching…' : `Nothing matches "${text.trim()}".`} />
        </div>
      )}
    </div>
  );
}

// ---------- Command palette ----------

function CommandPalette({ me, onClose }: { me: Me; onClose: () => void }) {
  const nav = useNavigate();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const go = (to: string) => { onClose(); nav(to); };
  const can = (p: string) => me.global_permissions.includes(p);
  const commands: Item[] = useMemo(() => {
    const c: Item[] = [{ id: 'all', group: 'Go to', label: 'All projects', text: 'all projects home', run: () => go('/') }];
    for (const p of me.projects.filter((x) => !x.archived_at)) {
      c.push({ id: `p-${p.key}`, group: 'Go to', label: p.name, text: `${p.name} ${p.key} summary`, meta: p.key, run: () => go(`/p/${p.key}`) });
      c.push({ id: `pr-${p.key}`, group: 'Go to', label: `${p.name} › Requests`, text: `${p.name} ${p.key} requests feature`, run: () => go(`/p/${p.key}/requests`) });
      c.push({ id: `pu-${p.key}`, group: 'Go to', label: `${p.name} › Updates`, text: `${p.name} ${p.key} updates weekly progress`, run: () => go(`/p/${p.key}/updates`) });
    }
    c.push({ id: 'profile', group: 'Go to', label: 'Profile', text: 'profile account password tokens', run: () => go('/account') });
    c.push({ id: 'claude', group: 'Go to', label: 'Connect Claude', text: 'claude connect mcp token setup', run: () => go('/account?tab=claude') });
    c.push({ id: 'settings', group: 'Go to', label: 'Settings', text: 'settings preferences theme', run: () => go('/account?tab=preferences') });
    if (can('admin.users')) c.push({ id: 'users', group: 'Go to', label: 'Users', text: 'users admin people', run: () => go('/admin/users') });
    if (can('admin.roles')) c.push({ id: 'roles', group: 'Go to', label: 'Roles & permissions', text: 'roles permissions admin', run: () => go('/admin/roles') });
    if (can('admin.audit')) c.push({ id: 'audit', group: 'Go to', label: 'Audit log', text: 'audit log history admin', run: () => go('/admin/audit') });
    c.push({ id: 'light', group: 'Actions', label: 'Switch to light mode', text: 'theme light mode', run: () => { applyTheme('light'); onClose(); } });
    c.push({ id: 'dark', group: 'Actions', label: 'Switch to dark mode', text: 'theme dark mode', run: () => { applyTheme('dark'); onClose(); } });
    c.push({ id: 'signout', group: 'Actions', label: 'Sign out', text: 'sign out log out logout', run: async () => { await api.post('/api/auth/logout').catch(() => {}); window.location.replace('/login'); } });
    return c;
  }, [me]);
  const needle = text.trim().toLowerCase();
  const matched = needle ? commands.filter((c) => needle.split(/\s+/).every((w) => c.text.toLowerCase().includes(w) || String(c.meta ?? '').toLowerCase().includes(w))) : commands;
  const { items: found, loading } = useSearchItems(text, go);
  const items = [...matched.slice(0, needle ? 8 : 40), ...found];
  useEffect(() => setActive(0), [text]);
  return (
    <Modal title="Go to or do…" onClose={onClose} wide>
      <div className="palette">
        <div className="search palette-input">
          <span className="search-icon">{Icons.search}</span>
          <input autoFocus placeholder="Type a page, project, card key or action…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Command"
            onKeyDown={(e) => listKeys(e, items.length, active, setActive, () => items[active]?.run())} />
        </div>
        <ResultList items={items} active={active} onPick={(i) => items[i].run()} empty={loading ? 'Searching…' : 'No matches.'} />
        <div className="faint small">↑ ↓ to choose · Enter to open · Esc to close</div>
      </div>
    </Modal>
  );
}

// ---------- Notifications ----------

type FeedItem = { id: number; at: string; actor_name: string; via: string; action: string; summary: string; entity_type: string; entity_id: string | null; project_key: string; project_name: string };
const SEEN_KEY = 'hsl-feed-seen';
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY) ?? 0); } catch { return 0; } };

function Bell() {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  // While the panel is open, items newer than this stay highlighted even though they now count as read.
  const [highlightAfter, setHighlightAfter] = useState(seen);
  const ref = useRef<HTMLDivElement>(null);
  const feed = useQuery({ queryKey: ['feed'], queryFn: () => api.get<FeedItem[]>('/api/feed?limit=30'), refetchInterval: 60_000 });
  const items = feed.data ?? [];
  const unread = items.filter((i) => i.id > seen).length;
  const toggle = () => {
    if (!open) {
      setHighlightAfter(seen);
      const top = items[0]?.id ?? 0;
      if (top > seen) {
        setSeen(top);
        try { localStorage.setItem(SEEN_KEY, String(top)); } catch { /* ignore */ }
      }
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const link = (i: FeedItem) => i.entity_type === 'card' ? `/p/${i.project_key}/activity` : i.entity_type === 'request' ? `/p/${i.project_key}/requests` : i.entity_type === 'update' ? `/p/${i.project_key}/updates` : `/p/${i.project_key}/activity`;
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={`tool ${open ? 'on' : ''}`} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'} aria-expanded={open} onClick={toggle} title="Notifications">
        {Icons.bell}{unread > 0 && <span className="tool-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="pop pop-feed" role="dialog" aria-label="Notifications">
          <div className="pop-hd"><b>Recent changes</b><span className="faint small">by others on your projects</span></div>
          <div className="feed">
            {items.map((i) => (
              <Link key={i.id} to={link(i)} className={`feed-item ${i.id > highlightAfter ? 'new' : ''}`} onClick={() => setOpen(false)}>
                <div className="small"><b>{i.actor_name || 'System'}</b>{i.via !== 'web' && <span className={`via ${i.via}`} style={{ marginLeft: 6 }}>{i.via}</span>} <span className="faint">· {i.project_name} · {timeAgo(i.at)}</span></div>
                <div className="small muted">{i.summary}</div>
              </Link>
            ))}
            {!items.length && <div className="results-empty">{feed.isLoading ? 'Loading…' : 'Nothing new yet. Changes others make on your projects show up here.'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Help and Claude ----------

function HelpDialog({ onClose }: { onClose: () => void }) {
  const mod = isMac ? '⌘' : 'Ctrl';
  const rows: [string, string][] = [['/', 'Search everywhere'], [`${mod} K`, 'Go to a page or run an action'], ['Esc', 'Close a dialog, drawer or menu'], [`${mod} Enter`, 'Save a description or comment while editing']];
  return (
    <Modal title="Help" onClose={onClose}>
      <div className="stack">
        <div>
          <h3 style={{ marginBottom: 8 }}>Keyboard shortcuts</h3>
          <table className="t"><tbody>{rows.map(([k, d]) => <tr key={k}><td style={{ width: 120 }}><kbd className="kbd">{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
        </div>
        <div className="stack-sm small">
          <h3>Where things are</h3>
          <div><b>Projects</b> have a Summary, one tab per board, Requests, Updates and Activity. Owners also see Settings.</div>
          <div><b>Cards</b> open in a side panel with comments, attachments and their full history. Drag them between columns to change status.</div>
          <div><b>Your name</b> at the bottom of the sidebar opens Profile (password, API tokens), Settings (light or dark) and Sign out.</div>
          <div className="faint">Forgot your password? An administrator can reset it under Users.</div>
        </div>
      </div>
    </Modal>
  );
}

function ClaudeDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  return (
    <Modal title="Work with Claude" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={() => { onClose(); nav('/account?tab=claude'); }}>Set up Claude</button>
      </>
    }>
      <div className="stack-sm small">
        <p className="muted" style={{ margin: 0 }}>Claude Code can read and update Harbor Master for you: find and move cards, comment, file feature requests and log weekly progress. Everything it does is recorded in the history.</p>
        <p className="muted" style={{ margin: 0 }}><b>Set up Claude</b> creates your personal connection, gives you the one command to run, and writes the instructions to paste into a project's CLAUDE.md.</p>
      </div>
    </Modal>
  );
}

// ---------- Header ----------

export default function TopBar({ me, onMenu }: { me: Me; onMenu: () => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<'help' | 'claude' | 'palette' | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setDialog((d) => (d === 'palette' ? null : 'palette')); return; }
      if (e.key === '/' && !typingIn(e.target) && !dialog) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);
  return (
    <header className="appbar">
      <button className="tool menu-btn" onClick={onMenu} aria-label="Open menu">{Icons.menu}</button>
      <Crumbs />
      <span className="grow" />
      <SearchBox inputRef={searchRef} />
      <div className="tools">
        <button className="tool" onClick={() => setDialog('help')} aria-label="Help" title="Help">{Icons.help}</button>
        <button className="tool tool-accent" onClick={() => setDialog('claude')} aria-label="Work with Claude" title="Work with Claude">{Icons.spark}</button>
        <Bell />
        <button className="tool" onClick={() => setDialog('palette')} aria-label={`Command palette (${isMac ? '⌘' : 'Ctrl'} K)`} title={`Go to or do… (${isMac ? '⌘' : 'Ctrl'} K)`}>{Icons.cmd}</button>
      </div>
      {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === 'claude' && <ClaudeDialog onClose={() => setDialog(null)} />}
      {dialog === 'palette' && <CommandPalette me={me} onClose={() => setDialog(null)} />}
    </header>
  );
}
