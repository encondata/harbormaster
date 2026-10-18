-- Feature requests: submitted by project members (and Claude), triaged, and turned into cards.

alter table projects add column next_request_number integer not null default 1;

create table feature_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number integer not null,
  title text not null,
  description text not null default '',
  -- new | reviewing | accepted | declined | duplicate
  status text not null default 'new' check (status in ('new', 'reviewing', 'accepted', 'declined', 'duplicate')),
  area_id uuid references areas(id) on delete set null,
  requested_by uuid references users(id) on delete set null,
  -- Who the request is really from when someone files it for them, e.g. "Mark (CSG)".
  requested_for text not null default '',
  card_id uuid references cards(id) on delete set null,
  duplicate_of uuid references feature_requests(id) on delete set null,
  decision_note text not null default '',
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index feature_requests_project_idx on feature_requests (project_id, status, created_at desc);
create index feature_requests_card_idx on feature_requests (card_id);

create table request_votes (
  request_id uuid not null references feature_requests(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

create table request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references feature_requests(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index request_comments_request_idx on request_comments (request_id, created_at);

-- Grant the new permissions to existing built-in project roles (bootstrap only inserts missing roles).
update roles set permissions = array(select distinct unnest(permissions || array['request.create', 'request.triage']))
  where scope = 'project' and is_builtin and name in ('Owner', 'Editor');
update roles set permissions = array(select distinct unnest(permissions || array['request.create']))
  where scope = 'project' and is_builtin and name = 'Contributor';
