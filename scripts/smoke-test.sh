#!/usr/bin/env bash
# End-to-end smoke test against a running stack. Intended for a local/dev stack:
# it creates a throwaway project (archived at the end), a test user and an API token (revoked at the end).
# It signs in three times; sign-in is rate limited to 10 attempts per 5 minutes per IP.
#
#   BASE=http://localhost:8090 ADMIN_EMAIL=... ADMIN_PASSWORD=... scripts/smoke-test.sh
set -euo pipefail

BASE=${BASE:-http://localhost:8090}
API="$BASE/api"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/admin.jar"
VJAR="$WORK/viewer.jar"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

j() { curl -s -H 'content-type: application/json' -H 'x-hsl-csrf: 1' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'x-hsl-csrf: 1' "$@"; }

echo "Health"
check "API healthy" "$(curl -s "$API/health" | jq -r .ok)" "true"

echo "Auth"
# JSON bodies are built with jq into variables first: macOS bash 3.2 mangles escaped JSON inside "$(...)".
login_json() { jq -nc --arg e "$1" --arg p "$2" '{email: $e, password: $p}'; }
BAD_LOGIN=$(login_json "$ADMIN_EMAIL" "wrong-password")
ADMIN_LOGIN=$(login_json "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
check "wrong password rejected" "$(code -d "$BAD_LOGIN" "$API/auth/login")" "401"
check "admin signs in" "$(code -c "$JAR" -d "$ADMIN_LOGIN" "$API/auth/login")" "200"
check "write without CSRF header refused" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' -X PATCH -d '{"name":"x"}' "$API/auth/me")" "403"
check "unauthenticated request refused" "$(curl -s -o /dev/null -w '%{http_code}' "$API/projects")" "401"

echo "Project and cards"
KEY="Z$(date +%s | tail -c 6 | tr '0-9' 'A-J')"
NEW_PROJECT=$(jq -nc --arg k "$KEY" '{key: $k, name: ("Smoke test " + $k)}')
check "create project $KEY" "$(j -b "$JAR" -d "$NEW_PROJECT" "$API/projects" | jq -r .key)" "$KEY"
CARD=$(j -b "$JAR" -d '{"title":"Smoke card","priority":"high"}' "$API/projects/$KEY/boards/kanban/cards" | jq -r .key)
check "create card" "${CARD%%-*}" "$KEY"
check "move card" "$(j -b "$JAR" -d '{"column":"In Progress","index":"top"}' "$API/cards/$CARD/move" | jq -r .column_name)" "In Progress"
check "edit card" "$(j -b "$JAR" -X PATCH -d '{"tags":["Smoke"],"estimate":"1 h"}' "$API/cards/$CARD" | jq -r '.tags[0]')" "smoke"
check "comment on card" "$(j -b "$JAR" -d '{"body":"hello"}' "$API/cards/$CARD/comments" | jq -r .body)" "hello"
printf 'attachment body' >"$WORK/a.txt"
AID=$(curl -s -b "$JAR" -H 'x-hsl-csrf: 1' -F "file=@$WORK/a.txt" "$API/cards/$CARD/attachments" | jq -r .id)
check "attachment round-trips through storage" "$(curl -s -b "$JAR" "$API/attachments/$AID")" "attachment body"
check "card history recorded" "$(curl -s -b "$JAR" "$API/cards/$CARD" | jq '[.history[].action] | contains(["card.created","card.moved","card.updated","card.commented","attachment.added"] | map(select(. != "attachment.added")))')" "true"

echo "Users and permissions"
PID=$(curl -s -b "$JAR" "$API/projects/$KEY" | jq -r .id)
VIEWER_ROLE=$(curl -s -b "$JAR" "$API/roles" | jq -r '.[] | select(.scope=="project" and .name=="Viewer") | .id')
VEMAIL="viewer-$KEY@smoke.test"
VPASS="Viewer-$KEY-pass1"
NEW_USER=$(jq -nc --arg e "$VEMAIL" --arg p "$VPASS" --arg pid "$PID" --arg r "$VIEWER_ROLE" '{email: $e, name: "Smoke Viewer", password: $p, must_change_password: false, projects: [{project_id: $pid, role_id: $r}]}')
VID=$(j -b "$JAR" -d "$NEW_USER" "$API/admin/users" | jq -r .id)
check "viewer created" "$([ -n "$VID" ] && [ "$VID" != null ] && echo yes)" "yes"
code -c "$VJAR" -d "$(login_json "$VEMAIL" "$VPASS")" "$API/auth/login" >/dev/null
check "viewer can read cards" "$(curl -s -o /dev/null -w '%{http_code}' -b "$VJAR" "$API/projects/$KEY/cards")" "200"
check "viewer cannot move cards" "$(code -b "$VJAR" -d '{"column":"Done"}' "$API/cards/$CARD/move")" "403"
check "viewer cannot open admin" "$(curl -s -o /dev/null -w '%{http_code}' -b "$VJAR" "$API/admin/users")" "403"
TEMP=$(j -b "$JAR" -d '{"must_change_password":true}' "$API/admin/users/$VID/reset-password" | jq -r .temporary_password)
code -c "$VJAR" -d "$(login_json "$VEMAIL" "$TEMP")" "$API/auth/login" >/dev/null
check "reset password forces a change first" "$(curl -s -b "$VJAR" "$API/projects" | jq -r .code)" "password_change_required"
PW_CHANGE=$(jq -nc --arg c "$TEMP" --arg n "$VPASS-2" '{current_password: $c, new_password: $n}')
check "user can set a new password" "$(code -b "$VJAR" -d "$PW_CHANGE" "$API/auth/password")" "200"
check "deactivate user" "$(j -b "$JAR" -X PATCH -d '{"is_active":false}' "$API/admin/users/$VID" | jq -r .is_active)" "false"
check "deactivated user is signed out" "$(curl -s -o /dev/null -w '%{http_code}' -b "$VJAR" "$API/projects")" "401"

echo "Claude (API token + MCP)"
CLAUDE_ID=$(curl -s -b "$JAR" "$API/admin/users" | jq -r '.[] | select(.email=="claude@service.local") | .id')
EDITOR_ROLE=$(curl -s -b "$JAR" "$API/roles" | jq -r '.[] | select(.scope=="project" and .name=="Editor") | .id')
j -b "$JAR" -X PUT -d "$(jq -nc --arg r "$EDITOR_ROLE" '{role_id: $r}')" "$API/projects/$KEY/members/$CLAUDE_ID" >/dev/null
TOK_JSON=$(j -b "$JAR" -d '{"name":"smoke test","expires_in_days":1}' "$API/admin/users/$CLAUDE_ID/tokens")
TOK=$(echo "$TOK_JSON" | jq -r .token)
TOK_ID=$(echo "$TOK_JSON" | jq -r .id)
mcp() { curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$1" "$API/mcp"; }
check "MCP initialize" "$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | jq -r .result.serverInfo.name)" "harbormaster"
check "MCP lists tools" "$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '[.result.tools[].name] | index("move_card") != null')" "true"
MOVE_CALL=$(jq -nc --arg c "$CARD" '{jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "move_card", arguments: {card: $c, column: "Done", comment: "done by smoke test"}}}')
check "MCP moves a card" "$(mcp "$MOVE_CALL" | jq -r '.result.content[0].text' | jq -r .column)" "Done"
LOG_CALL=$(jq -nc --arg k "$KEY" '{jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "log_progress", arguments: {project: $k, lines: ["smoke test line"]}}}')
check "MCP logs progress" "$(mcp "$LOG_CALL" | jq -r '.result.isError // false')" "false"
check "MCP change attributed to Claude via mcp" "$(curl -s -b "$JAR" "$API/cards/$CARD" | jq -r '[.history[] | select(.action=="card.moved")][0] | "\(.actor_name)/\(.via)"')" "Claude/mcp"
check "token cannot reach admin" "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOK" "$API/admin/users")" "403"
j -b "$JAR" -X DELETE "$API/admin/users/$CLAUDE_ID/tokens/$TOK_ID" >/dev/null
check "revoked token refused" "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOK" "$API/projects")" "401"

echo "Audit"
check "audit log has entries for the project" "$(curl -s -b "$JAR" "$API/projects/$KEY/audit?limit=200" | jq '.items | length > 8')" "true"

echo "Cleanup"
j -b "$JAR" -X DELETE "$API/projects/$KEY/members/$CLAUDE_ID" >/dev/null
check "archive smoke project" "$(j -b "$JAR" -X PATCH -d '{"archived":true}' "$API/projects/$KEY" | jq -r '.archived_at != null')" "true"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
