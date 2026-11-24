// /signed-out: where Keycloak sends the browser after signing out of HackSpaceLabs. Never redirects.
import Mark from '../components/Mark';
import { afterSignOut, hslStart } from '../lib/sso';

export default function SignedOut() {
  return (
    <div className="login-wrap">
      <div className="login card-box">
        <div className="bd stack">
          <div className="brand"><Mark className="logo" /> Harbor Master</div>
          <h2 style={{ margin: 0 }}>You're signed out of HackSpaceLabs</h2>
          <div className="small muted">You're signed out of Harbor Master and the other HackSpaceLabs apps.</div>
          <div className="row" style={{ gap: 10 }}>
            <a className="btn primary" href={hslStart(afterSignOut())}>Sign in</a>
            <a className="btn ghost" href="/login?local=1">Use a local account</a>
          </div>
        </div>
      </div>
    </div>
  );
}
