import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type AuditItem } from '../api';
import { dateTime, timeAgo } from '../lib/format';
import { Avatar, ErrorBox, Spinner } from './ui';

const ACTIONS = [
  ['', 'All actions'], ['card.', 'Cards (any)'], ['card.created', 'Card created'], ['card.updated', 'Card edited'], ['card.moved', 'Card moved'],
  ['card.commented', 'Comment added'], ['card.archived', 'Card archived'], ['update.', 'Progress updates'], ['project.', 'Project'],
  ['board.', 'Boards'], ['column.', 'Columns'], ['area.', 'Areas'], ['member.', 'Membership'], ['user.', 'Users'], ['role.', 'Roles'],
  ['token.', 'API tokens'], ['auth.', 'Sign-in'], ['auth.login_failed', 'Failed sign-in'], ['attachment.', 'Attachments'],
];

function fmt(v: unknown) {
  if (v === null || v === undefined || v === '') return '∅';
  if (Array.isArray(v)) return v.join(', ') || '∅';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 140);
  const s = String(v);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

export default function AuditList({ endpoint, projectKey, showProject }: { endpoint: string; projectKey?: string; showProject?: boolean }) {
  const [action, setAction] = useState('');
  const [via, setVia] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['activity', projectKey ?? 'all', endpoint, action, via, search],
    queryFn: ({ pageParam }) => api.get<{ items: AuditItem[]; next_before_id: number | null }>(`${endpoint}${qs({ action, via, q: search, before_id: pageParam ?? undefined, limit: 100 })}`),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before_id,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="stack">
      <form className="btn-row" onSubmit={(e) => { e.preventDefault(); setSearch(text); }}>
        <input className="input sm" style={{ width: 240 }} placeholder="Search summaries and people…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="input sm" style={{ width: 'auto' }} value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input sm" style={{ width: 'auto' }} value={via} onChange={(e) => setVia(e.target.value)}>
          <option value="">Any source</option><option value="web">Web</option><option value="mcp">Claude (MCP)</option><option value="api">API token</option><option value="import">Sheet import</option><option value="system">System</option>
        </select>
        <button className="btn sm">Search</button>
      </form>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>When</th><th>Who</th><th>Source</th>{showProject && <th>Project</th>}<th>What</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <td style={{ whiteSpace: 'nowrap' }} title={dateTime(a.at)}><div>{timeAgo(a.at)}</div><div className="faint small">{dateTime(a.at)}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}><span className="row"><Avatar name={a.actor_name || '?'} service={a.via === 'mcp' || a.via === 'api'} />{a.actor_name || 'System'}</span></td>
                  <td><span className={`via ${a.via}`}>{a.via}</span>{a.token_name && <div className="faint small">{a.token_name}</div>}{a.ip && <div className="faint small mono">{a.ip}</div>}</td>
                  {showProject && <td className="mono small">{a.project_key && <Link to={`/p/${a.project_key}`} onClick={(e) => e.stopPropagation()}>{a.project_key}</Link>}</td>}
                  <td>
                    <div>{a.summary}</div>
                    <div className="faint small mono">{a.action}</div>
                    {open === a.id && a.changes && (
                      <div className="diff">
                        {Object.entries(a.changes as Record<string, any>).map(([k, v]) => (
                          <div key={k}><span className="faint">{k}:</span>{' '}
                            {v && typeof v === 'object' && 'from' in v ? <><span className="from">{fmt(v.from)}</span> → {fmt(v.to)}</> : fmt(v)}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && <div className="empty">No matching activity.</div>}
        </div>
      )}
      {q.hasNextPage && <div><button className="btn" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load older'}</button></div>}
    </div>
  );
}
