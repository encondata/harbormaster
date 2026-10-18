# Harbor Master

A self-hosted kanban system for tracking software development, built to replace the
ServerSherpa "BaseCamp V2 to V3 — Feature Parity" Google Sheet. People update it in the
browser; Claude updates it through an MCP endpoint. Every change is recorded with who
made it and how.

## What it does

- **Projects → boards → columns → cards.** Starts with one project, **ServerSherpa (SS)**,
  with three boards that mirror the sheet: **Feature Parity**, **To-Do** and **Future
  Features**. Add more projects and boards any time.
- **Summary page** that reproduces the sheet's Summary tab: parity score, headline counts,
  and the *By area* table (counts per status, parity, priority, expected date, notes).
- **Kanban board** with drag and drop, search and filters, swimlanes by area, a sortable
  table view, quick add, WIP limits and collapsible columns.
- **Cards** with markdown descriptions, per-board custom fields (e.g. *In V2*, *Where it
  lives in V3*, *Notes / gap*), tags, priority, assignee, estimate, due date, comments,
  file attachments (stored in MinIO) and a full change history with field-level diffs.
- **Progress updates**: the sheet's *Weekly Summary* tab, one entry per week.
- **Feature requests** per project: members (and Claude) submit, vote and comment; anyone with
  triage rights reviews them and accepts them into a linked card, declines with a reason, or merges duplicates.
- **Spreadsheet sync**: import or re-sync from the Google Sheet link (or an .xlsx export).
  Re-running only changes what changed in the sheet.
- **Daily Google Sheet export**: each project can copy its summary, boards, weekly updates and
  requests into a Google Sheet every day. Setup: [docs/SHEET-EXPORT.md](docs/SHEET-EXPORT.md).
- **Sign-in** with a password or **Google** (for existing accounts only; see
  [docs/GOOGLE-SIGN-IN.md](docs/GOOGLE-SIGN-IN.md)), with "remember me".
- **Users and permissions**: user admin, global roles (Administrator, Project Creator,
  Auditor), per-project roles (Owner, Editor, Contributor, Viewer), custom roles with any
  mix of permissions, service accounts, API tokens, forced password changes, session
  revocation.
- **Audit log** of every sign-in, failed sign-in, change and admin action, with actor,
  source (web, Claude/MCP, API token, sheet import), token name and client IP.
- **Live updates**: when Claude (or anyone) changes a card, open boards refresh on their own.
- **Claude integration**: an MCP server at `/api/mcp` with tools to find, create, edit and
  move cards, comment, update areas and log weekly progress. See [docs/CLAUDE.md](docs/CLAUDE.md).

## Architecture

```
house reverse proxy ──► web (nginx:alpine, :8080)  ── static React app
                              │ /api/*
                              ▼
                        api (node:22-alpine, Fastify) ──► db (postgres:16-alpine)
                                                      └─► minio (S3, built from source on alpine)
```

| Service | Image | Notes |
|---|---|---|
| `web` | `nginx:1.28-alpine` | Serves the built React app and proxies `/api`. The only published port. |
| `api` | `node:22-alpine` | Fastify + TypeScript. Runs DB migrations and bootstrap on start. |
| `db` | `postgres:16-alpine` | All data. Volume `db-data`. |
| `minio` | built from `minio/Dockerfile` | Attachments. MinIO no longer publishes public images, so the official release is compiled onto Alpine. Volume `minio-data`. |

Code layout:

- `api/` — server. `src/routes` (HTTP), `src/services` (business logic shared by the REST
  API and MCP), `src/mcp.ts` (Claude tools), `migrations/` (SQL, applied automatically).
- `web/` — React + Vite single-page app.
- `minio/` — MinIO build.
- `scripts/smoke-test.sh` — end-to-end check against a running stack.
- `docs/` — deployment and Claude guides.

## Run it locally

Needs Docker Desktop.

```bash
cp .env.example .env
```

Edit `.env`: set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (10+ characters), the two passwords, set
`PUBLIC_URL=http://localhost:8090` and `COOKIE_SECURE=false`, and optionally
`SEED_SHEET_URL` to import the Google Sheet on first start. Then:

```bash
docker compose up -d --build
```

Open http://localhost:8090 and sign in with the admin account. The first build takes a few
minutes (MinIO compiles from source).

`docker-compose.dev.yml` additionally publishes the API on `127.0.0.1:3001` and the MinIO
console on `127.0.0.1:9101`:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

For front-end work with hot reload, run the stack with the dev override, then
`cd web && npm install && npm run dev` (http://localhost:5180, proxies `/api` to :3001).

### Smoke test

```bash
BASE=http://localhost:8090 ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' scripts/smoke-test.sh
```

It creates and then archives a throwaway project, user and token, so run it against a
local or test stack.

## Deploy

See [docs/DEPLOY.md](docs/DEPLOY.md) for the house server: environment, reverse proxy
settings (including Server-Sent Events), backups and upgrades.

## First steps after deploying

1. Sign in as the admin from `.env` and change nothing else there; the admin password in
   `.env` is only used to create the first account.
2. **ServerSherpa → Settings → Sync from the tracking spreadsheet**: paste the Google Sheet
   link, *Preview changes*, then *Sync now* (skip this if `SEED_SHEET_URL` already did it).
3. **Users**: add the team and give each person a role on ServerSherpa.
4. **Users → Claude → New token**: create a token and connect Claude Code with the command
   shown (details in [docs/CLAUDE.md](docs/CLAUDE.md)).
5. Once everyone works in the board, stop syncing from the sheet. A sync overwrites
   sheet-sourced fields and statuses on matched cards.

## Security notes

- Passwords are hashed with Argon2id. Sign-in is rate limited (10 attempts / 5 min / IP)
  and failed attempts are audited.
- Sessions are HttpOnly, SameSite=Lax cookies, `Secure` when `COOKIE_SECURE=true`. Every
  cookie-authenticated write must send an `x-hsl-csrf` header, which cross-site pages cannot.
- API tokens are stored as SHA-256 hashes, shown once, can expire, and can be revoked.
  Tokens cannot create other tokens.
- The Administrator role always holds every global permission, and the system refuses
  changes that would leave nobody able to manage users.
- Attachments are streamed through the API with permission checks; MinIO is not exposed.
