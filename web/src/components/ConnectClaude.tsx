// Profile → Claude: everything needed to point a Claude instance at this Harbor Master.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type ReactNode } from 'react';
import { api, type Project } from '../api';
import { useAuth } from '../lib/auth';
import Tokens from './Tokens';
import { ErrorBox, useToast } from './ui';

type Meta = { public_url: string; mcp_url: string };

function CopyBlock({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  const ref = useRef<HTMLPreElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    } catch {
      // Clipboard can be blocked (e.g. plain http); select the text so Cmd/Ctrl+C works.
      const r = document.createRange();
      if (ref.current) { r.selectNodeContents(ref.current); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
      toast('Selected. Press Cmd+C or Ctrl+C to copy.');
    }
  };
  return (
    <div className="copy-block">
      <pre ref={ref}>{text}</pre>
      <button type="button" className="btn sm" onClick={copy}>Copy</button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="claude-step">
      <span className="claude-step-n" aria-hidden="true">{n}</span>
      <div className="stack-sm" style={{ minWidth: 0 }}>
        <h3 className="claude-step-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

const mcpCommand = (meta: Meta, token: string) =>
  `claude mcp add --transport http --scope user harbormaster ${meta.mcp_url} --header "Authorization: Bearer ${token}"`;

/** The CLAUDE.md section for a repo, built from the project's real boards and columns. */
export function projectInstructions(p: Project, meta: Meta) {
  const boards = p.boards.filter((b) => !b.archived_at);
  const boardLines = boards.map((b) => `- **${b.name}** (\`${b.key}\`): ${b.columns.map((c) => c.name).join(' → ')}`).join('\n');
  // The work board is the one with an "In progress"-style column (e.g. To-Do), not a status board like Feature Parity.
  const inProgress = (c: { name: string }) => /in[ -]?progress|doing|working/i.test(c.name);
  const main = boards.find((b) => b.columns.some(inProgress)) ?? boards.find((b) => b.columns.some((c) => c.category === 'active')) ?? boards[0];
  const active = main?.columns.find(inProgress)?.name ?? main?.columns.find((c) => c.category === 'active')?.name ?? 'In progress';
  const done = main?.columns.find((c) => c.category === 'done')?.name ?? 'Done';
  return `## Progress tracking (Harbor Master)

Work for this repo is tracked in Harbor Master (${meta.public_url}), project **${p.name}** (key \`${p.key}\`), through the MCP server \`harbormaster\`.

Boards and their columns:
${boardLines}

How to work:
- At the start of a task, find the matching card with \`list_cards\` (search by words, or by key like \`${p.key}-42\`). If there isn't one, create it with \`create_card\` on the right board and mention its key in your plan.
- When you start, \`move_card\` it to "${active}"${main ? ` on ${main.name}` : ''}. When the work merges, move it to "${done}" with a comment saying what shipped, the commit hash and where it lives.
- Use \`add_comment\` for decisions, blockers and test results.
- When someone asks for something new, file it with \`create_request\` (set \`requested_for\` to who asked) instead of creating a card directly.
- At the end of a work session, \`log_progress\` one bullet per item done with an hours estimate, e.g. "Bulk asset update (~4 h)".
- Don't archive cards or change areas, boards or project settings unless asked.
`;
}

function ProjectSnippet({ meta }: { meta: Meta }) {
  const { me } = useAuth();
  const projects = (me?.projects ?? []).filter((p) => !p.archived_at);
  const [key, setKey] = useState(projects[0]?.key ?? '');
  const q = useQuery({ queryKey: ['project', key], queryFn: () => api.get<Project>(`/api/projects/${key}`), enabled: !!key });
  if (!projects.length) return <div className="faint small">You don't have access to any projects yet.</div>;
  return (
    <div className="stack-sm">
      <label className="field" style={{ maxWidth: 320 }}>Project
        <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
          {projects.map((p) => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
        </select>
      </label>
      {q.data ? <CopyBlock text={projectInstructions(q.data, meta)} label="Instructions" /> : <div className="faint small">Loading…</div>}
    </div>
  );
}

export default function ConnectClaude() {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: Infinity });
  const [name, setName] = useState('Claude Code');
  const [days, setDays] = useState('365');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!meta.data) return <div className="card-box"><div className="bd faint">Loading…</div></div>;
  const m = meta.data;
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ token: string }>('/api/me/tokens', { name: name.trim() || 'Claude Code', expires_in_days: days ? Number(days) : null });
      setToken(r.token);
      qc.invalidateQueries({ queryKey: ['tokens', '/api/me/tokens'] });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="profile-cols">
      <div className="card-box">
        <div className="hd"><div className="grow"><h2>Connect Claude</h2><div className="faint small" style={{ marginTop: 2 }}>Lets Claude Code read and update Harbor Master as you, with your permissions. Its changes show in history under your name, marked "mcp".</div></div></div>
        <div className="bd stack">
          <Step n={1} title="Create a connection token">
            {token ? (
              <div className="ok-box">Token created. It's in the command below and won't be shown again.</div>
            ) : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'end' }}>
                <label className="field" style={{ flex: '1 1 200px' }}>Name
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Where it'll be used, e.g. Claude Code on my laptop" /></label>
                <label className="field" style={{ width: 150 }}>Expires
                  <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>
                    <option value="90">In 90 days</option><option value="365">In 1 year</option><option value="">Never</option>
                  </select>
                </label>
                <button className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create token'}</button>
              </div>
            )}
            <ErrorBox error={err} />
          </Step>
          <Step n={2} title="Run this where you use Claude Code">
            <CopyBlock text={mcpCommand(m, token ?? '<your token>')} label="Command" />
            <div className="faint small">Run it once per machine. <code>claude mcp list</code> should then show <b>harbormaster</b> as connected. To remove it later: <code>claude mcp remove harbormaster</code>.</div>
          </Step>
          <Step n={3} title="Tell Claude about a project">
            <div className="faint small">Paste this into the <code>CLAUDE.md</code> of the project's repository, so Claude keeps the board up to date as it works.</div>
            <ProjectSnippet meta={m} />
          </Step>
        </div>
      </div>
      <div className="stack">
        <div className="card-box">
          <div className="hd"><h2>Scripts and other tools</h2></div>
          <div className="bd stack-sm small">
            <div className="muted">The same token works on the REST API. Keep it in an environment variable, not in code:</div>
            <CopyBlock label="Example" text={`export HARBORMASTER_TOKEN=<your token>

# Find cards
curl -s -H "Authorization: Bearer $HARBORMASTER_TOKEN" \\
  "${m.public_url}/api/projects/SS/cards?board=todo&q=zebra"

# Move a card (this is how status changes)
curl -s -X POST -H "Authorization: Bearer $HARBORMASTER_TOKEN" -H "Content-Type: application/json" \\
  -d '{"column":"Done"}' ${m.public_url}/api/cards/SS-42/move

# Comment on a card
curl -s -X POST -H "Authorization: Bearer $HARBORMASTER_TOKEN" -H "Content-Type: application/json" \\
  -d '{"body":"Shipped in abc1234"}' ${m.public_url}/api/cards/SS-42/comments`} />
          </div>
        </div>
        <div className="card-box">
          <div className="hd"><h2>Factory</h2></div>
          <div className="bd small muted">The factory doesn't connect to Harbor Master yet; it still reports to its own dashboard. When it moves in, it will use this same connection, so nothing here changes.</div>
        </div>
        <Tokens base="/api/me/tokens" title="Your connections and tokens" />
      </div>
    </div>
  );
}
