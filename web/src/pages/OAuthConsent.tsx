// /oauth/authorize: an app such as Claude Desktop asks to connect to Harbor Master as you.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox } from '../components/ui';
import { useAuth } from '../lib/auth';

type Info = { client: { name: string; uri: string | null; redirect_host: string }; already_connected: boolean };

const PARAMS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'] as const;

export default function OAuthConsent() {
  const { me } = useAuth();
  const [sp] = useSearchParams();
  const params = Object.fromEntries(PARAMS.flatMap((k) => (sp.get(k) !== null ? [[k, sp.get(k)!]] : [])));
  const info = useQuery({
    queryKey: ['oauth-authorize', sp.toString()],
    queryFn: () => api.get<Info>(`/api/oauth/authorize?${new URLSearchParams(params)}`),
    retry: false,
  });
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const decide = async (decision: 'allow' | 'deny') => {
    setBusy(decision); setErr(null);
    try {
      const r = await api.post<{ redirect: string }>('/api/oauth/authorize', { ...params, decision });
      window.location.assign(r.redirect);
    } catch (e) {
      setErr(e);
      setBusy(null);
    }
  };

  const signOut = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  };

  return (
    <div className="login-wrap">
      <div className="login card-box">
        <div className="bd stack">
          <div className="brand"><span className="logo" aria-hidden="true" /> Harbor Master</div>
          {info.isLoading && <div className="faint">Checking the request…</div>}
          {info.error && (
            <>
              <h2 style={{ margin: 0 }}>Can't connect this app</h2>
              <ErrorBox error={info.error} />
            </>
          )}
          {info.data && (
            <>
              <h2 style={{ margin: 0 }}>Allow <b>{info.data.client.name}</b> to use Harbor Master?</h2>
              <div className="small muted stack-sm">
                <div>It will be able to read and update the projects you can access, with your permissions. Its changes show in history under your name.</div>
                <div>After you allow it, you'll go back to <b className="mono">{info.data.client.redirect_host}</b>. Only continue if you started this from that app.</div>
                {info.data.already_connected && <div>This replaces its existing connection.</div>}
                <div className="faint">You can disconnect it any time from Profile → Claude.</div>
              </div>
              <ErrorBox error={err} />
              <div className="row" style={{ gap: 10 }}>
                <button className="btn primary" disabled={!!busy} onClick={() => decide('allow')}>{busy === 'allow' ? 'Connecting…' : 'Allow'}</button>
                <button className="btn" disabled={!!busy} onClick={() => decide('deny')}>Cancel</button>
              </div>
            </>
          )}
          <div className="small faint">Signed in as {me?.name} ({me?.email}). <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>Not you?</a></div>
        </div>
      </div>
    </div>
  );
}
