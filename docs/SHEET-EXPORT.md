# Daily Google Sheet export

Each project can copy itself into a Google Sheet once a day: a **Summary** tab (parity and
the By area table), **one tab per board**, **Weekly Summary** and **Requests**. The board is
the source of truth. Each run overwrites those tabs and leaves any other tabs alone, so don't
type into them.

Use a separate sheet from the one you sync *from* (Settings → Sync from the tracking
spreadsheet). Otherwise the next sync would read back what the export wrote.

## One-time setup: a Google service account

The server writes to Google as a *service account*, a robot Google identity. It's free.

1. Go to https://console.cloud.google.com/ and create a project (e.g. "HSL KanBan"), or pick
   an existing one.
2. **APIs & Services → Library**: search for **Google Sheets API** and click **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. Name it e.g.
   `hsl-kanban-export`. Skip the optional role and user-access steps.
4. Open the new account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. On the server, put that file at `secrets/google-service-account.json` in the repository
   folder (next to `docker-compose.yml`) and make it readable by the container:

   ```bash
   mkdir -p secrets
   mv ~/Downloads/<downloaded-key>.json secrets/google-service-account.json
   chmod 644 secrets/google-service-account.json
   ```

   `secrets/` is git-ignored. Treat the file like a password: anyone with it can edit every
   sheet shared with that account. If it leaks, delete the key in Google Cloud and make a new one.
6. Set your time zone in `.env` (e.g. `TIMEZONE=America/Chicago`) and restart the API:

   ```bash
   docker compose up -d api
   ```

## Per project

1. Create an empty Google Sheet (e.g. "ServerSherpa – board export").
2. Click **Share** and add the service account's email (shown in the app under
   **Project → Settings → Daily Google Sheet export**, it ends in
   `.iam.gserviceaccount.com`) as an **Editor**.
3. In that Settings section, paste the sheet link and **Save**.
4. Click **Preview** to see which tabs and how many rows would be written, then **Export now**
   to write them.
5. Tick **Export every day at** and pick the hour. The export runs once a day at or after that
   hour in the server's time zone.

The last run's time and result show in the same section, and every run (or failure) is in the
project's Activity log.

## From the server console

```bash
docker compose exec api node dist/cli.js export-sheet SS --dry-run
docker compose exec api node dist/cli.js export-sheet SS
```

## Troubleshooting

- **"No Google service account is configured"**: the key file is missing from `secrets/`, or
  isn't readable (`chmod 644`). Restart the API after adding it.
- **"Google refused access to the sheet… Share it with …"**: share the sheet with the email in
  the message as an Editor.
- **"Google sign-in failed"**: the key was deleted or disabled in Google Cloud; create a new one.
- A failed scheduled run isn't retried until the next day. Use **Export now** to retry.
