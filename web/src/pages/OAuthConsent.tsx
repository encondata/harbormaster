// /oauth/authorize: an app such as Claude Desktop asks to connect to Harbor Master as you.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox } from '../components/ui';
import { useAuth } from '../lib/auth';
import { signOutAndLeave, useProviders } from '../lib/sso';
import Mark from '../components/Mark';

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

  const providers = useProviders();
  // "Not you?": a HackSpaceLabs session must also end at Keycloak, or it would sign the same person
  // straight back in. Either way the consent request is kept for the next sign-in.
  const signOut = () => signOutAndLeave(window.location.pathname + window.location.search, !!providers.data?.hsl);

  return (
    <main className="hsl-auth">
      <div className="hsl-auth-card">
        <div className="hsl-auth-brand"><Mark size={44} /><span className="hsl-wordmark">Harbor Master</span></div>
        {info.isLoading && <p className="hsl-auth-text">Checking the request…</p>}
        {info.error && (
          <>
            <h1 className="hsl-auth-title">Can't connect this app</h1>
            <ErrorBox error={info.error} />
          </>
        )}
        {info.data && (
          <>
            <h1 className="hsl-auth-title">Allow <b>{info.data.client.name}</b> to use Harbor Master?</h1>
            <div className="small muted stack-sm">
              <div>It will be able to read and update the projects you can access, with your permissions. Its changes show in history under your name.</div>
              <div>After you allow it, you'll go back to <b className="mono">{info.data.client.redirect_host}</b>. Only continue if you started this from that app.</div>
              {info.data.already_connected && <div>This replaces its existing connection.</div>}
              <div>You can disconnect it any time from Account → Claude.</div>
            </div>
            <ErrorBox error={err} />
            <button className="hsl-auth-button is-primary" disabled={!!busy} onClick={() => decide('allow')}>{busy === 'allow' ? 'Connecting…' : 'Allow'}</button>
            <button className="hsl-auth-button" disabled={!!busy} onClick={() => decide('deny')}>Cancel</button>
          </>
        )}
        <p className="hsl-auth-note">Signed in as {me?.name} ({me?.email}). <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>Not you?</a></p>
      </div>
    </main>
  );
}
