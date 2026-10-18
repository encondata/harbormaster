# Deploying on the house server

The stack runs with Docker Compose. Only the `web` container publishes a port; the house
reverse proxy forwards a hostname to it and handles TLS.

## 1. Prepare the server

- Docker Engine 24+ with the Compose plugin.
- About 1 GB of RAM free and a few GB of disk for images, the database and attachments.
- The server needs outbound internet during the first build (npm, Go modules, MinIO
  source) and for Google Sheet syncs.

```bash
git clone https://github.com/encondata/harbormaster.git
cd harbormaster
cp .env.example .env
```

## 2. Configure `.env`

| Variable | Set to |
|---|---|
| `WEB_PORT` | Host port for the reverse proxy to target, e.g. `8090`. |
| `PUBLIC_URL` | The URL people use, e.g. `https://kanban.example.com`. |
| `COOKIE_SECURE` | `true` when the proxy serves HTTPS (it should). |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | First administrator. Used only when no users exist yet. |
| `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` | Long random values. Generate with `openssl rand -base64 30`. |
| `SEED_SHEET_URL` | Optional. The Google Sheet link, imported into ServerSherpa on first start. |
| `TRUST_PROXY_HOPS` | `2` (nginx in the web container + the house proxy). `1` if nothing sits in front of `web`. |
| `MAX_UPLOAD_MB` | Attachment size limit (default 25). |
| `TIMEZONE` | Time zone for scheduled jobs such as the daily sheet export, e.g. `America/Chicago`. |

Keep `.env` out of git (it is ignored) and readable only by the deploy user:
`chmod 600 .env`.

## 3. Start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

The first build compiles MinIO and takes several minutes. On first start the API applies
migrations, creates the bucket, the administrator, a **Claude** service account and the
**ServerSherpa** project, then imports `SEED_SHEET_URL` if set.

Check health from the server: `curl -s http://127.0.0.1:${WEB_PORT}/api/health`.

## 4. Reverse proxy

Point the hostname at `http://<server>:<WEB_PORT>`. Requirements:

- Pass `Host` and append to `X-Forwarded-For`; set `X-Forwarded-Proto`.
- **Do not buffer** `/api/projects/*/events` (Server-Sent Events, used for live board
  updates) and allow long-lived connections (an hour is fine; the app sends a keep-alive
  every 25 seconds and reconnects on its own).
- Allow request bodies at least as large as `MAX_UPLOAD_MB`.

**nginx**

```nginx
server {
  server_name kanban.example.com;
  # listen 443 ssl; ssl_certificate ...; ssl_certificate_key ...;
  client_max_body_size 30m;

  location / {
    proxy_pass http://192.168.1.50:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

**Caddy**

```caddy
kanban.example.com {
  reverse_proxy 192.168.1.50:8090 {
    flush_interval -1
  }
}
```

**Traefik** (labels on a router to the host service) needs no special settings for SSE;
just make sure no buffering middleware is attached.

**Nginx Proxy Manager**: add a proxy host to the server and port, enable *Websockets
Support* (harmless here) and, under *Advanced*, add `proxy_buffering off;`.

If audit entries show the proxy's IP instead of real client IPs, adjust
`TRUST_PROXY_HOPS` to the number of proxies in front of the API (nginx in `web` counts
as one).

## 5. Backups

Everything lives in two volumes: `harbormaster_db-data` and `harbormaster_minio-data`.

Database (nightly cron):

```bash
docker compose exec -T db pg_dump -U harbormaster -Fc harbormaster > backups/harbormaster-$(date +%F).dump
```

Restore:

```bash
docker compose exec -T db pg_restore -U harbormaster -d harbormaster --clean --if-exists < backups/harbormaster-YYYY-MM-DD.dump
```

Attachments:

```bash
docker run --rm -v harbormaster_minio-data:/data -v "$PWD/backups":/out alpine tar czf /out/minio-$(date +%F).tgz -C /data .
```

## 6. Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations run automatically when the API starts. Built-in roles are created if missing
but never overwritten, so permission changes you make to them survive upgrades.

## 7. Operations

- **Locked out?** Any administrator can reset passwords under *Users*. From the server
  console you can also reset any password or grant Administrator:

  ```bash
  docker compose exec api node dist/cli.js reset-password someone@example.com
  docker compose exec api node dist/cli.js make-admin someone@example.com
  ```

  Both are recorded in the audit log.
- **Logs**: `docker compose logs api` (JSON). Health checks are not logged.
- **MinIO console** is not published. For debugging, use the dev override
  (`docker-compose.dev.yml`) which binds it to `127.0.0.1:9101`.
