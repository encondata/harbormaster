-- Claude skills hosted in Harbor Master: each publish of a skill is an immutable version holding
-- every file it installs under ~/.claude (the skill folder, its agents, its scripts).
create table skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                 -- folder name under ~/.claude/skills, e.g. "factory"
  description text not null default '',
  latest_version int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references skills(id) on delete cascade,
  version int not null,
  notes text not null default '',
  files jsonb not null,                      -- [{path, content, executable}] relative to ~/.claude
  content_hash text not null,                -- sha256 over the files, to skip identical publishes
  total_bytes int not null,
  published_by uuid references users(id) on delete set null,
  published_by_name text not null default '',
  published_at timestamptz not null default now(),
  unique (skill_id, version)
);

-- Publishing installs code on every machine that syncs, so it is its own permission.
update roles set permissions = array(select distinct unnest(permissions || array['skills.publish']))
 where is_builtin and name = 'Administrator';
