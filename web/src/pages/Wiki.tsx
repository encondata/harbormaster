// The wiki: folder tree on the left; pages, folders, editor, history, search and trash on the right.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Avatar, Confirm, ErrorBox, Modal, Spinner, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { diffLines, withContext } from '../lib/diff';
import { dateTime, timeAgo } from '../lib/format';
import { Markdown } from '../lib/markdown';

// ---------- Types and data ----------------------------------------------------------------------

type Level = 'none' | 'view' | 'edit';
type TreeFolder = { id: string; parent_id: string | null; name: string; restricted: boolean; has_rules: boolean; level: Level; system_kind: 'project' | 'design' | 'operations' | null; project_key: string | null };
type TreePage = { id: string; folder_id: string | null; title: string; current_version: number; updated_at: string; tags: string[]; path: string };
type Tree = { can_edit_top: boolean; can_manage: boolean; folders: TreeFolder[]; pages: TreePage[] };
type Page = {
  id: string; folder_id: string | null; path: string[]; title: string; tags: string[]; project_key: string | null; content: string;
  version: number; current_version: number; version_summary: string; version_by: string; version_at: string; version_via: string;
  created_at: string; created_by_name: string | null; updated_at: string; updated_by_name: string | null;
  can_edit: boolean; can_manage: boolean; comments: number; open_comments: number; files: number;
};
type Version = { version: number; title: string; summary: string; size_bytes: number; created_by_name: string; via: string; created_at: string };
type Comment = { id: string; parent_id: string | null; body: string; page_version: number; created_at: string; updated_at: string; resolved_at: string | null; author_id: string | null; author_name: string | null; author_photo_at: string | null; author_kind: string | null; resolved_by_name: string | null };
type FolderDetail = TreeFolder & { description: string; path: string[]; can_manage: boolean; policy_from: { id: string; name: string } | null; rules: Rule[] };
type Rule = { principal_type: 'user' | 'role'; principal_id: string; level: 'view' | 'edit'; name?: string; email?: string | null };
type Hit = { id: string; folder_id: string | null; title: string; snippet: string; updated_at: string; tags: string[]; path: string[] };

const useTree = () => useQuery({ queryKey: ['wiki', 'tree'], queryFn: () => api.get<Tree>('/api/wiki/tree') });
const usePage = (id: string | undefined, version?: string | null) =>
  useQuery({ queryKey: ['wiki', 'page', id, version ?? 'current'], queryFn: () => api.get<Page>(`/api/wiki/pages/${id}${version ? `?version=${version}` : ''}`), enabled: !!id });

function useWikiRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['wiki'] });
}

/** "ServerSherpa / Design" from a folder id, with each part linking to its folder. */
function FolderCrumbs({ tree, folderId, tail }: { tree: Tree | undefined; folderId: string | null; tail?: ReactNode }) {
  const chain: TreeFolder[] = [];
  const byId = new Map(tree?.folders.map((f) => [f.id, f]));
  for (let cur = folderId ? byId.get(folderId) : undefined; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) chain.unshift(cur);
  return (
    <div className="wiki-crumbs small">
      <Link to="/wiki">Wiki</Link>
      {chain.map((f) => <Fragment key={f.id}><span aria-hidden="true">/</span><Link to={`/wiki/folder/${f.id}`}>{f.name}</Link></Fragment>)}
      {tail && <><span aria-hidden="true">/</span>{tail}</>}
    </div>
  );
}

/** Tag chips. Inside a row that is itself a link they are plain labels (links can't nest). */
function Tags({ tags, plain }: { tags: string[]; plain?: boolean }) {
  if (!tags.length) return null;
  return (
    <span className="wiki-tags">
      {tags.map((t) => (plain ? <span key={t} className="wiki-tag">#{t}</span> : <Link key={t} className="wiki-tag" to={`/wiki/search?tag=${encodeURIComponent(t)}`}>#{t}</Link>))}
    </span>
  );
}

const FolderIcon = ({ open }: { open?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    {open ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7.5L5 19H5a2 2 0 0 1-2-2V7zM7.5 10H22l-2.5 9H5" /> : <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />}
  </svg>
);
const PageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6" /></svg>
);
const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

/** Folder choices for moving or creating, limited to where you can edit. */
function FolderSelect({ tree, value, onChange, exclude }: { tree: Tree; value: string; onChange: (v: string) => void; exclude?: string }) {
  const byId = new Map(tree.folders.map((f) => [f.id, f]));
  const pathOf = (f: TreeFolder) => { const out = [f.name]; let p = f.parent_id ? byId.get(f.parent_id) : undefined; while (p) { out.unshift(p.name); p = p.parent_id ? byId.get(p.parent_id) : undefined; } return out.join(' / '); };
  const within = (id: string, anc: string) => { for (let c = byId.get(id); c; c = c.parent_id ? byId.get(c.parent_id) : undefined) if (c.id === anc) return true; return false; };
  const options = tree.folders.filter((f) => f.level === 'edit' && !(exclude && within(f.id, exclude))).map((f) => ({ id: f.id, label: pathOf(f) })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {tree.can_edit_top && <option value="">Top level</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

// ---------- Tree ------------------------------------------------------------------------------------

const OPEN_KEY = 'hsl-wiki-open';
const NAV_KEY = 'hsl-wiki-nav-collapsed';

const PaneIcon = ({ open }: { open?: boolean }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />{open ? <path d="M14 10l2 2-2 2" /> : <path d="M16 10l-2 2 2 2" />}
  </svg>
);
function loadOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')); } catch { return new Set(); }
}

function WikiTree({ tree }: { tree: Tree }) {
  const loc = useLocation();
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const m = /^\/wiki\/(page|folder)\/([0-9a-f-]{36})/.exec(loc.pathname);
  const activeId = m?.[2];
  const byId = useMemo(() => new Map(tree.folders.map((f) => [f.id, f])), [tree]);
  // Open the folders above whatever is being viewed.
  useEffect(() => {
    if (!m) return;
    const start = m[1] === 'page' ? tree.pages.find((p) => p.id === m[2])?.folder_id : m[2];
    const add: string[] = [];
    for (let c = start ? byId.get(start) : undefined; c; c = c.parent_id ? byId.get(c.parent_id) : undefined) if (c.id !== m[2] || m[1] === 'page') add.push(c.id);
    if (add.some((id) => !open.has(id))) setOpen((o) => new Set([...o, ...add]));
  }, [loc.pathname, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* storage unavailable */ } }, [open]);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const children = (parent: string | null, depth: number): ReactNode[] => {
    const folders = tree.folders.filter((f) => f.parent_id === parent)
      // Projects first at the top level, then the rest; Design before Operations inside a project.
      .sort((a, b) => (parent === null ? Number(!a.system_kind) - Number(!b.system_kind) : 0) || (a.system_kind === 'design' ? -1 : b.system_kind === 'design' ? 1 : 0) || a.name.localeCompare(b.name));
    const pages = tree.pages.filter((p) => p.folder_id === parent);
    return [
      ...folders.map((f) => (
        <li key={f.id}>
          <div className={`wiki-node ${activeId === f.id ? 'active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
            <button type="button" className="wiki-caret" aria-label={open.has(f.id) ? `Collapse ${f.name}` : `Expand ${f.name}`} aria-expanded={open.has(f.id)} onClick={() => toggle(f.id)}>{open.has(f.id) ? '▾' : '▸'}</button>
            <Link to={`/wiki/folder/${f.id}`} className="wiki-node-link">
              <FolderIcon open={open.has(f.id)} />
              <span className="wiki-node-name">{f.name}</span>
              {f.system_kind === 'project' && <span className="key">{f.project_key}</span>}
              {(f.restricted || f.has_rules) && <span className="faint" title={f.restricted ? 'Restricted' : 'Custom access'}><LockIcon /></span>}
            </Link>
          </div>
          {open.has(f.id) && <ul>{children(f.id, depth + 1)}</ul>}
        </li>
      )),
      ...pages.map((p) => (
        <li key={p.id}>
          <Link to={`/wiki/page/${p.id}`} className={`wiki-node wiki-node-link ${activeId === p.id ? 'active' : ''}`} style={{ paddingLeft: 6 + depth * 14 + 18 }}>
            <PageIcon /><span className="wiki-node-name">{p.title}</span>
          </Link>
        </li>
      )),
    ];
  };
  const items = children(null, 0);
  return items.length ? <ul className="wiki-tree">{items}</ul> : <div className="faint small" style={{ padding: 8 }}>Nothing here yet.</div>;
}

// ---------- Home, search, tags ------------------------------------------------------------------

function Home({ tree }: { tree: Tree }) {
  const recent = useQuery({ queryKey: ['wiki', 'recent'], queryFn: () => api.get<(TreePage & { updated_by_name: string | null; path: string[] })[]>('/api/wiki/recent') });
  const tags = useQuery({ queryKey: ['wiki', 'tags'], queryFn: () => api.get<{ tag: string; pages: number }[]>('/api/wiki/tags') });
  const projects = tree.folders.filter((f) => f.system_kind === 'project');
  const sub = (id: string, kind: string) => tree.folders.find((f) => f.parent_id === id && f.system_kind === kind);
  return (
    <div className="stack">
      {!!projects.length && (
        <div className="card-box">
          <div className="hd"><h2>Projects</h2></div>
          <div className="bd wiki-projects">
            {projects.map((p) => {
              const d = sub(p.id, 'design');
              const o = sub(p.id, 'operations');
              return (
                <div key={p.id} className="wiki-project">
                  <Link to={`/wiki/folder/${p.id}`} className="wiki-project-name"><FolderIcon /> {p.name} <span className="key">{p.project_key}</span></Link>
                  <div className="small">{d && <Link to={`/wiki/folder/${d.id}`}>Design</Link>}{d && o && <span className="faint"> · </span>}{o && <Link to={`/wiki/folder/${o.id}`}>Operations</Link>}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card-box">
        <div className="hd"><h2>Recently changed</h2></div>
        <div className="bd">
          {recent.isLoading && <Spinner />}
          {recent.data && !recent.data.length && <div className="faint small">No pages yet. Start with <b>New page</b>.</div>}
          <div className="wiki-list">
            {recent.data?.map((p) => (
              <Link key={p.id} to={`/wiki/page/${p.id}`} className="wiki-list-row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="wiki-list-title"><PageIcon /> {p.title} <Tags tags={p.tags} plain /></div>
                  <div className="faint small">{p.path.join(' / ') || 'Top level'}</div>
                </div>
                <div className="faint small wiki-list-meta">v{p.current_version} · {p.updated_by_name ?? 'someone'}<br />{timeAgo(p.updated_at)}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>
      {!!tags.data?.length && (
        <div className="card-box">
          <div className="hd"><h2>Tags</h2></div>
          <div className="bd wiki-tags">{tags.data.map((t) => <Link key={t.tag} className="wiki-tag" to={`/wiki/search?tag=${encodeURIComponent(t.tag)}`}>#{t.tag} <span className="faint">{t.pages}</span></Link>)}</div>
        </div>
      )}
    </div>
  );
}

/** Search snippets mark matches with «»; turn them into <mark> without using HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

function SearchResults() {
  const [sp] = useSearchParams();
  const text = sp.get('q') ?? '';
  const tag = sp.get('tag') ?? '';
  const r = useQuery({ queryKey: ['wiki', 'search', text, tag], queryFn: () => api.get<Hit[]>(`/api/wiki/search?${new URLSearchParams({ q: text, ...(tag ? { tag } : {}) })}`), enabled: !!(text || tag) });
  return (
    <div className="stack">
      <div className="wiki-crumbs small"><Link to="/wiki">Wiki</Link><span aria-hidden="true">/</span><span>Search</span></div>
      <h2 className="wiki-title">{tag ? <>Pages tagged <span className="wiki-tag">#{tag}</span></> : <>Results for “{text}”</>}{tag && text ? <> matching “{text}”</> : null}</h2>
      {r.isLoading && <Spinner />}
      <ErrorBox error={r.error} />
      {r.data && !r.data.length && <div className="faint">No pages found.</div>}
      <div className="wiki-list">
        {r.data?.map((h) => (
          <Link key={h.id} to={`/wiki/page/${h.id}`} className="wiki-list-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="wiki-list-title"><PageIcon /> {h.title} <Tags tags={h.tags} plain /></div>
              <div className="faint small">{h.path.join(' / ') || 'Top level'}</div>
              {h.snippet && <div className="small muted wiki-snippet"><Snippet text={h.snippet} /></div>}
            </div>
            <div className="faint small wiki-list-meta">{timeAgo(h.updated_at)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------- Folders ---------------------------------------------------------------------------------

function NewFolderDialog({ tree, parent, onClose }: { tree: Tree; parent: string | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [where, setWhere] = useState(parent ?? '');
  const [err, setErr] = useState<unknown>(null);
  const refresh = useWikiRefresh();
  const nav = useNavigate();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      const f = await api.post<{ id: string }>('/api/wiki/folders', { name, description, parent_id: where || null });
      refresh();
      onClose();
      nav(`/wiki/folder/${f.id}`);
    } catch (e2) { setErr(e2); }
  };
  return (
    <Modal title="New folder" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={() => submit()}>Create folder</button></>}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field">Inside<FolderSelect tree={tree} value={where} onChange={setWhere} /></label>
        <label className="field">Description <span className="hint">Optional</span><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <ErrorBox error={err} />
      </form>
    </Modal>
  );
}

function EditFolderDialog({ tree, folder, onClose }: { tree: Tree; folder: FolderDetail; onClose: () => void }) {
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description);
  const [where, setWhere] = useState(folder.parent_id ?? '');
  const [err, setErr] = useState<unknown>(null);
  const refresh = useWikiRefresh();
  const system = !!folder.system_kind;
  return (
    <Modal title={`Edit folder`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={async () => {
      try {
        await api.patch(`/api/wiki/folders/${folder.id}`, system ? { description } : { name, description, parent_id: where || null });
        refresh();
        onClose();
      } catch (e) { setErr(e); }
    }}>Save</button></>}>
      <div className="form-grid">
        {system
          ? <div className="faint small">{folder.system_kind === 'project' ? "This is the project's folder. It's named after the project and moves with it." : "This is one of the project's standard folders, so its name and place are fixed."}</div>
          : <>
              <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="field">Inside<FolderSelect tree={tree} value={where} onChange={setWhere} exclude={folder.id} /></label>
            </>}
        <label className="field">Description<textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function AccessDialog({ folder, onClose }: { folder: FolderDetail; onClose: () => void }) {
  const principals = useQuery({ queryKey: ['wiki', 'principals'], queryFn: () => api.get<{ users: { id: string; name: string; email: string; kind: string }[]; roles: { id: string; name: string }[] }>('/api/wiki/principals') });
  const [restricted, setRestricted] = useState(folder.restricted);
  const [rules, setRules] = useState<Rule[]>(folder.rules);
  const [pick, setPick] = useState('');
  const [level, setLevel] = useState<'view' | 'edit'>('view');
  const [err, setErr] = useState<unknown>(null);
  const refresh = useWikiRefresh();
  const nameOf = (r: Rule) => r.name ?? (r.principal_type === 'user' ? principals.data?.users.find((u) => u.id === r.principal_id)?.name : principals.data?.roles.find((x) => x.id === r.principal_id)?.name) ?? 'Unknown';
  const add = () => {
    const [type, id] = pick.split(':') as ['user' | 'role', string];
    if (!id || rules.some((r) => r.principal_type === type && r.principal_id === id)) return;
    setRules([...rules, { principal_type: type, principal_id: id, level }]);
    setPick('');
  };
  const inherited = folder.policy_from && folder.policy_from.id !== folder.id;
  return (
    <Modal wide title={`Access: ${folder.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
      try {
        await api.put(`/api/wiki/folders/${folder.id}/access`, { restricted, rules: rules.map(({ principal_type, principal_id, level: l }) => ({ principal_type, principal_id, level: l })) });
        refresh();
        onClose();
      } catch (e) { setErr(e); }
    }}>Save access</button></>}>
      <div className="stack-sm small">
        <div className="muted">
          {folder.system_kind === 'project'
            ? <>By default this project folder follows the project: members who can see the project can read it, and members whose role includes <b>wiki.write</b> can edit it.</>
            : inherited
              ? <>This folder currently follows the access set on <b>{folder.policy_from!.name}</b>. Adding rules or restricting it here takes over for this folder and everything inside it.</>
              : folder.rules.length || folder.restricted
                ? <>These rules apply to this folder and everything inside it, unless a folder below sets its own.</>
                : <>By default everyone can read the wiki and people with <b>wiki.edit</b> can edit it. Rules here apply to this folder and everything inside it.</>}
        </div>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} style={{ marginTop: 3 }} />
          <span><b>Restricted</b>: only the people and roles listed below can see this folder. Wiki managers always can.</span>
        </label>
        <div className="wiki-rules">
          {rules.map((r, i) => (
            <div key={`${r.principal_type}:${r.principal_id}`} className="row" style={{ gap: 8 }}>
              <span className="badge">{r.principal_type === 'user' ? 'Person' : 'Role'}</span>
              <span className="grow">{nameOf(r)}</span>
              <select className="input" style={{ width: 120 }} value={r.level} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, level: e.target.value as 'view' | 'edit' } : x)))}>
                <option value="view">Can view</option><option value="edit">Can edit</option>
              </select>
              <button className="btn sm ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label={`Remove ${nameOf(r)}`}>Remove</button>
            </div>
          ))}
          {!rules.length && <div className="faint">No rules.{restricted ? ' Only wiki managers will see this folder.' : ''}</div>}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="input" style={{ flex: '1 1 220px' }} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add a person or role…</option>
            <optgroup label="People">{principals.data?.users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}{u.kind === 'service' ? ' (service)' : ` (${u.email})`}</option>)}</optgroup>
            <optgroup label="Roles">{principals.data?.roles.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}</optgroup>
          </select>
          <select className="input" style={{ width: 120 }} value={level} onChange={(e) => setLevel(e.target.value as 'view' | 'edit')}><option value="view">Can view</option><option value="edit">Can edit</option></select>
          <button className="btn" disabled={!pick} onClick={add}>Add</button>
        </div>
        <ErrorBox error={err ?? principals.error} />
      </div>
    </Modal>
  );
}

function FolderView({ tree }: { tree: Tree }) {
  const { id } = useParams();
  const nav = useNavigate();
  const refresh = useWikiRefresh();
  const q = useQuery({ queryKey: ['wiki', 'folder', id], queryFn: () => api.get<FolderDetail>(`/api/wiki/folders/${id}`) });
  const [dialog, setDialog] = useState<'folder' | 'edit' | 'access' | 'delete' | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? 'Folder not found'} />;
  const f = q.data;
  const subfolders = tree.folders.filter((x) => x.parent_id === f.id);
  const pages = tree.pages.filter((p) => p.folder_id === f.id);
  const canEdit = f.level === 'edit';
  return (
    <div className="stack">
      <FolderCrumbs tree={tree} folderId={f.parent_id} />
      <div className="wiki-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="wiki-title"><FolderIcon open /> {f.name} {f.project_key && <span className="key">{f.project_key}</span>}</h2>
          <div className="small faint">
            {f.system_kind === 'project' ? 'Project folder · access follows the project' : f.system_kind ? 'Project folder' : null}
            {f.restricted && <span className="badge" style={{ marginLeft: 6 }}><LockIcon /> Restricted</span>}
            {!f.restricted && f.rules.length > 0 && <span className="badge" style={{ marginLeft: 6 }}>Custom access</span>}
            {!canEdit && <span className="badge" style={{ marginLeft: 6 }}>View only</span>}
          </div>
        </div>
        <div className="wiki-actions">
          {canEdit && <Link className="btn primary sm" to={`/wiki/new?folder=${f.id}`}>New page</Link>}
          {canEdit && <button className="btn sm" onClick={() => setDialog('folder')}>New folder</button>}
          {canEdit && <button className="btn sm" onClick={() => setDialog('edit')}>Edit</button>}
          {f.can_manage && <button className="btn sm" onClick={() => setDialog('access')}>Access</button>}
          {f.can_manage && !f.system_kind && <button className="btn sm danger" onClick={() => setDialog('delete')}>Delete</button>}
        </div>
      </div>
      {f.description && <div className="muted">{f.description}</div>}
      <div className="card-box">
        <div className="bd">
          {!subfolders.length && !pages.length && <div className="faint small">This folder is empty.{canEdit ? ' Add a page to get started.' : ''}</div>}
          <div className="wiki-list">
            {subfolders.map((s) => (
              <Link key={s.id} to={`/wiki/folder/${s.id}`} className="wiki-list-row">
                <div className="grow wiki-list-title"><FolderIcon /> {s.name} {(s.restricted || s.has_rules) && <span className="faint"><LockIcon /></span>}</div>
                <div className="faint small wiki-list-meta">{tree.pages.filter((p) => p.folder_id === s.id).length} pages</div>
              </Link>
            ))}
            {pages.map((p) => (
              <Link key={p.id} to={`/wiki/page/${p.id}`} className="wiki-list-row">
                <div className="grow" style={{ minWidth: 0 }}><div className="wiki-list-title"><PageIcon /> {p.title} <Tags tags={p.tags} plain /></div></div>
                <div className="faint small wiki-list-meta">v{p.current_version} · {timeAgo(p.updated_at)}</div>
              </Link>
            ))}
          </div>
        </div>
      </div>
      {dialog === 'folder' && <NewFolderDialog tree={tree} parent={f.id} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditFolderDialog tree={tree} folder={f} onClose={() => setDialog(null)} />}
      {dialog === 'access' && <AccessDialog folder={f} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <Confirm danger title={`Delete "${f.name}"?`} confirmLabel="Move to trash"
          body={`The folder and everything in it (${tree.pages.filter((p) => p.folder_id === f.id).length} pages directly inside, plus subfolders) goes to the wiki trash, where a wiki manager can restore it.`}
          onClose={() => setDialog(null)}
          onConfirm={async () => { await api.del(`/api/wiki/folders/${f.id}`); refresh(); nav(f.parent_id ? `/wiki/folder/${f.parent_id}` : '/wiki'); }} />
      )}
    </div>
  );
}

// ---------- Pages -----------------------------------------------------------------------------------

function MoveDialog({ tree, page, onClose }: { tree: Tree; page: Page; onClose: () => void }) {
  const [where, setWhere] = useState(page.folder_id ?? '');
  const [err, setErr] = useState<unknown>(null);
  const refresh = useWikiRefresh();
  return (
    <Modal title={`Move "${page.title}"`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => {
      try { await api.post(`/api/wiki/pages/${page.id}/move`, { folder_id: where || null }); refresh(); onClose(); } catch (e) { setErr(e); }
    }}>Move</button></>}>
      <div className="form-grid">
        <label className="field">To folder<FolderSelect tree={tree} value={where} onChange={setWhere} /></label>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function PageView({ tree }: { tree: Tree }) {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const version = sp.get('version');
  const q = usePage(id, version);
  const nav = useNavigate();
  const refresh = useWikiRefresh();
  const toast = useToast();
  const [dialog, setDialog] = useState<'move' | 'delete' | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? 'Page not found'} />;
  const p = q.data;
  const old = p.version !== p.current_version;
  return (
    <div className="stack">
      <FolderCrumbs tree={tree} folderId={p.folder_id} />
      <div className="wiki-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="wiki-title">{p.title}</h2>
          <div className="small faint wiki-meta">
            <span><Link to={`/wiki/page/${p.id}/history`}>v{p.current_version}</Link> · edited by {p.updated_by_name ?? 'someone'} {timeAgo(p.updated_at)}</span>
            <Tags tags={p.tags} />
          </div>
        </div>
        <div className="wiki-actions">
          {p.can_edit && !old && <Link className="btn primary sm" to={`/wiki/page/${p.id}/edit`}>Edit</Link>}
          <Link className="btn sm" to={`/wiki/page/${p.id}/history`}>History</Link>
          {p.can_edit && <button className="btn sm" onClick={() => setDialog('move')}>Move</button>}
          {p.can_edit && <button className="btn sm danger" onClick={() => setDialog('delete')}>Delete</button>}
        </div>
      </div>
      {old && (
        <div className="warn-box row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="grow">You're viewing <b>v{p.version}</b> of {p.current_version}, saved by {p.version_by} {dateTime(p.version_at)}{p.version_summary ? `: “${p.version_summary}”` : ''}.</span>
          {p.can_edit && <button className="btn sm" onClick={async () => {
            try { await api.post(`/api/wiki/pages/${p.id}/restore`, { version: p.version }); toast(`Restored v${p.version}`); refresh(); setSp({}); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
          }}>Restore this version</button>}
          <button className="btn sm" onClick={() => setSp({})}>Show current</button>
        </div>
      )}
      <div className="card-box">
        <div className="bd">
          {p.content.trim() ? <Markdown text={p.content} className="wiki-md" /> : <div className="faint">This page is empty.{p.can_edit ? ' Click Edit to write it.' : ''}</div>}
        </div>
      </div>
      {!old && <Comments page={p} />}
      {dialog === 'move' && <MoveDialog tree={tree} page={p} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <Confirm danger title={`Delete "${p.title}"?`} confirmLabel="Move to trash" body="The page and its history go to the wiki trash, where a wiki manager can restore it."
          onClose={() => setDialog(null)}
          onConfirm={async () => { await api.del(`/api/wiki/pages/${p.id}`); refresh(); nav(p.folder_id ? `/wiki/folder/${p.folder_id}` : '/wiki'); }} />
      )}
    </div>
  );
}

function PageEditor({ tree, mode }: { tree: Tree; mode: 'new' | 'edit' }) {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const refresh = useWikiRefresh();
  const toast = useToast();
  const existing = usePage(mode === 'edit' ? id : undefined);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [summary, setSummary] = useState('');
  const [folder, setFolder] = useState(sp.get('folder') ?? '');
  const [view, setView] = useState<'write' | 'preview' | 'split'>(() => (window.innerWidth > 1100 ? 'split' : 'write'));
  const [base, setBase] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'edit' && existing.data && base === null) {
      setTitle(existing.data.title);
      setContent(existing.data.content);
      setTags(existing.data.tags.join(', '));
      setBase(existing.data.current_version);
    }
  }, [existing.data, mode, base]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const tagList = tags.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'new') {
        const p = await api.post<Page>('/api/wiki/pages', { folder_id: folder || null, title, content, tags: tagList, summary: summary || undefined });
        setDirty(false);
        refresh();
        nav(`/wiki/page/${p.id}`, { replace: true });
      } else {
        const r = await api.patch<{ version: number; unchanged: boolean }>(`/api/wiki/pages/${id}`, { title, content, tags: tagList, base_version: base, summary: summary || undefined });
        setDirty(false);
        refresh();
        toast(r.unchanged ? 'No changes to the text' : `Saved v${r.version}`);
        nav(`/wiki/page/${id}`);
      }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (title.trim() && !busy) save(); }
  };
  const insert = (text: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : content.length;
    const next = content.slice(0, at) + text + content.slice(el ? el.selectionEnd : at);
    setContent(next); setDirty(true);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };
  const upload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const f = await api.post<{ id: string; filename: string; content_type: string }>(`/api/wiki/pages/${id}/files`, fd);
      const url = `/api/wiki/files/${f.id}`;
      insert(f.content_type.startsWith('image/') ? `![${f.filename}](${url})` : `[${f.filename}](${url})`);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  if (mode === 'edit' && existing.isLoading) return <Spinner />;
  if (mode === 'edit' && (existing.error || !existing.data)) return <ErrorBox error={existing.error ?? 'Page not found'} />;
  const cancelTo = mode === 'edit' ? `/wiki/page/${id}` : folder ? `/wiki/folder/${folder}` : '/wiki';
  return (
    <div className="stack" onKeyDown={onKey}>
      <FolderCrumbs tree={tree} folderId={mode === 'edit' ? existing.data!.folder_id : folder || null} tail={<span>{mode === 'new' ? 'New page' : `Editing ${existing.data!.title}`}</span>} />
      <div className="wiki-edit-head">
        <input className="input wiki-title-input" placeholder="Page title" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} autoFocus={mode === 'new'} aria-label="Title" />
        {mode === 'new' && <label className="field" style={{ minWidth: 220 }}>Folder<FolderSelect tree={tree} value={folder} onChange={setFolder} /></label>}
      </div>
      <label className="field">Tags <span className="hint">Comma or space separated, e.g. api, auth, runbook</span>
        <input className="input" value={tags} onChange={(e) => { setTags(e.target.value); setDirty(true); }} placeholder="api, auth" />
      </label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg" role="radiogroup" aria-label="Editor view">
          {(['write', 'split', 'preview'] as const).map((v) => <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>
        <span className="grow" />
        {mode === 'edit'
          ? <><button type="button" className="btn sm" onClick={() => fileInput.current?.click()}>Insert image or file</button>
              <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></>
          : <span className="faint small">Images and files can be added once the page is saved.</span>}
      </div>
      <div className={`wiki-editor ${view}`}>
        {view !== 'preview' && (
          <textarea ref={area} className="input wiki-textarea" value={content} spellCheck
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
            onPaste={(e) => { const f = e.clipboardData.files?.[0]; if (f && mode === 'edit') { e.preventDefault(); upload(f); } }}
            placeholder="Write in Markdown: # Heading, **bold**, - lists, ```code```, [links](/wiki/…)" aria-label="Content" />
        )}
        {view !== 'write' && <div className="wiki-preview card-box"><div className="bd">{content.trim() ? <Markdown text={content} className="wiki-md" /> : <div className="faint">Nothing to preview yet.</div>}</div></div>}
      </div>
      <div className="row wiki-save" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 260px' }} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder={mode === 'new' ? 'Note for the history (optional), e.g. First draft' : 'What did you change? (optional)'} aria-label="Change summary" />
        <button className="btn primary" disabled={!title.trim() || busy} onClick={save}>{busy ? 'Saving…' : mode === 'new' ? 'Create page' : 'Save'}</button>
        <Link className="btn" to={cancelTo}>Cancel</Link>
      </div>
      <ErrorBox error={err} />
    </div>
  );
}

function History({ tree }: { tree: Tree }) {
  const { id } = useParams();
  const page = usePage(id);
  const versions = useQuery({ queryKey: ['wiki', 'history', id], queryFn: () => api.get<Version[]>(`/api/wiki/pages/${id}/history`) });
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  useEffect(() => {
    if (versions.data?.length && a === null) {
      setB(versions.data[0].version);
      setA(versions.data[1]?.version ?? versions.data[0].version);
    }
  }, [versions.data, a]);
  const left = usePage(a ? id : undefined, a ? String(a) : null);
  const right = usePage(b ? id : undefined, b ? String(b) : null);
  const lines = useMemo(() => (left.data && right.data ? diffLines(left.data.content, right.data.content) : undefined), [left.data, right.data]);
  if (page.isLoading || versions.isLoading) return <Spinner />;
  if (page.error || !page.data) return <ErrorBox error={page.error ?? 'Page not found'} />;
  const p = page.data;
  return (
    <div className="stack">
      <FolderCrumbs tree={tree} folderId={p.folder_id} tail={<Link to={`/wiki/page/${p.id}`}>{p.title}</Link>} />
      <h2 className="wiki-title">History</h2>
      <div className="card-box">
        <div className="bd wiki-history">
          <div className="wiki-history-row faint small"><span>Compare</span><span /><span>Version</span><span /></div>
          {versions.data?.map((v) => (
            <div key={v.version} className="wiki-history-row small">
              <span className="row" style={{ gap: 4 }}>
                <input type="radio" name="from" aria-label={`Compare from v${v.version}`} checked={a === v.version} onChange={() => setA(v.version)} />
                <input type="radio" name="to" aria-label={`Compare to v${v.version}`} checked={b === v.version} onChange={() => setB(v.version)} />
              </span>
              <span className="badge">v{v.version}</span>
              <span style={{ minWidth: 0 }}>
                <div>{v.summary || <span className="faint">No note</span>}{v.title !== p.title && <span className="faint"> (titled “{v.title}”)</span>}</div>
                <div className="faint">{v.created_by_name}{v.via === 'mcp' ? ' via Claude' : ''} · {dateTime(v.created_at)}</div>
              </span>
              <span className="row" style={{ gap: 6 }}><Link className="btn sm" to={`/wiki/page/${p.id}${v.version === p.current_version ? '' : `?version=${v.version}`}`}>View</Link></span>
            </div>
          ))}
        </div>
      </div>
      {a !== null && b !== null && (
        <div className="card-box">
          <div className="hd"><h2>Changes from v{Math.min(a, b) === a ? a : b} to v{Math.max(a, b) === b ? b : a}</h2></div>
          <div className="bd">
            {(left.isLoading || right.isLoading) && <Spinner />}
            {a === b && <div className="faint small">Pick two different versions to compare.</div>}
            {a !== b && lines === null && <div className="faint small">These versions are too large to compare line by line.</div>}
            {a !== b && lines && (lines.every((l) => l.kind === 'same')
              ? <div className="faint small">The text is the same{left.data?.title !== right.data?.title ? ' (only the title changed)' : ''}.</div>
              : <DiffView lines={a < b ? lines : diffLines(right.data!.content, left.data!.content) ?? []} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffView({ lines }: { lines: ReturnType<typeof diffLines> & {} }) {
  const shown = withContext(lines, 3);
  return (
    <div className="wiki-diff" role="table" aria-label="Changes">
      {shown.map((l, i) => l === null
        ? <div key={i} className="wiki-diff-gap">⋯</div>
        : <div key={i} className={`wiki-diff-line ${l.kind}`}><span className="n">{l.a ?? ''}</span><span className="n">{l.b ?? ''}</span><span className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span><span className="t">{l.text || ' '}</span></div>)}
    </div>
  );
}

// ---------- Comments ---------------------------------------------------------------------------------

function Comments({ page }: { page: Page }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wiki', 'comments', page.id], queryFn: () => api.get<Comment[]>(`/api/wiki/pages/${page.id}/comments`) });
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['wiki', 'comments', page.id] });
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } };
  const all = q.data ?? [];
  const threads = all.filter((c) => !c.parent_id);
  const open = threads.filter((t) => !t.resolved_at);
  const resolved = threads.filter((t) => t.resolved_at);

  const one = (c: Comment, isReply = false) => (
    <div key={c.id} className={`wiki-comment ${isReply ? 'reply' : ''}`}>
      <Avatar name={c.author_name ?? '?'} service={c.author_kind === 'service'} userId={c.author_id ?? undefined} photoAt={c.author_photo_at} size={26} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="small"><b>{c.author_name ?? 'Deleted user'}</b> <span className="faint">{timeAgo(c.created_at)}{c.updated_at !== c.created_at ? ' · edited' : ''}{c.page_version !== page.current_version ? ` · on v${c.page_version}` : ''}</span></div>
        {editing?.id === c.id ? (
          <div className="stack-sm" style={{ marginTop: 4 }}>
            <textarea className="input" rows={3} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} aria-label="Edit comment" />
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm primary" disabled={!editing.body.trim()} onClick={() => act(async () => { await api.patch(`/api/wiki/comments/${c.id}`, { body: editing.body }); setEditing(null); })}>Save</button>
              <button className="btn sm" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : <Markdown text={c.body} className="small" />}
        <div className="wiki-comment-actions small">
          {!isReply && <button className="linkish" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReply(''); }}>Reply</button>}
          {c.author_id === me?.id && editing?.id !== c.id && <button className="linkish" onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>}
          {!isReply && (c.author_id === me?.id || page.can_edit) && (
            <button className="linkish" onClick={() => act(() => api.post(`/api/wiki/comments/${c.id}/resolve`, { resolved: !c.resolved_at }))}>{c.resolved_at ? 'Reopen' : 'Resolve'}</button>
          )}
          {(c.author_id === me?.id || page.can_manage) && <button className="linkish danger" onClick={() => act(() => api.del(`/api/wiki/comments/${c.id}`))}>Delete</button>}
          {c.resolved_at && <span className="faint">Resolved by {c.resolved_by_name ?? 'someone'}</span>}
        </div>
      </div>
    </div>
  );
  const thread = (t: Comment) => (
    <div key={t.id} className="wiki-thread">
      {one(t)}
      {all.filter((c) => c.parent_id === t.id).map((r) => one(r, true))}
      {replyTo === t.id && (
        <div className="wiki-comment reply stack-sm">
          <textarea className="input" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" autoFocus aria-label="Reply" />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={!reply.trim()} onClick={() => act(async () => { await api.post(`/api/wiki/pages/${page.id}/comments`, { body: reply, parent_id: t.id }); setReplyTo(null); setReply(''); })}>Reply</button>
            <button className="btn sm" onClick={() => setReplyTo(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Comments {open.length ? <span className="faint small">{open.length} open</span> : null}</h2></div>
      <div className="bd stack-sm">
        {q.isLoading && <Spinner />}
        {open.map(thread)}
        {!open.length && !q.isLoading && <div className="faint small">No open comments.</div>}
        {!!resolved.length && <button className="linkish small" style={{ justifySelf: 'start' }} onClick={() => setShowResolved(!showResolved)}>{showResolved ? 'Hide' : 'Show'} {resolved.length} resolved</button>}
        {showResolved && resolved.map(thread)}
        <div className="stack-sm" style={{ marginTop: 6 }}>
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment (Markdown)…" aria-label="New comment" />
          <div><button className="btn sm primary" disabled={!body.trim()} onClick={() => act(async () => { await api.post(`/api/wiki/pages/${page.id}/comments`, { body }); setBody(''); })}>Comment</button></div>
        </div>
        <ErrorBox error={err} />
      </div>
    </div>
  );
}

// ---------- Trash -----------------------------------------------------------------------------------

function Trash() {
  const q = useQuery({ queryKey: ['wiki', 'trash'], queryFn: () => api.get<{ type: 'folder' | 'page'; id: string; title: string; deleted_at: string; deleted_batch: string; pages: number }[]>('/api/wiki/trash') });
  const refresh = useWikiRefresh();
  const toast = useToast();
  const [purge, setPurge] = useState<{ batch: string; title: string } | null>(null);
  return (
    <div className="stack">
      <div className="wiki-crumbs small"><Link to="/wiki">Wiki</Link><span aria-hidden="true">/</span><span>Trash</span></div>
      <h2 className="wiki-title">Trash</h2>
      <ErrorBox error={q.error} />
      {q.isLoading && <Spinner />}
      {q.data && !q.data.length && <div className="faint">The trash is empty.</div>}
      <div className="wiki-list">
        {q.data?.map((t) => (
          <div key={t.deleted_batch} className="wiki-list-row">
            <div className="grow wiki-list-title">{t.type === 'folder' ? <FolderIcon /> : <PageIcon />} {t.title}{t.type === 'folder' ? <span className="faint small">&nbsp;· {t.pages} pages</span> : null}</div>
            <div className="faint small">deleted {timeAgo(t.deleted_at)}</div>
            <button className="btn sm" onClick={async () => { try { await api.post(`/api/wiki/trash/${t.deleted_batch}/restore`); toast(`Restored "${t.title}"`); refresh(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); } }}>Restore</button>
            <button className="btn sm danger" onClick={() => setPurge({ batch: t.deleted_batch, title: t.title })}>Delete forever</button>
          </div>
        ))}
      </div>
      {purge && <Confirm danger title={`Delete "${purge.title}" forever?`} confirmLabel="Delete forever" body="Its pages, every saved version, comments and files are removed for good. This can't be undone."
        onClose={() => setPurge(null)} onConfirm={async () => { await api.del(`/api/wiki/trash/${purge.batch}`); refresh(); }} />}
    </div>
  );
}

// ---------- Shell -----------------------------------------------------------------------------------

export default function Wiki() {
  const tree = useTree();
  const nav = useNavigate();
  const loc = useLocation();
  const [sp] = useSearchParams();
  const [text, setText] = useState(loc.pathname === '/wiki/search' ? sp.get('q') ?? '' : '');
  const [newFolder, setNewFolder] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // Desktop: the folder pane can fold away to a thin strip (remembered). Phones use the Folders button.
  const [navCollapsed, setNavCollapsed] = useState(() => { try { return localStorage.getItem(NAV_KEY) === '1'; } catch { return false; } });
  useEffect(() => setNavOpen(false), [loc.pathname]);
  useEffect(() => { try { localStorage.setItem(NAV_KEY, navCollapsed ? '1' : '0'); } catch { /* storage unavailable */ } }, [navCollapsed]);
  const t = tree.data;
  // New pages start in the folder being viewed, when you can edit there.
  const here = /^\/wiki\/folder\/([0-9a-f-]{36})/.exec(loc.pathname)?.[1];
  const newPageHref = here && t?.folders.find((f) => f.id === here)?.level === 'edit' ? `/wiki/new?folder=${here}` : '/wiki/new';
  const canCreate = !!t && (t.can_edit_top || t.folders.some((f) => f.level === 'edit'));
  return (
    <>
      <div className="topbar wiki-topbar">
        <h1>Wiki</h1>
        <form className="wiki-search" role="search" onSubmit={(e) => { e.preventDefault(); if (text.trim()) nav(`/wiki/search?q=${encodeURIComponent(text.trim())}`); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search the wiki, or #tag" aria-label="Search the wiki" />
        </form>
        {canCreate && <Link className="btn primary" to={newPageHref}>New page</Link>}
        {canCreate && <button className="btn" onClick={() => setNewFolder(true)}>New folder</button>}
      </div>
      <div className={`wiki ${navCollapsed ? 'nav-collapsed' : ''}`}>
        <aside className={`wiki-nav ${navOpen ? 'open' : ''} ${navCollapsed ? 'collapsed' : ''}`}>
          <button type="button" className="btn sm wiki-nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>{navOpen ? 'Hide folders' : 'Folders'}</button>
          <button type="button" className="wiki-nav-expand" onClick={() => setNavCollapsed(false)} aria-label="Show folders" title="Show folders">
            <PaneIcon open /><span>Folders</span>
          </button>
          <div className="wiki-nav-head">
            <span className="faint small">Folders</span>
            <button type="button" className="rail-toggle" onClick={() => setNavCollapsed(true)} aria-label="Hide folders" title="Hide folders"><PaneIcon /></button>
          </div>
          <div className="wiki-nav-body">
            {tree.isLoading && <Spinner />}
            <ErrorBox error={tree.error} />
            {t && <WikiTree tree={t} />}
            {t?.can_manage && <Link className="wiki-trash-link small" to="/wiki/trash">Trash</Link>}
          </div>
        </aside>
        <section className="wiki-main">
          {t && (
            <Routes>
              <Route index element={<Home tree={t} />} />
              <Route path="search" element={<SearchResults />} />
              <Route path="trash" element={<Trash />} />
              <Route path="new" element={<PageEditor key="new" tree={t} mode="new" />} />
              <Route path="folder/:id" element={<FolderView tree={t} />} />
              <Route path="page/:id" element={<PageView tree={t} />} />
              <Route path="page/:id/edit" element={<PageEditor key="edit" tree={t} mode="edit" />} />
              <Route path="page/:id/history" element={<History tree={t} />} />
              <Route path="*" element={<div className="empty">Page not found</div>} />
            </Routes>
          )}
        </section>
      </div>
      {newFolder && t && <NewFolderDialog tree={t} parent={here && t.folders.find((f) => f.id === here)?.level === 'edit' ? here : null} onClose={() => setNewFolder(false)} />}
    </>
  );
}
