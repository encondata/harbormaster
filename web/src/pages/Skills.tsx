// Claude skills hosted in Harbor Master: the list, and one skill with its files and versions.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { CopyBlock } from '../components/ConnectClaude';
import { Confirm, ErrorBox, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { bytes, dateTime, timeAgo } from '../lib/format';

type SkillItem = { name: string; description: string; version: number; published_by_name: string; published_at: string; notes: string; file_count: number; total_bytes: number };
type SkillFile = { path: string; content: string; executable?: boolean };
type SkillDetail = {
  name: string; description: string; version: number; latest_version: number; archived: boolean; notes: string;
  published_by_name: string; published_at: string; total_bytes: number; files: SkillFile[];
  versions: { version: number; notes: string; published_by_name: string; published_at: string }[];
};

const MANIFEST = '.harbormaster.json';

function HowItWorks() {
  return (
    <div className="card-box">
      <div className="hd"><h2>Using these on a machine</h2></div>
      <div className="bd stack-sm small">
        <div className="muted">Skills install into Claude Code through the Harbor Master connection, so a machine only needs to be signed in (Profile → Claude → Claude Code). Then ask Claude:</div>
        <CopyBlock text="Install the factory skill from Harbor Master" label="Prompt" />
        <div className="faint">Claude fetches every file with <code>get_skill</code> and writes it under <code>~/.claude</code>. Ask "update my Harbor Master skills" to bring them all up to date; the factory also checks for a newer version each time it runs. To publish changes you made on a machine: "publish the factory skill to Harbor Master".</div>
      </div>
    </div>
  );
}

function SkillList() {
  const q = useQuery({ queryKey: ['skills'], queryFn: () => api.get<SkillItem[]>('/api/skills') });
  return (
    <>
      <div className="topbar"><h1>Skills</h1><span className="faint small">Claude Code skills shared from Harbor Master to every machine you sign in on.</span></div>
      <div className="page page-narrow stack">
        <ErrorBox error={q.error} />
        {q.isLoading && <Spinner />}
        {q.data && !q.data.length && <div className="card-box"><div className="bd faint">No skills published yet.</div></div>}
        {!!q.data?.length && (
          <div className="card-box">
            <div className="bd stack-sm">
              {q.data.map((s) => (
                <Link key={s.name} to={`/skills/${s.name}`} className="skill-row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div><b>{s.name}</b> <span className="badge">v{s.version}</span></div>
                    <div className="small muted skill-desc">{s.description || 'No description'}</div>
                  </div>
                  <div className="small faint" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {s.file_count} files · {bytes(s.total_bytes)}<br />{s.published_by_name} · {timeAgo(s.published_at)}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
        <HowItWorks />
      </div>
    </>
  );
}

function SkillPage({ name }: { name: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const version = sp.get('version');
  const q = useQuery({ queryKey: ['skill', name, version], queryFn: () => api.get<SkillDetail>(`/api/skills/${encodeURIComponent(name)}${version ? `?version=${version}` : ''}`) });
  const [open, setOpen] = useState<string | null>(null);
  const [archive, setArchive] = useState(false);
  const s = q.data;
  const files = s?.files.filter((f) => !f.path.endsWith(MANIFEST)) ?? [];
  return (
    <>
      <div className="topbar"><h1>{name}</h1>{s && <span className="badge">v{s.version}{s.version !== s.latest_version ? ` (latest is v${s.latest_version})` : ''}</span>}{s?.archived && <span className="badge">Archived</span>}</div>
      <div className="page page-narrow stack">
        <ErrorBox error={q.error} />
        {q.isLoading && <Spinner />}
        {s && (
          <>
            <div className="card-box">
              <div className="hd">
                <div className="grow"><h2>{s.name}</h2><div className="faint small" style={{ marginTop: 2 }}>Published by {s.published_by_name} {dateTime(s.published_at)} · {files.length} files · {bytes(s.total_bytes)}</div></div>
                {can('skills.publish') && <button className="btn sm" onClick={() => setArchive(true)}>{s.archived ? 'Restore' : 'Archive'}</button>}
              </div>
              <div className="bd stack-sm">
                <div className="small">{s.description}</div>
                {s.notes && <div className="small muted"><b>This version:</b> {s.notes}</div>}
                <CopyBlock text={`Install the ${s.name} skill from Harbor Master${s.version !== s.latest_version ? ` (version ${s.version})` : ''}`} label="Prompt" />
              </div>
            </div>
            <div className="card-box">
              <div className="hd"><h2>Files</h2><span className="faint small">installed under ~/.claude</span></div>
              <div className="bd stack-sm">
                {files.map((f) => (
                  <div key={f.path}>
                    <button type="button" className="skill-file" aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)}>
                      <span className="mono">{f.path}</span>
                      <span className="faint small">{f.executable ? 'executable · ' : ''}{bytes(new Blob([f.content]).size)}</span>
                    </button>
                    {open === f.path && <pre className="skill-code">{f.content}</pre>}
                  </div>
                ))}
              </div>
            </div>
            <div className="card-box">
              <div className="hd"><h2>Versions</h2></div>
              <div className="bd stack-sm">
                {s.versions.map((v) => (
                  <div key={v.version} className="row small">
                    <span className="badge">v{v.version}</span>
                    <div className="grow">{v.notes || <span className="faint">No notes</span>}<div className="faint">{v.published_by_name} · {dateTime(v.published_at)}</div></div>
                    {v.version === s.version ? <span className="faint">Showing</span> : <button className="btn sm" onClick={() => { setOpen(null); setSp(v.version === s.latest_version ? {} : { version: String(v.version) }); }}>View</button>}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      {archive && s && (
        <Confirm title={s.archived ? `Restore "${s.name}"?` : `Archive "${s.name}"?`} confirmLabel={s.archived ? 'Restore' : 'Archive'} danger={!s.archived}
          body={s.archived ? 'It shows in the list again and can be installed.' : "It's hidden from the list and from list_skills. Machines that already have it keep their copy."}
          onClose={() => setArchive(false)}
          onConfirm={async () => {
            await api.post(`/api/skills/${encodeURIComponent(s.name)}/archive`, { archived: !s.archived });
            qc.invalidateQueries({ queryKey: ['skill', name] });
            qc.invalidateQueries({ queryKey: ['skills'] });
          }} />
      )}
    </>
  );
}

export default function Skills() {
  const { name } = useParams();
  return name ? <SkillPage name={name} /> : <SkillList />;
}
