// Personal API tokens and Claude connector tokens of people tied to HackSpaceLabs (HSL Suite plan, D18).
// A token works without any Keycloak session, so for an owner with a HackSpaceLabs link Harbor Master
// asks the portal, at most every five minutes per owner, whether that person is still enabled and still
// holds a Harbor Master role:
//
//   GET <HSL_PORTAL_INTERNAL_URL>/internal/apps/harbormaster/owners/<Keycloak sub>
//   Authorization: Bearer <HSL_OIDC_CLIENT_SECRET>
//   200 {"enabled": bool, "roles": [...]}   400 malformed id   503 Keycloak can't answer
//   404 wrong secret, unknown app, or the request came through a proxy
//
// Outage (503, 5xx, network error, timeout): keep the last answer (allow if there is none) and log a
// warning; the next try waits a full interval. 400 and 404 are refusals: 404 means this server is
// misconfigured (wrong address or secret), and failing open would silently switch the check off.

export type OwnerCheckConfig = {
  /** Portal gateway origin, called directly (never through the public proxy). */
  portalUrl: string;
  /** This app's Keycloak client secret, which the portal checks. */
  secret: string;
  appId: string;
  /** Roles that give access, e.g. ['admin', 'member']. */
  roles: readonly string[];
  intervalMs?: number;
  now?: () => number;
  warn?: (msg: string, extra?: Record<string, unknown>) => void;
};

type Entry = { at: number; allowed: boolean };

export class OwnerCheck {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<boolean>>();
  private readonly interval: number;
  private readonly now: () => number;

  constructor(private readonly cfg: OwnerCheckConfig) {
    this.interval = cfg.intervalMs ?? 5 * 60_000;
    this.now = cfg.now ?? Date.now;
  }

  /** Whether tokens owned by this Keycloak account may be used now. */
  async allowed(sub: string): Promise<boolean> {
    const hit = this.cache.get(sub);
    if (hit && this.now() - hit.at < this.interval) return hit.allowed;
    let p = this.inflight.get(sub);
    if (!p) {
      p = this.ask(sub, hit).finally(() => this.inflight.delete(sub));
      this.inflight.set(sub, p);
    }
    return p;
  }

  /** Forget an owner's answer (for example after they were unlinked). */
  forget(sub: string) {
    this.cache.delete(sub);
  }

  private async ask(sub: string, previous: Entry | undefined): Promise<boolean> {
    const keep = (why: string) => {
      const allowed = previous?.allowed ?? true;
      this.cfg.warn?.('HackSpaceLabs owner check unavailable; keeping the last answer', { why, allowed });
      this.cache.set(sub, { at: this.now(), allowed });
      return allowed;
    };
    const decide = (allowed: boolean) => {
      this.cache.set(sub, { at: this.now(), allowed });
      return allowed;
    };
    let res: Response;
    try {
      res = await fetch(`${this.cfg.portalUrl.replace(/\/+$/, '')}/internal/apps/${encodeURIComponent(this.cfg.appId)}/owners/${encodeURIComponent(sub)}`, {
        headers: { authorization: `Bearer ${this.cfg.secret}`, accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
        redirect: 'manual',
      });
    } catch (e: any) {
      return keep(e?.name === 'TimeoutError' ? 'timeout' : `network: ${e?.message ?? e}`);
    }
    if (res.status === 200) {
      const body: any = await res.json().catch(() => null);
      if (!body || typeof body.enabled !== 'boolean' || !Array.isArray(body.roles)) return keep('unreadable answer');
      return decide(body.enabled && body.roles.some((r: unknown) => typeof r === 'string' && this.cfg.roles.includes(r)));
    }
    if (res.status === 400) return decide(false);
    if (res.status === 404) {
      this.cfg.warn?.('HackSpaceLabs owner check refused by the portal (404): check HSL_PORTAL_INTERNAL_URL and HSL_OIDC_CLIENT_SECRET');
      return decide(false);
    }
    return keep(`HTTP ${res.status}`);
  }
}
