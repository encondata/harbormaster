import { useState } from 'react';
import { api } from '../api';
import Tokens from '../components/Tokens';
import { ErrorBox, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { PasswordForm } from './ChangePassword';

export default function Account() {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.name ?? '');
  const [err, setErr] = useState<unknown>(null);
  const toast = useToast();
  if (!me) return null;
  return (
    <>
      <div className="topbar"><h1>Your account</h1></div>
      <div className="page page-narrow">
        <div className="stack">
          <div className="card-box">
            <div className="hd"><h2>Profile</h2></div>
            <div className="bd form-grid">
              <div className="form-grid two">
                <label className="field">Display name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field">Email<input className="input" value={me.email} disabled /></label>
              </div>
              <div className="faint small">Roles: {me.global_roles.map((r) => r.name).join(', ') || 'none'} · last sign-in {dateTime(me.last_login_at)}</div>
              <ErrorBox error={err} />
              <div><button className="btn primary" onClick={async () => { try { await api.patch('/api/auth/me', { name }); refresh(); toast('Saved'); } catch (e) { setErr(e); } }}>Save</button></div>
            </div>
          </div>
          <div className="card-box"><div className="hd"><h2>Change password</h2></div><div className="bd"><PasswordForm /></div></div>
          <Tokens base="/api/me/tokens" title="Your API tokens" showSetup />
        </div>
      </div>
    </>
  );
}
