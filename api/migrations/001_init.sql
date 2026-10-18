-- Initial schema: users, roles, sessions, API tokens, projects, boards, cards, updates, audit log.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  password_hash text,
  kind text not null default 'human' check (kind in ('human', 'service')),
  is_active boolean not null default true,
  must_change_password boolean not null default false,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

-- Roles are either global (apply everywhere) or project (granted per project membership).
create table roles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  scope text not null check (scope in ('global', 'project')),
  permissions text[] not null default '{}',
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope, name)
);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (user_id, role_id)
);

create table sessions (
  id text primary key,               -- sha256 of the cookie value
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,   -- sha256 of the full token
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index api_tokens_user_idx on api_tokens (user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text not null,
  description text not null default '',
  next_card_number integer not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members (user_id);

-- Functional areas of a project (the "By area" table of the old sheet).
create table areas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  priority text not null default '',
  expected_date text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create table boards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text not null,
  description text not null default '',
  sort integer not null default 0,
  -- Extra per-card fields: [{key, label, type: text|longtext|bool|number|date|url|select, options?}]
  field_defs jsonb not null default '[]',
  parity_enabled boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);

create table board_columns (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  color text not null default '',
  -- todo | active | done | closed; closed columns start collapsed on the board.
  category text not null default 'todo' check (category in ('todo', 'active', 'done', 'closed')),
  -- Weight toward the parity score: 1 full, 0.5 half, 0 counts against, null excluded.
  parity_weight numeric(3, 2),
  wip_limit integer,
  created_at timestamptz not null default now(),
  unique (board_id, name)
);

create table cards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  board_id uuid not null references boards(id) on delete cascade,
  column_id uuid not null references board_columns(id),
  number integer not null,
  title text not null,
  description text not null default '',
  area_id uuid references areas(id) on delete set null,
  priority text check (priority in ('critical', 'high', 'medium', 'low')),
  assignee_id uuid references users(id) on delete set null,
  tags text[] not null default '{}',
  fields jsonb not null default '{}',
  estimate text not null default '',
  due_date date,
  sort double precision not null default 0,
  external_key text,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (project_id, number),
  unique (board_id, external_key)
);
create index cards_board_idx on cards (board_id, column_id, sort) where archived_at is null;
create index cards_area_idx on cards (area_id);
create index cards_search_idx on cards using gin (to_tsvector('english', title || ' ' || description));

create table card_comments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index card_comments_card_idx on card_comments (card_id, created_at);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  object_key text not null unique,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index attachments_card_idx on attachments (card_id);

-- Progress updates (the "Weekly Summary" tab): one entry per period.
create table project_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  period_start date,
  period_end date,
  body text not null default '',
  hours numeric(7, 2),
  hours_note text not null default '',
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, title)
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete set null,
  actor_name text not null default '',
  token_id uuid references api_tokens(id) on delete set null,
  via text not null default 'web',   -- web | api | mcp | import | system
  ip text,
  action text not null,              -- e.g. card.moved, user.created
  entity_type text not null,
  entity_id text,
  project_id uuid references projects(id) on delete set null,
  summary text not null default '',
  changes jsonb
);
create index audit_at_idx on audit_log (at desc);
create index audit_entity_idx on audit_log (entity_type, entity_id, at desc);
create index audit_project_idx on audit_log (project_id, at desc);
create index audit_actor_idx on audit_log (actor_id, at desc);
