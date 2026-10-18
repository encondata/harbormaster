import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const next = sp.get('next');
  return (
    <div className="login-wrap">
      <form className="login card-box" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api.post('/api/auth/login', { email, password });
          await qc.invalidateQueries({ queryKey: ['me'] });
          nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
        } catch (e2) {
          setErr(e2);
        } finally {
          setBusy(false);
        }
      }}>
        <div className="bd stack">
          <div className="brand"><img src="/favicon.svg" alt="" /> Harbor Master</div>
          <label className="field">Email<input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></label>
          <label className="field">Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <ErrorBox error={err} />
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <div className="faint small" style={{ textAlign: 'center' }}>Forgot your password? Ask an administrator to reset it.</div>
        </div>
      </form>
    </div>
  );
}
