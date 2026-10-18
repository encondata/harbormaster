import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type Project } from '../api';

export function useProject(key: string | undefined) {
  return useQuery({ queryKey: ['project', key], queryFn: () => api.get<Project>(`/api/projects/${key}`), enabled: !!key });
}

export const canDo = (p: Project | undefined, perm: string) => !!p?.permissions.includes(perm);

type Change = { type: string; boardId?: string; cardId?: string; actor?: string };

/** Subscribe to the project's live change feed and refresh affected queries. Returns recently changed card ids. */
export function useProjectEvents(project: Project | undefined, myName: string | undefined) {
  const qc = useQueryClient();
  const [recent, setRecent] = useState<Record<string, number>>({});
  const [last, setLast] = useState<Change | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!project) return;
    const es = new EventSource(`/api/projects/${project.key}/events`);
    const pending = new Set<string>();
    const flush = () => {
      for (const k of pending) qc.invalidateQueries({ queryKey: JSON.parse(k) });
      pending.clear();
    };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Change;
      setLast(e);
      pending.add(JSON.stringify(['cards', project.key]));
      pending.add(JSON.stringify(['summary', project.key]));
      pending.add(JSON.stringify(['activity', project.key]));
      if (e.cardId || e.type === 'project.imported') pending.add(JSON.stringify(['card']));
      if (e.type.startsWith('board') || e.type.startsWith('area') || e.type.startsWith('project')) pending.add(JSON.stringify(['project', project.key]));
      if (e.type.startsWith('card')) pending.add(JSON.stringify(['project', project.key]));
      if (e.type.startsWith('update') || e.type === 'project.imported') pending.add(JSON.stringify(['updates', project.key]));
      if (e.cardId && e.actor !== myName) setRecent((r) => ({ ...r, [e.cardId!]: Date.now() }));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 250);
    };
    return () => {
      es.close();
      window.clearTimeout(timer.current);
    };
  }, [project?.key, qc, myName]);
  // Drop highlights after 30 seconds.
  useEffect(() => {
    const t = window.setInterval(() => setRecent((r) => Object.fromEntries(Object.entries(r).filter(([, at]) => Date.now() - at < 30_000))), 5000);
    return () => window.clearInterval(t);
  }, []);
  return { recent, last };
}
