// /signed-out: where Keycloak sends the browser after signing out of HackSpaceLabs. Never redirects.
import Mark from '../components/Mark';
import { afterSignOut, hslStart } from '../lib/sso';

export default function SignedOut() {
  return (
    <main className="hsl-auth">
      <div className="hsl-auth-card">
        <div className="hsl-auth-brand"><Mark size={44} /><span className="hsl-wordmark">Harbor Master</span></div>
        <h1 className="hsl-auth-title">You're signed out of HackSpaceLabs</h1>
        <p className="hsl-auth-text">You're signed out of Harbor Master and the other HackSpaceLabs apps.</p>
        <a className="hsl-auth-button is-primary" href={hslStart(afterSignOut())}>Sign in</a>
        <a className="hsl-auth-link" href="/login?local=1">Use a local account</a>
      </div>
    </main>
  );
}
