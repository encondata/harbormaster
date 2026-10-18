# Claude integration

Claude updates the boards as the **Claude** service account (created automatically, an
*Editor* on ServerSherpa). Everything it does shows in card history and the audit log with
source `mcp` and the token's name.

## 1. Create a token

In the app: **Users → Claude → API tokens → New token**. Name it after where it will be
used (e.g. "Claude Code on Jimmy's laptop"). Copy it; it is shown once.

To let Claude work on another project, add the Claude account to that project
(**Project → Settings → Members**) with the Editor role.

## 2. Connect Claude Code

```bash
claude mcp add --transport http --scope user hsl-kanban https://kanban.example.com/api/mcp --header "Authorization: Bearer hsl_xxxxxxxx_…"
```

Check it with `claude mcp list`. In a session, `/mcp` shows the server and its tools.

Any MCP client that supports Streamable HTTP with a custom header works the same way.

## 3. Tools

| Tool | What it does |
|---|---|
| `list_projects` | Projects the token can see. |
| `get_project` | Boards, column names, custom card fields and areas. Call this first. |
| `get_summary` | Counts per area and status, parity %, recent activity, latest update. |
| `list_cards` | Search and filter (board, column, area, priority, tag, text). |
| `get_card` | Full card with fields, comments and history. |
| `create_card` | New card on a board (fields must match the board's field keys). |
| `update_card` | Change title, description, area, priority, tags, estimate, due date, fields. |
| `move_card` | Change status by moving to another column, with an optional comment. |
| `add_comment` | Markdown note on a card: what was done, commits, test results. |
| `archive_card` | Archive or restore. |
| `update_area` | Priority, expected date, notes for an area (the *By area* table). |
| `list_updates` | Recent weekly progress updates. |
| `log_progress` | Append bullets (and optionally hours) to this week's update. |
| `save_update` | Write or replace a whole update by title. |
| `list_requests` | Feature requests on a project (open by default), most voted first. |
| `create_request` | File a feature request, optionally naming who asked (`requested_for`). |
| `triage_request` | Review, accept (creates a linked card), decline, mark duplicate or reopen a request. |

Cards are referenced by key, e.g. `SS-42`. Moving a card is how its status changes; on the
Feature Parity board the columns are the V3 statuses (Not built, Partial, Pending Testing,
Complete, Retired…), so moving a card updates the parity score.

## 4. Suggested instructions for the ServerSherpa repository

Add something like this to the ServerSherpa repo's `CLAUDE.md` so Claude keeps the board
current as it works:

```markdown
## Progress tracking (HSL KanBan)

Development progress lives in HSL KanBan (MCP server `hsl-kanban`, project `SS`).

- Before starting a task, find the matching card with `list_cards` (To-Do board for build
  items, Feature Parity board for V2 features). Mention the card key in your plan.
- When work starts on a To-Do card, `move_card` it to "In progress".
- When work merges, `move_card` it to "Done" (To-Do) or the right V3 status (Feature
  Parity), with a comment that says what shipped, the commit hash, and the screen path.
- Put the details that used to go in the sheet's notes column in the card's `notes` field
  (Feature Parity) or `status_notes` field (To-Do), using `update_card`.
- At the end of each work session, `log_progress` one bullet per item done with an
  estimate in hours, e.g. "Bulk asset update at /bulk/assets (~4 h)".
- Never archive cards or change areas' expected dates unless asked.
```

## 5. REST API

The same token works on the REST API (`Authorization: Bearer …`). Useful endpoints:

- `GET /api/projects/SS` — structure
- `GET /api/projects/SS/cards?board=todo&q=zebra` — cards
- `GET /api/cards/SS-42` — one card with comments and history
- `PATCH /api/cards/SS-42` — edit (`{"fields": {"notes": "…"}}`)
- `POST /api/cards/SS-42/move` — `{"column": "Done"}`
- `POST /api/cards/SS-42/comments` — `{"body": "…"}`
- `POST /api/projects/SS/updates` — new progress update

Errors come back as `{"error": "message", "code": "…"}` with a 4xx status.
