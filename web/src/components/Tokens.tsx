import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Token } from '../api';
import { dateTime, timeAgo } from '../lib/format';
import { Confirm, ErrorBox, Modal } from './ui';

export function ClaudeSetup({ token }: { token: string }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<{ public_url: string }>('/api/meta'), staleTime: Infinity });
  const origin = meta.data?.public_url ?? window.location.origin;
  return (
    <div className="stack-sm small">
      <div><b>Connect Claude Code</b> (run once on the machine where you use Claude):</div>
      <div className="secret">claude mcp add --transport http --scope user harbormaster {origin}/api/mcp --header "Authorization: Bearer {token}"</div>
      <div className="faint">Or call the REST API directly with the header <span className="mono">Authorization: Bearer {token.slice(0, 16)}…</span>. See docs/CLAUDE.md in the repository.</div>
    </div>
  );
}

export default function Tokens({ base, title = 'API tokens', showSetup }: { base: string; title?: string; showSetup?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tokens', base], queryFn: () => api.get<Token[]>(base) });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Token | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">{title}</h2><button className="btn sm" onClick={() => { setCreating(true); setCreated(null); setName(''); setDays(''); }}>New token</button></div>
      <div className="bd stack-sm">
        <div className="faint small">Tokens let Claude or scripts act as this account. Everything done with a token is recorded in the audit log with the token's name.</div>
        {(q.data ?? []).map((t) => {
          const expired = t.expires_at && new Date(t.expires_at) < new Date();
          return (
            <div key={t.id} className="row small" style={{ opacity: t.revoked_at || expired ? 0.55 : 1 }}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{t.name} <span className="mono faint">hsl_{t.prefix}_…</span></div>
                <div className="faint">Created {dateTime(t.created_at)} · last used {timeAgo(t.last_used_at)}{t.expires_at ? ` · expires ${dateTime(t.expires_at)}` : ''}</div>
              </div>
              {t.revoked_at ? <span className="badge">Revoked</span> : expired ? <span className="badge">Expired</span> : <button className="btn sm danger" onClick={() => setRevoke(t)}>Revoke</button>}
            </div>
          );
        })}
        {!q.data?.length && <div className="faint small">No tokens.</div>}
      </div>
      {creating && (
        <Modal title={created ? 'Token created' : 'New API token'} onClose={() => setCreating(false)} footer={created ? <button className="btn primary" onClick={() => setCreating(false)}>Done</button> : (
          <><button className="btn" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn primary" disabled={!name.trim()} onClick={async () => {
              try {
                const r = await api.post<{ token: string }>(base, { name: name.trim(), expires_in_days: days ? Number(days) : null });
                setCreated(r.token);
                qc.invalidateQueries({ queryKey: ['tokens', base] });
              } catch (e) { setErr(e); }
            }}>Create token</button></>
        )}>
          {created ? (
            <div className="stack-sm">
              <div className="warn-box">Copy this token now. It is shown only once.</div>
              <div className="secret">{created}</div>
              <div><button className="btn sm" onClick={() => navigator.clipboard?.writeText(created)}>Copy</button></div>
              {showSetup && <ClaudeSetup token={created} />}
            </div>
          ) : (
            <div className="form-grid">
              <label className="field">Name <span className="hint">Where it is used, e.g. "Claude Code on Jimmy's laptop"</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
              <label className="field">Expires after (days) <span className="hint">Leave blank for no expiry</span><input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></label>
              <ErrorBox error={err} />
            </div>
          )}
        </Modal>
      )}
      {revoke && <Confirm title={`Revoke "${revoke.name}"?`} danger confirmLabel="Revoke" body="Anything using this token stops working immediately." onClose={() => setRevoke(null)}
        onConfirm={async () => { await api.del(`${base}/${revoke.id}`); qc.invalidateQueries({ queryKey: ['tokens', base] }); }} />}
    </div>
  );
}
