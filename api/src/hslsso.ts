// Sign in with HackSpaceLabs: a small OpenID Connect client for the HSL Keycloak (authorization code
// with PKCE S256, state and nonce; refresh-token rechecks). It follows the contract in PLAN.md section 5
// of the HSL Suite and mirrors Switchyard's internal/hslsso. It knows nothing about Harbor Master's
// database, so it can be tested on its own.
//
// Discovery is lazy: nothing is fetched until the first sign-in or recheck, a failure is retried on the
// next call, and a working configuration is kept for an hour (and kept beyond that if a refetch fails).
// Harbor Master must never fail to start, or turn sign-in off, because Keycloak was down at start.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { KeysUnavailable, verifyOidcIdToken, type IdClaims } from './oidc.js';

export type SsoConfig = {
  /** Full issuer, e.g. https://auth.hackspacelabs.com/realms/hackspacelabs (no trailing slash). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The app's callback: public URL + /api/auth/hsl/callback. */
  redirectUri: string;
  /** Optional origin for server-to-server calls (discovery, token, keys). Browsers always use the issuer. */
  internalUrl?: string;
  /** Milliseconds since the epoch; for tests. */
  now?: () => number;
};

/**
 * refused: Keycloak definitely ended the session (invalid_grant) or answered for someone else. End it.
 * invalid: an ID token failed verification. End the session or refuse the sign-in.
 * unavailable: anything else (network, timeout, 5xx, invalid_client, discovery, keys). Keep the
 * session and try again after the next interval.
 */
export type SsoErrorKind = 'refused' | 'invalid' | 'unavailable';

export class SsoError extends Error {
  constructor(public kind: SsoErrorKind, message: string) {
    super(message);
  }
}

export type Tokens = {
  claims: IdClaims;
  idToken: string;
  refreshToken: string;
  /** Keycloak's refresh_expires_in in seconds (96 hours, or 30 days with "Remember me"); 0 if absent. */
  sessionSeconds: number;
};

export type Flow = { state: string; nonce: string; verifier: string };

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  code_challenge_methods_supported?: string[];
};

const HOUR = 3600_000;

/** Replaces the scheme, host and port of `raw` with those of `origin`. */
export function withOrigin(raw: string, origin: string) {
  const u = new URL(raw);
  const o = new URL(origin);
  u.protocol = o.protocol;
  u.host = o.host;
  return u.toString();
}

export function newFlow(): Flow {
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url') };
}

/** The claim's roles that the app knows, in the app's order (highest first). A missing claim is []. */
export function knownRoles(claimed: unknown, known: readonly string[]): string[] {
  const list = Array.isArray(claimed) ? claimed.filter((r): r is string => typeof r === 'string') : [];
  return known.filter((k) => list.includes(k));
}

export class HslSso {
  private current: { doc: Discovery; at: number } | null = null;
  private pending: Promise<Discovery> | null = null;
  private readonly now: () => number;

  constructor(private readonly cfg: SsoConfig) {
    this.cfg = { ...cfg, issuer: cfg.issuer.replace(/\/+$/, ''), internalUrl: cfg.internalUrl?.replace(/\/+$/, '') || undefined };
    this.now = cfg.now ?? Date.now;
  }

  get clientId() {
    return this.cfg.clientId;
  }

  /** The discovered endpoints; throws SsoError('unavailable') when there has never been a good copy. */
  async discovery(): Promise<Discovery> {
    if (this.current && this.now() - this.current.at < HOUR) return this.current.doc;
    this.pending ??= this.discover().finally(() => { this.pending = null; });
    try {
      const doc = await this.pending;
      this.current = { doc, at: this.now() };
      return doc;
    } catch (e: any) {
      if (this.current) return this.current.doc;
      throw new SsoError('unavailable', `discovery: ${e?.message ?? e}`);
    }
  }

  private async discover(): Promise<Discovery> {
    const base = this.cfg.internalUrl ? withOrigin(this.cfg.issuer, this.cfg.internalUrl).replace(/\/+$/, '') : this.cfg.issuer;
    const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = (await res.json()) as Discovery;
    if (doc.issuer !== this.cfg.issuer) throw new Error(`issuer is "${doc.issuer}", expected "${this.cfg.issuer}"`);
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('missing endpoints');
    if (doc.code_challenge_methods_supported?.length && !doc.code_challenge_methods_supported.includes('S256')) throw new Error('PKCE S256 not supported');
    if (this.cfg.internalUrl) {
      // Keycloak lists its public addresses whatever address it was asked on; server-to-server calls
      // go to the internal origin. Browser addresses stay public.
      doc.token_endpoint = withOrigin(doc.token_endpoint, this.cfg.internalUrl);
      doc.jwks_uri = withOrigin(doc.jwks_uri, this.cfg.internalUrl);
      if (doc.userinfo_endpoint) doc.userinfo_endpoint = withOrigin(doc.userinfo_endpoint, this.cfg.internalUrl);
    }
    return doc;
  }

  /** Where to send the browser. prompt 'login' asks for the password even if Keycloak has a session. */
  async authUrl(f: Flow, opts: { prompt?: 'login' } = {}) {
    const ep = await this.discovery();
    const params = new URLSearchParams({
      response_type: 'code',
      scope: 'openid profile email',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      state: f.state,
      nonce: f.nonce,
      code_challenge: createHash('sha256').update(f.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    if (opts.prompt === 'login') params.set('prompt', 'login');
    return `${ep.authorization_endpoint}${ep.authorization_endpoint.includes('?') ? '&' : '?'}${params}`;
  }

  private async tokenRequest(form: Record<string, string>, timeoutMs: number) {
    const ep = await this.discovery();
    let res: Response;
    try {
      res = await fetch(ep.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...form, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new SsoError('unavailable', `token endpoint: ${e?.message ?? e}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return { ep, status: res.status, data };
  }

  /** Turns the callback's code into tokens and verifies the ID token, including its nonce. */
  async exchange(code: string, f: Flow): Promise<Tokens> {
    const { ep, status, data } = await this.tokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: f.verifier },
      10_000,
    );
    if (status !== 200) {
      // A 4xx is Keycloak saying no to this code; a 5xx is Keycloak being unwell.
      throw new SsoError(status < 500 ? 'refused' : 'unavailable', `code exchange: HTTP ${status} ${data?.error ?? ''}`.trim());
    }
    return this.tokens(ep, data, { nonce: f.nonce });
  }

  /** Rechecks a session (5-second limit). subject is whose session it is; an answer for anyone else is refused. */
  async refresh(refreshToken: string, subject: string): Promise<Tokens> {
    const { ep, status, data } = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, 5_000);
    if (status === 400 && data?.error === 'invalid_grant') throw new SsoError('refused', `refresh: ${data.error_description ?? 'invalid_grant'}`);
    if (status !== 200) throw new SsoError('unavailable', `refresh: HTTP ${status} ${data?.error ?? ''}`.trim());
    if (!data.refresh_token) data.refresh_token = refreshToken;
    return this.tokens(ep, data, { nonce: false, subject });
  }

  private async tokens(ep: Discovery, data: any, o: { nonce: string | false; subject?: string }): Promise<Tokens> {
    if (typeof data?.id_token !== 'string' || !data.id_token) throw new SsoError('invalid', 'no ID token in the response');
    let claims: IdClaims;
    try {
      claims = await verifyOidcIdToken(data.id_token, {
        jwksUrl: ep.jwks_uri, issuers: [this.cfg.issuer], clientId: this.cfg.clientId, nonce: o.nonce, now: Math.floor(this.now() / 1000),
      });
    } catch (e: any) {
      throw new SsoError(e instanceof KeysUnavailable ? 'unavailable' : 'invalid', e?.message ?? String(e));
    }
    if (o.subject !== undefined && claims.sub !== o.subject) throw new SsoError('refused', 'the session now belongs to someone else');
    const n = Number(data.refresh_expires_in);
    return {
      claims,
      idToken: data.id_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
      sessionSeconds: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    };
  }

  /** Keycloak's sign-out address for this session, coming back to postLogout (registered exactly). */
  async endSessionUrl(idToken: string | null, postLogout: string) {
    const ep = await this.discovery();
    if (!ep.end_session_endpoint) throw new SsoError('unavailable', 'no end_session_endpoint');
    const params = new URLSearchParams({ client_id: this.cfg.clientId, post_logout_redirect_uri: postLogout });
    if (idToken) params.set('id_token_hint', idToken);
    return `${ep.end_session_endpoint}?${params}`;
  }
}

// ---- Sealing the tokens kept with a session (AES-256-GCM) -------------------------------------
// Key = HMAC-SHA256(key = client secret, message = "hsl-session-tokens-v1"). A refresh token is useless
// without the client secret, so deriving the key from it loses nothing.

export type SealedTokens = { sub: string; refresh_token: string; id_token: string };

const sealKey = (secret: string) => createHmac('sha256', secret).update('hsl-session-tokens-v1').digest();

export function sealTokens(secret: string, t: SealedTokens): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(t), 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

/** Throws if the value was not sealed with this secret or was altered. */
export function openTokens(secret: string, sealed: string): SealedTokens {
  if (!sealed?.startsWith('v1.')) throw new Error('unknown sealed-token format');
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  if (raw.length < 29) throw new Error('sealed tokens too short');
  const d = createDecipheriv('aes-256-gcm', sealKey(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const t = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  if (typeof t?.sub !== 'string' || typeof t?.refresh_token !== 'string') throw new Error('sealed tokens incomplete');
  return { sub: t.sub, refresh_token: t.refresh_token, id_token: typeof t.id_token === 'string' ? t.id_token : '' };
}
