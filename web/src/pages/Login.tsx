import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import Mark from '../components/Mark';
import { hslStart, safeNext, useProviders } from '../lib/sso';

const ICON = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

const GOOGLE_ERRORS: Record<string, (email: string) => string> = {
  google_off: () => "Google sign-in isn't set up on this server yet.",
  google_cancelled: () => 'Google sign-in was cancelled.',
  google_failed: () => "Google sign-in didn't complete. Please try again.",
  google_expired: () => 'That sign-in attempt timed out. Please try again.',
  google_unverified: () => "Google says that email address isn't verified, so it can't be used to sign in.",
  google_domain: (e) => `Google accounts from ${e.split('@')[1] ?? 'that domain'} can't sign in here.`,
  google_no_account: (e) => `No Harbor Master account uses ${e || 'that email'}. Ask an administrator to add you, then try again.`,
  google_disabled: () => 'Your account is deactivated. Ask an administrator to reactivate it.',
  google_mismatch: () => 'Your account is linked to a different Google account. Ask an administrator to unlink it.',
  google_hsl: () => 'This account signs in with HackSpaceLabs.',
  hsl_off: () => "HackSpaceLabs sign-in isn't set up on this server yet.",
  hsl_cancelled: () => 'HackSpaceLabs sign-in was cancelled.',
  hsl_failed: () => "HackSpaceLabs sign-in didn't complete. Please try again, or ask an administrator.",
  hsl_expired: () => 'That sign-in attempt took too long or was already used. Please try again.',
  hsl_unavailable: () => "HackSpaceLabs sign-in can't be reached right now. Try again shortly; administrators can use a local account below.",
  hsl_no_access: () => "Your HackSpaceLabs account doesn't have access to Harbor Master. Ask an administrator.",
  hsl_account_exists: () => 'A Harbor Master account already uses the address made for your HackSpaceLabs username. Ask an administrator to link it or remove it.',
  hsl_last_admin: () => "This is the last administrator who can sign in with a password, so it can't be linked to HackSpaceLabs. Ask another administrator to set one up first.",
  hsl_email_taken: () => 'A Harbor Master account already uses your HackSpaceLabs email. Sign in with your password or Google, then link HackSpaceLabs from your Account page.',
  hsl_disabled: () => 'Your account is deactivated. Ask an administrator to reactivate it.',
  hsl_mismatch: () => 'Your account is linked to a different HackSpaceLabs account. Ask an administrator to unlink it.',
};

/** The "Sign in with HackSpaceLabs" button: the H mark, above the local form. */
export function HslButton({ next, prompt }: { next: string; prompt?: 'login' }) {
  return <a className="hsl-auth-button is-sso" href={hslStart(next, { prompt })}><Mark size={20} />Sign in with HackSpaceLabs</a>;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function Login() {
  const [sp] = useSearchParams();
  const next = safeNext(sp.get('next'));
  const googleError = sp.get('error');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [forgot, setForgot] = useState(false);
  const [err, setErr] = useState<string | null>(googleError && GOOGLE_ERRORS[googleError] ? GOOGLE_ERRORS[googleError](sp.get('email') ?? '') : null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const providers = useProviders();
  const googleOn = !!providers.data?.google;
  const googleHref = `/api/auth/google/start?${new URLSearchParams({ next, remember: remember ? '1' : '0' })}`;
  const hslOn = !!providers.data?.hsl;
  // With auto-redirect on, the local form is the way in for administrators when HackSpaceLabs is down.
  const [localWanted, setLocalWanted] = useState(false);
  const showLocal = !hslOn || !providers.data?.auto_redirect || localWanted || sp.has('local') || googleError === 'hsl_unavailable';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setErr('Enter your email and password.');
    setBusy(true);
    setErr(null);
    try {
      await api.post('/api/auth/login', { email, password, remember });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(next, { replace: true });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Sign-in failed');
      setBusy(false);
    }
  };

  return (
    <main className="hsl-auth">
      <div className="hsl-auth-card">
        <div className="hsl-auth-brand"><Mark size={44} /><span className="hsl-wordmark">Harbor Master</span></div>
        <h1 className="hsl-auth-title">Sign in</h1>

        {hslOn && (
          <>
            {!showLocal && err && <p className="hsl-auth-alert" role="alert">{err}</p>}
            <HslButton next={next} />
            {googleError === 'hsl_no_access' && (
              <a className="hsl-auth-link" href={hslStart('/', { prompt: 'login' })}>Use a different HackSpaceLabs account</a>
            )}
            {showLocal
              ? <div className="hsl-auth-divider">or with a Harbor Master password</div>
              : <button type="button" className="hsl-auth-link" onClick={() => setLocalWanted(true)}>Use a local account</button>}
          </>
        )}

        {showLocal && <>
          <form className="hsl-auth-form" noValidate onSubmit={submit}>
            <label className="hsl-auth-field">
              Email
              <input id="login-email" className="hsl-auth-input" type="email" autoComplete="username" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
            </label>

            <label className="hsl-auth-field">
              Password
              <span className="hm-password">
                <input id="login-password" className="hsl-auth-input" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="hm-eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
                  {show
                    ? <svg {...ICON}><path d="M3 3l18 18" /><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 4.5 10 6-.4.6-1.3 1.8-2.6 3M6.6 6.6C4.3 8 2.6 10.3 2 12c1 1.5 5 6 10 6 1.6 0 3.1-.4 4.4-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
                    : <svg {...ICON}><path d="M2 12c1-1.5 5-6 10-6s9 4.5 10 6c-1 1.5-5 6-10 6S3 13.5 2 12z" /><circle cx="12" cy="12" r="3" /></svg>}
                </button>
              </span>
            </label>

            <div className="hm-auth-row">
              <label className="hsl-auth-check"><input id="login-remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember me</label>
              <button type="button" className="hsl-auth-link" aria-expanded={forgot} onClick={() => setForgot((v) => !v)}>Forgot password?</button>
            </div>
            {forgot && (
              <p className="hsl-auth-note hm-auth-box" role="status">
                Harbor Master doesn't send reset emails. Ask an administrator to reset your password: they'll give you a temporary one to sign in with, then you choose your own.
              </p>
            )}
            {err && <p className="hsl-auth-alert" role="alert">{err}</p>}

            <button className="hsl-auth-button is-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>

          <div className="hsl-auth-divider">or</div>

          {googleOn ? (
            <a className="hsl-auth-button" href={googleHref}><GoogleMark /> Sign in with Google</a>
          ) : (
            <>
              <button type="button" className="hsl-auth-button" disabled aria-describedby="google-off"><GoogleMark /> Sign in with Google</button>
              <p id="google-off" className="hsl-auth-note">Google sign-in isn't set up on this server yet.</p>
            </>
          )}
        </>}

        <p className="hsl-auth-note">{hslOn ? 'New here? Sign in with HackSpaceLabs. An administrator then adds you to projects.' : 'Accounts are created by your administrator.'}</p>
      </div>
    </main>
  );
}
