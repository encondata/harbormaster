# Dev environment and Harbor Master plan

Summary of the decisions and recommendations from the 18 Oct 2026 planning discussion.
Items marked **(confirm)** are recommendations still waiting on a decision.

## Where things stand

- **Harbor Master** works: kanban boards, sheet import, users/roles/audit, MCP for Claude.
  Code is on branch `feature/kanban-mvp`, PR https://github.com/encondata/harbormaster/pull/1.
  It runs locally on the desktop Mac at http://localhost:8090 and is not deployed yet.
- Work happens on two Macs (laptop and desktop), each with its own repo copies and Claude
  setup. Repos are public on GitHub to avoid logging in everywhere.
- Prod runs on a home Docker host behind Nginx Proxy Manager and Cloudflare, reached over VPN.

## Decisions

### 1. One Linux dev machine (the devbox)
- New **Ubuntu 24.04 VM on the VMware server** (about 8 vCPU, 32 GB RAM, 200+ GB disk).
  Not on the prod Docker host: Claude runs with bypass permissions and must stay away from prod.
- Holds every repo, `node_modules`, local Docker stacks, Claude Code, skills, MCP servers,
  and later the factory runner.
- **The Macs become clients.** Use the Claude desktop app's **SSH sessions** (the session runs
  on the devbox and keeps running if the laptop sleeps; it uses the devbox's skills and MCP).
  Add **Remote Control** (`claude remote-control` as a service) for browser/phone access via
  claude.ai/code. No tmux needed.
- Verify on first connect: skills, factory agents (`~/.claude/agents`) and the harbormaster MCP
  server all load in an SSH session (agents loading is not confirmed in the docs).

### 2. iOS and Android
- **iOS stays on the desktop Mac mini** (512 GB). Lower priority. Simplest: keep the iOS repo
  there and open Claude sessions on the mini (as an SSH host) for iOS work. Installs to the iPad
  work when it is on USB or paired for network debugging on the home LAN; away from home use
  TestFlight. Signing over SSH needs the login keychain unlocked (one-time setup).
- The spare 256 GB Mac mini is not used.
- **Android** builds run on the devbox; installs go over wireless debugging, or through the
  Mac mini's USB with `adb`. Emulator runs on the Mac mini.

### 3. Dotfiles repo for Claude and tooling
- Private repo with `~/.claude/` (skills incl. factory, agents, global CLAUDE.md, settings,
  hooks), `mcp.sh` (registers MCP servers with `--scope user`) and `bootstrap.sh` (packages,
  Node, Docker, gh, Claude Code, links dotfiles). Rebuilding a dev machine becomes one command.
- No secrets in it.

### 4. GitHub
- **Make repos private (confirm)**: log in once on the devbox with `gh auth login`. Macs no
  longer need clones or credentials.
- The prod box pulls with a **read-only deploy key per repo**.

### 5. SSH
- Keys only, everywhere: `PasswordAuthentication no`, `PermitRootLogin no`, optionally `AllowUsers`.
- One ed25519 key per person per machine, never copied; passphrase + Keychain or 1Password SSH agent.
- No agent forwarding to the devbox; the devbox has its own keys.
- Automation keys limited with `from="<VPN/LAN range>"`, `command="…"`, `restrict`.
- Deploys run as a dedicated user (docker group = root-equivalent, so that user does nothing else).
- Short host names in `~/.ssh/config`: `devbox`, `prod`, `macmini`.

### 6. Secrets / `.env`
- Each repo commits `.env.example`; the real `.env` is git-ignored and stays on the machine it
  belongs to. **Never copy the dev `.env` to prod.**
- Prod `.env` lives only at `/srv/apps/<app>/.env` on the prod box (`chmod 600`).
  - First deploy: the runner creates it from `.env.example`, generates passwords/keys, fills
    values from the app manifest, and lists anything you must enter once.
  - Every deploy: compare against `.env.example` and stop if a variable is missing.
- Later: Harbor Master stores prod settings encrypted, editable in the UI with audit and masking.

### 7. Harbor Master: one dashboard for all dev work
Harbor Master grows into the central manager: **work** (kanban), **build** (factory),
**ship** (deploys), **run** (proxy, DNS, health).
- **Runners**: small agents on the devbox (factory/Claude jobs) and the prod box (deploy,
  rollback, backup, proxy/DNS). They long-poll Harbor Master over HTTPS with a runner token and run
  only a fixed set of scripts. Harbor Master never holds SSH keys or a shell on servers.
- **Factory merges in**: `factoryctl` reports to Harbor Master instead of the separate factory
  dashboard server; job stages, reviews and Approve / Rework / Reject appear on the card;
  `/factory next` takes the top card of a "Ready for factory" column; later an Execute button
  queues a card for the devbox runner.
- Harbor Master is reachable over the VPN only (Cloudflare Access if it is ever exposed).
- New permissions such as `deploy.run`, `factory.execute`; everything audited.

### 8. Standard app template and manifest
Every web app is Alpine web + Alpine API + MinIO + Postgres. Each repo carries `devhub.yml`:

```yaml
app: harbormaster
domains: [kanban.example.com]
web: { service: web, port: 8080 }
health: /api/health
backup: { postgres: true, minio: true }
env_template: .env.example
```

Harbor Master assigns host ports, creates proxy sites and DNS, knows backups and health checks.
New apps start from a template repo based on the Harbor Master skeleton.

### 9. Deploy pipeline
1. Preflight: commit is on GitHub, branch merged, CI green (once CI exists), no deploy running.
2. Backup: `pg_dump` + MinIO snapshot tagged with the release.
3. Pull the exact commit and `docker compose up -d --build` (migrations run at API start).
   Later: build images on the devbox or in CI and have prod pull them.
4. Ensure the proxy site and DNS record.
5. Health check through the public hostname.
6. Record who/what/log/result. One-click rollback to the previous commit (restore backup if needed).

### 10. Reverse proxy: replace Nginx Proxy Manager with Caddy
- NPM has no official API; automating it is fragile.
- Caddy: one generated file per site (`/etc/caddy/sites/<app>.caddy`), `caddy validate` then
  graceful reload. Automatic HTTPS: obtains and renews certificates by itself.
- Build a custom Caddy image with the **Cloudflare DNS plugin** so certificates use the DNS
  check (no open ports needed, works for VPN-only hosts and wildcards).
- Persist Caddy's `/data` volume (certificates; avoids Let's Encrypt rate limits).
- `flush_interval -1` on sites that stream (live board updates).
- Alternative if apps and proxy share one Docker host: caddy-docker-proxy (labels in compose).

### 11. Cloudflare (confirm one)
- **A. DNS + port forwarding** (closest to today): `home.example.com` A record kept current by a
  dynamic-DNS job; each app is a CNAME to it; Cloudflare SSL mode **Full (strict)**; API token
  limited to DNS edit for the zone.
- **B. Cloudflare Tunnel** (recommended to evaluate): `cloudflared` connects out, no open ports
  and no WAN IP tracking; deploys add hostname routes via API; 100 MB upload limit per request
  on the free plan; makes Cloudflare Access easy.

### 12. Users and permissions for Harbor Master
Builds on what Harbor Master already has (users, global and project roles, custom roles, API
tokens, service accounts, audit log). Only the user (Jimmy) logs in for now.

New permissions:
- Factory (per project): `factory.view`, `factory.queue` (send, reorder, remove),
  `factory.decide` (approve / rework / reject; approving merges code).
- Releases (per project): `release.view`, `release.deploy`, `release.rollback`,
  `settings.view` and `settings.edit` (production `.env`, values masked without edit).
- Infrastructure (global): `infra.view`, `infra.manage` (domains, DNS, proxy, restarts),
  `runners.manage`.

Roles: Owner, Developer (no deploys), Releaser (Developer + deploy/rollback), Viewer,
Administrator (global), **Claude** service account (board, queue factory jobs, comment,
log progress, **deploy and roll back**; never decides factory jobs or edits production
settings), and one **Runner** service account per machine (only its own jobs).

Security settings (Administration → Security), each a toggle:
- **Require two-factor sign-in** (authenticator app), off by default. When on, it applies to
  everyone with a deploy, settings or infrastructure permission (option: everyone).
- **Block approving your own factory jobs**: whoever queued a job cannot approve it. Off by
  default. Claude can never approve, regardless of this toggle.
- **Re-confirm risky actions** (deploy, rollback, settings, DNS) after 15 minutes signed in.

Profile page (`/me`) for every person:
- Profile: display name, email (read-only; admins change it), **avatar**.
- Password change (signs out other devices).
- Two-factor: set up with an authenticator app (QR + 6-digit code), backup codes, turn off.
- Signed-in devices with "sign out other devices".
- Personal API tokens (create, revoke).
- Preferences: theme (system / light / dark), start page.

Avatars:
- PNG, JPG or WebP up to 2 MB; the API checks the real file type, strips metadata, crops to
  a square and stores a 256 px WebP in MinIO (`avatars/<user-id>.webp`), served through the
  API with caching. Initials on a colored circle when there is no photo.
- Shown in the sidebar, Users list, card assignees, comments, history and audit entries.
- Service accounts (Claude, runners) get a fixed icon; admins can set their avatar.

Always on: scoped API tokens (allowed permissions + optional project), separate rotatable
runner tokens with last-seen time, audit of every action, production `.env` values never
written to the audit log (only which keys changed).

## Build order

1. **Devbox**: VM, SSH keys and `sshd_config`, dotfiles repo + bootstrap, Claude Code with
   skills/MCP, connect from both Macs through the desktop app. Move Harbor Master first and use it
   for a week.
2. **Deploy Harbor Master** to the prod box (manually, per docs/DEPLOY.md) so the board is live.
3. **Factory into Harbor Master**: replace the factory dashboard API, cards show jobs, `/factory next`
   reads the board.
4. **Apps and deploys**: manifest, prod runner, deploy / rollback / backup with live logs,
   health checks, deploy history, prod `.env` handling, the new factory/release/infra
   permissions and the Security toggles (two-factor, self-approval block, re-confirm).
5. **Caddy + Cloudflare**: migrate sites off Nginx Proxy Manager; proxy and DNS steps in deploys.
6. **Execute from a card** via the devbox runner.
7. Later: private repos everywhere, CI-built images, staging, uptime alerts, scheduled backups
   and restore tests, encrypted prod settings in Harbor Master.

## Answered (Oct 18)

0. **Name: Harbor Master** (repo `encondata/harbormaster`). "Phabricator" is kept in reserve as a
   name for a later project.

1. **Nginx Proxy Manager is on a different machine from the app containers.** So the proxy is
   configured with generated Caddy site files (one per app) pushed by the runner on the proxy
   host, not caddy-docker-proxy labels. Sites point at `prod-box:<port>`.
2. **Cloudflare records are DNS-only and 80/443 are not forwarded today.**
3. **Use port forwarding (option A), not a tunnel.** To do: forward 80/443 to the proxy host,
   keep a `home.example.com` A record current with a dynamic-DNS job, point app hostnames at it
   with CNAMEs. Caddy gets certificates with the Cloudflare DNS check (works before and after
   forwarding, and for VPN-only hosts). Records stay DNS-only unless we decide otherwise.
4. **The factory dashboard server and its code are on this Mac** (the desktop Mac mini). Find and
   read it before step 3 so `factoryctl` keeps working while it moves into Harbor Master.

Steps 3-5 of the build order (devbox, deploying Harbor Master, factory merge) are scheduled for later.

## Open questions

5. Staging environment now, or straight to prod with rollback?
6. Secrets manager in use (1Password, Bitwarden, none)?
7. Go private on GitHub now (needed before step 4's deploy keys)?


## Tomorrow, first session

- Answer the open questions above (1-4 shape the design most).
- Create the Ubuntu VM; set up keys and `sshd_config`; install Docker, gh, Node, Claude Code.
- Start the dotfiles repo from the desktop Mac's `~/.claude` (skills, agents, settings).
- Connect the Claude desktop app to the devbox over SSH and confirm skills, agents and MCP load.
- Merge PR #1 (or keep reviewing), clone Harbor Master on the devbox and run it there.
