import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';

export function PasswordForm({ onDone }: { onDone?: () => void }) {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <form className="stack-sm" onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      if (pw !== pw2) return setErr(new Error('The new passwords do not match'));
      setBusy(true);
      try {
        await api.post('/api/auth/password', { current_password: cur, new_password: pw });
        toast('Password changed. Other sessions were signed out.');
        setCur(''); setPw(''); setPw2('');
        onDone?.();
      } catch (e2) {
        setErr(e2);
      } finally {
        setBusy(false);
      }
    }}>
      <label className="field">Current password<input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
      <label className="field">New password <span className="hint">At least 10 characters</span><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} /></label>
      <label className="field">Confirm new password<input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></label>
      <ErrorBox error={err} />
      <div><button className="btn primary" disabled={busy}>Change password</button></div>
    </form>
  );
}

export default function ChangePassword({ forced }: { forced?: boolean }) {
  const { refresh, me } = useAuth();
  return (
    <div className="login-wrap">
      <div className="login card-box">
        <div className="bd stack">
          <div className="brand"><img src="/favicon.svg" alt="" /> HSL KanBan</div>
          {forced && <div className="warn-box">Welcome{me ? `, ${me.name}` : ''}. Choose a new password before continuing.</div>}
          <PasswordForm onDone={refresh} />
          <a href="#" className="small faint" style={{ textAlign: 'center' }} onClick={async (e) => {
            e.preventDefault();
            await api.post('/api/auth/logout').catch(() => {});
            window.location.href = '/login';
          }}>Sign out</a>
        </div>
      </div>
    </div>
  );
}
