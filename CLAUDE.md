# Harbor Master — notes for working on this repo

Kanban/progress tracker that replaces the ServerSherpa feature-parity Google Sheet. See
README.md for features and architecture, docs/DEPLOY.md for the server, docs/CLAUDE.md for
the MCP integration.

## Layout

- `api/` Fastify + TypeScript (ESM, imports end in `.js`). `src/services/*` hold all business
  logic and permission checks; `src/routes/*` and `src/mcp.ts` are thin layers over them, so
  REST and MCP behave the same. Every write goes through a service that calls `audit()` and
  `publish()` (live updates).
- `api/migrations/NNN_name.sql` run in order at startup. Never edit an applied migration; add
  a new file.
- `web/` React 19 + Vite + TanStack Query. Styles are plain CSS tokens in `src/styles.css`
  (light/dark). API types live in `src/api.ts`.
- Permissions: catalog in `api/src/permissions.ts`. Global permissions come from user roles,
  project permissions from the membership role. Built-in roles are inserted only if missing,
  so a new permission must also be granted to existing built-in roles in a migration.

## Checks

```bash
cd api && npx tsc --noEmit -p .
cd web && npx tsc -b && npx vite build
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
BASE=http://localhost:8090 ADMIN_EMAIL=… ADMIN_PASSWORD=… scripts/smoke-test.sh
```

The smoke test signs in three times; sign-in is limited to 10 tries per 5 minutes per IP
(restart the api container to reset while developing). On macOS, build JSON for curl with
`jq -n` rather than escaped strings inside `"$(...)"` (bash 3.2 mangles them).
