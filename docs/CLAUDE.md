# Claude integration

Claude Code connects to Harbor Master through its MCP server at `<PUBLIC_URL>/api/mcp`
(for the shared install: `https://harbormaster.hackspacelabs.com/api/mcp`).

## The quick way: Profile → Claude

In the app, open your name (bottom of the sidebar) → **Profile** → **Claude** tab, or the sparkle
button in the header. It:

1. creates a personal connection token (Claude then acts as you, with your permissions, and its
   changes show in history under your name marked "mcp");
2. shows the one `claude mcp add …` command to run on each machine where you use Claude Code;
3. writes the instructions to paste into a project's `CLAUDE.md`, using that project's real boards
   and column names.

## Shared automation: the Claude service account

For automation that shouldn't act as a person (scheduled jobs, the factory later), an administrator
can create a token for the **Claude** service account instead: **Users → Claude → New token**. Add
the Claude account to each project it should touch (Settings → Members, Editor role).

Manual command, if needed:

```bash
claude mcp add --transport http --scope user harbormaster https://harbormaster.hackspacelabs.com/api/mcp --header "Authorization: Bearer hsl_xxxxxxxx_…"
```

Check it with `claude mcp list`. In a session, `/mcp` shows the server and its tools.

## Tools

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

## Instructions for a project's repository

Profile → Claude generates this for any project with its real boards and columns. For reference,
the shape is:

```markdown
## Progress tracking (Harbor Master)

Development progress lives in Harbor Master (MCP server `harbormaster`, project `SS`).

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

## REST API

The same token works on the REST API (`Authorization: Bearer …`). Useful endpoints:

- `GET /api/projects/SS` — structure
- `GET /api/projects/SS/cards?board=todo&q=zebra` — cards
- `GET /api/cards/SS-42` — one card with comments and history
- `PATCH /api/cards/SS-42` — edit (`{"fields": {"notes": "…"}}`)
- `POST /api/cards/SS-42/move` — `{"column": "Done"}`
- `POST /api/cards/SS-42/comments` — `{"body": "…"}`
- `POST /api/projects/SS/updates` — new progress update

Errors come back as `{"error": "message", "code": "…"}` with a 4xx status.
