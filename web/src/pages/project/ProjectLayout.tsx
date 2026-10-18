import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import type { Project } from '../../api';
import { ErrorBox, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { canDo, useProject, useProjectEvents } from '../../lib/project';

export type ProjectCtx = { project: Project; recent: Record<string, number> };
export const useProjectCtx = () => useOutletContext<ProjectCtx>();

export default function ProjectLayout() {
  const { key } = useParams();
  const { me } = useAuth();
  const q = useProject(key);
  const { recent } = useProjectEvents(q.data, me?.name);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <div className="page"><ErrorBox error={q.error ?? 'Project not found'} /></div>;
  const p = q.data;
  const boards = p.boards.filter((b) => !b.archived_at);
  return (
    <>
      <div className="topbar">
        <h1>{p.name} <span className="key">{p.key}</span></h1>
        {p.archived_at && <span className="badge">Archived</span>}
      </div>
      <nav className="tabs">
        <NavLink to={`/p/${p.key}`} end>Summary</NavLink>
        {boards.map((b) => (
          <NavLink key={b.id} to={`/p/${p.key}/b/${b.key}`}>{b.name}<span className="count">{b.card_count}</span></NavLink>
        ))}
        <NavLink to={`/p/${p.key}/updates`}>Updates</NavLink>
        {canDo(p, 'project.audit') && <NavLink to={`/p/${p.key}/activity`}>Activity</NavLink>}
        {canDo(p, 'project.manage') && <NavLink to={`/p/${p.key}/settings`}>Settings</NavLink>}
      </nav>
      <Outlet context={{ project: p, recent } satisfies ProjectCtx} />
    </>
  );
}
