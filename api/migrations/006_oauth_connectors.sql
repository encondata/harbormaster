-- OAuth 2.1 for MCP connectors (Claude Desktop, claude.ai, Claude Code's /mcp sign-in).
-- Clients register themselves (dynamic client registration); a user approves a client on the
-- consent page; the resulting connection is an api_tokens row whose access token rotates.

create table oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  secret_hash text,                      -- sha256 of the client secret; null for public clients
  name text not null,
  redirect_uris text[] not null,
  client_uri text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table oauth_codes (
  code_hash text primary key,            -- sha256 of the authorization code
  client_id uuid not null references oauth_clients(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scope text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- A connection made through OAuth: the access token is token_hash (short-lived, rotated on
-- refresh) and the refresh token keeps the connection alive until revoked.
alter table api_tokens add column oauth_client_id uuid references oauth_clients(id) on delete cascade;
alter table api_tokens add column refresh_hash text unique;
alter table api_tokens add column refresh_expires_at timestamptz;
