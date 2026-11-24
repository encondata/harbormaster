// Sign in with HackSpaceLabs in the web app (HSL Suite plan 5.9): sign-in options, the auto-redirect
// rule with its loop guard, and where sign-out goes.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export type Providers = {
  google: boolean;
  hsl?: boolean;
  auto_redirect?: boolean;
  portal_url?: string;
  apps?: { id: string; name: string; url: string }[];
};

export const useProviders = () =>
  useQuery({ queryKey: ['auth-providers'], queryFn: () => api.get<Providers>('/api/auth/providers'), staleTime: 300_000 });

export const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/api/') ? n : '/');

export function hslStart(next: string, opts: { prompt?: 'login' } = {}) {
  const p = new URLSearchParams({ next: safeNext(next) });
  if (opts.prompt) p.set('prompt', opts.prompt);
  return `/api/auth/hsl/start?${p}`;
}

const TRY_KEY = 'hsl-sso-try';

/**
 * Sends a signed-out visitor to HackSpaceLabs when auto-redirect is on; returns true if it did. Not for
 * /signed-out, ?local=1 or ?error=…. It won't go twice within 30 seconds: if a sign-in "succeeds" but the
 * session cookie doesn't stick (a Secure cookie on plain HTTP, say), the app would otherwise bounce
 * between here and Keycloak forever. Then it shows the sign-in page with hsl_failed instead.
 */
export function maybeAutoRedirect(p: Providers | undefined, next: string): boolean {
  if (!p?.hsl || !p.auto_redirect) return false;
  const q = new URLSearchParams(window.location.search);
  if (window.location.pathname === '/signed-out' || q.has('local') || q.has('error')) return false;
  let last = 0;
  try { last = Number(sessionStorage.getItem(TRY_KEY) ?? 0); } catch { /* storage blocked: no guard */ }
  if (Date.now() - last < 30_000) {
    window.history.replaceState(null, '', `/login?${new URLSearchParams({ error: 'hsl_failed', next: safeNext(next) })}`);
    return false;
  }
  try { sessionStorage.setItem(TRY_KEY, String(Date.now())); } catch { /* ignore */ }
  window.location.assign(hslStart(next));
  return true;
}

/** Called once a page has loaded signed in. */
export function clearAutoRedirectGuard() {
  try { sessionStorage.removeItem(TRY_KEY); } catch { /* ignore */ }
}

const AFTER_KEY = 'hsl-after-sign-out';

/**
 * Signs out. A HackSpaceLabs session comes back with Keycloak's sign-out address, which ends the session
 * in every HackSpaceLabs app and returns to /signed-out; `then` is remembered for that page's Sign in
 * button. A local session goes to the sign-in page.
 */
export async function signOutAndLeave(then: string = '/', hslOn = false) {
  const r = await api.post<{ ok: boolean; redirect?: string }>('/api/auth/logout').catch(() => null);
  if (r?.redirect) {
    try { sessionStorage.setItem(AFTER_KEY, safeNext(then)); } catch { /* ignore */ }
    window.location.assign(r.redirect);
    return;
  }
  // With HackSpaceLabs on, a plain /login could send this browser straight back there (auto-redirect).
  const p = new URLSearchParams();
  if (then !== '/') p.set('next', then);
  if (hslOn) p.set('local', '1');
  window.location.replace(p.size ? `/login?${p}` : '/login');
}

/** Where the signed-out page's Sign in button returns to (set by signOutAndLeave). */
export function afterSignOut() {
  try { return safeNext(sessionStorage.getItem(AFTER_KEY)); } catch { return '/'; }
}
