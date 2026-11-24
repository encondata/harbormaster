// Harbor Master's side of Sign in with HackSpaceLabs that the rest of the API needs: whether it is on,
// the Keycloak client, the session recheck (HSL Suite plan 5.7), the owner check for personal tokens
// (D18) and the role rule. The sign-in routes themselves are in routes/hsl-auth.ts.
import { createHash } from 'node:crypto';
import { audit } from './audit.js';
import type { Ctx } from './auth.js';
import { config } from './config.js';
import { one, q, type Db } from './db.js';
import { HslSso, knownRoles, openTokens, sealTokens, SsoError, type SealedTokens, type Tokens } from './hslsso.js';
import { OwnerCheck } from './owner-check.js';

/** Harbor Master's roles on its Keycloak client, highest first. */
export const HSL_ROLES = ['admin', 'member'] as const;

type Logger = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
let log: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const h = config.hsl;
const anySet = !!(h.issuer || h.clientSecret);
const complete = !!(h.issuer && h.clientId && h.clientSecret && config.publicUrl);

export const hslEnabled = () => complete;
export const hslRedirectUri = () => `${config.publicUrl}/api/auth/hsl/callback`;

export const sso: HslSso | null = complete
  ? new HslSso({ issuer: h.issuer, clientId: h.clientId, clientSecret: h.clientSecret, redirectUri: hslRedirectUri(), internalUrl: h.internalUrl || undefined })
  : null;

export const ownerCheck: OwnerCheck | null = complete && h.portalInternalUrl
  ? new OwnerCheck({ portalUrl: h.portalInternalUrl, secret: h.clientSecret, appId: h.clientId, roles: HSL_ROLES, warn: (m, extra) => log.warn(extra ?? {}, m) })
  : null;

/** Called once at start with the app's logger. Says what is on; never contacts Keycloak. */
export function startHsl(logger: Logger) {
  log = logger;
  if (anySet && !complete) {
    log.error({}, 'HackSpaceLabs sign-in is OFF: HSL_OIDC_ISSUER, HSL_OIDC_CLIENT_ID, HSL_OIDC_CLIENT_SECRET and PUBLIC_URL must all be set');
  } else if (complete) {
    log.info({ issuer: h.issuer, autoRedirect: h.autoRedirect, recheckSeconds: h.recheckSeconds }, 'HackSpaceLabs sign-in is on');
    if (!ownerCheck) log.info({}, 'HackSpaceLabs owner check for API tokens is off: HSL_PORTAL_INTERNAL_URL is not set');
  }
}

export const sealFor = (t: SealedTokens) => sealTokens(h.clientSecret, t);
export const openSealed = (s: string) => openTokens(h.clientSecret, s);

/** Keycloak's session lifetime from a token response; 96 hours when it didn't say. */
export const sessionSeconds = (t: Tokens) => (t.sessionSeconds > 0 ? t.sessionSeconds : 96 * 3600);

export const userCtx = (u: { id: string; name: string; email: string }, ip: string | null, sessionId: string | null = null): Ctx => ({
  user: { id: u.id, email: u.email, name: u.name, kind: 'human', must_change_password: false },
  via: 'web', ip, tokenId: null, sessionId, global: new Set(), projectPerms: new Map(),
});

/**
 * The HackSpaceLabs `admin` role adds Harbor Master's built-in Administrator role when the person lacks
 * it. Nothing is ever removed: Harbor Master's own roles and project memberships are managed here.
 */
export async function applyHslRole(u: { id: string; name: string; email: string }, roles: string[], ip: string | null, db?: Db) {
  if (!roles.includes('admin')) return;
  const added = await one(
    `insert into user_roles (user_id, role_id) select $1, id from roles where scope = 'global' and name = 'Administrator'
     on conflict do nothing returning role_id`,
    [u.id],
    db,
  );
  if (added) {
    await audit(userCtx(u, ip), { action: 'user.updated', entityType: 'user', entityId: u.id, summary: `Gave ${u.name} the Administrator role (HackSpaceLabs admin)` }, db);
  }
}

/** Can someone owning a token with this HackSpaceLabs link still use it? (D18; true when the check is off.) */
export async function tokenOwnerAllowed(hslSub: string | null | undefined) {
  if (!hslSub || !ownerCheck) return true;
  return ownerCheck.allowed(hslSub);
}

// ---- Recheck --------------------------------------------------------------------------------

export type HslSessionRow = {
  sid: string;
  userId: string;
  name: string;
  email: string;
  hslSub: string | null;
  sealed: string | null;
  checkedAt: Date | null;
  ip: string | null;
};

const rechecking = new Set<string>();

async function endSession(r: HslSessionRow, why: string) {
  log.info({ user: r.name, reason: why }, 'HackSpaceLabs session ended');
  await q(`delete from sessions where id = $1`, [r.sid]);
  await audit(userCtx({ id: r.userId, name: r.name, email: r.email }, r.ip), {
    action: 'auth.session_ended', entityType: 'user', entityId: r.userId, summary: `Ended ${r.name}'s HackSpaceLabs session: ${why}`,
  }).catch(() => {});
  return 'ended' as const;
}

/**
 * Confirms a HackSpaceLabs session with Keycloak when it is due and applies the answer. 'ended' means
 * the session was deleted and the request must be treated as signed out. An unreachable Keycloak keeps
 * the session; the next attempt waits a full interval.
 */
export async function recheckSession(r: HslSessionRow): Promise<'ok' | 'ended'> {
  // Sign-in turned off by configuration: nothing can recheck this session any more.
  if (!sso) return endSession(r, 'HackSpaceLabs sign-in is turned off');
  if (r.checkedAt && Date.now() - new Date(r.checkedAt).getTime() < h.recheckSeconds * 1000) return 'ok';
  // One recheck per session at a time in this process; other requests carry on with what we have.
  if (rechecking.has(r.sid)) return 'ok';
  rechecking.add(r.sid);
  try {
    let stored: SealedTokens;
    try {
      stored = openSealed(r.sealed ?? '');
    } catch {
      return await endSession(r, 'stored tokens unreadable');
    }
    if (!r.hslSub || r.hslSub !== stored.sub) return await endSession(r, 'the HackSpaceLabs link was removed');
    let t: Tokens;
    try {
      t = await sso.refresh(stored.refresh_token, stored.sub);
    } catch (e) {
      if (e instanceof SsoError && e.kind !== 'unavailable') return await endSession(r, e.message);
      log.warn({ user: r.name, err: e instanceof Error ? e.message : String(e) }, "couldn't recheck a HackSpaceLabs session; keeping it");
      await q(`update sessions set idp_checked_at = now() where id = $1`, [r.sid]);
      return 'ok';
    }
    const roles = knownRoles(t.claims.hsl_roles, HSL_ROLES);
    if (!roles.length) return await endSession(r, 'no Harbor Master role');
    await applyHslRole({ id: r.userId, name: r.name, email: r.email }, roles, r.ip);
    const username = (t.claims.preferred_username ?? '').trim().slice(0, 255);
    if (username) await q(`update users set hsl_username = $2 where id = $1 and hsl_username is distinct from $2`, [r.userId, username]).catch(() => {});
    await q(
      `update sessions set idp_tokens = $2, idp_sid = coalesce($3, idp_sid), idp_checked_at = now(), expires_at = now() + make_interval(secs => $4) where id = $1`,
      [r.sid, sealFor({ sub: stored.sub, refresh_token: t.refreshToken, id_token: t.idToken }), t.claims.sid ?? null, sessionSeconds(t)],
    );
    return 'ok';
  } finally {
    rechecking.delete(r.sid);
  }
}

/** Where the browser goes after signing out of a HackSpaceLabs session (Keycloak's sign-out, or /signed-out). */
export async function endSessionRedirect(sealed: string | null) {
  if (!sso) return '/signed-out';
  let idToken: string | null = null;
  try {
    idToken = openSealed(sealed ?? '').id_token || null;
  } catch {
    idToken = null;
  }
  try {
    return await sso.endSessionUrl(idToken, `${config.publicUrl}/signed-out`);
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "couldn't build the HackSpaceLabs sign-out address");
    return '/signed-out';
  }
}

export const stateHash = (s: string) => createHash('sha256').update(s).digest('hex');
