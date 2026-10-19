-- Wiki: nested folders, pages whose every saved version is an object in MinIO, comments,
-- files embedded in pages, and per-folder access rules.

create table wiki_folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references wiki_folders(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- restricted: only people matching an access rule (or wiki.manage) can see the folder.
  restricted boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_batch uuid                         -- items deleted together are restored together
);
create unique index wiki_folders_name_key on wiki_folders (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name)) where deleted_at is null;

-- A folder with rules (or restricted) sets the policy for itself and every folder below it,
-- until a deeper folder sets its own.
create table wiki_folder_access (
  folder_id uuid not null references wiki_folders(id) on delete cascade,
  principal_type text not null check (principal_type in ('user', 'role')),
  principal_id uuid not null,
  level text not null check (level in ('view', 'edit')),
  primary key (folder_id, principal_type, principal_id)
);

create table wiki_pages (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references wiki_folders(id) on delete cascade,
  title text not null,
  current_version int not null default 0,
  body_text text not null default '',        -- copy of the current version, for search
  search tsvector generated always as (to_tsvector('english', title || ' ' || body_text)) stored,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_batch uuid
);
create unique index wiki_pages_title_key on wiki_pages (coalesce(folder_id, '00000000-0000-0000-0000-000000000000'), lower(title)) where deleted_at is null;
create index wiki_pages_search_idx on wiki_pages using gin (search);
create index wiki_pages_updated_idx on wiki_pages (updated_at desc) where deleted_at is null;

create table wiki_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id) on delete cascade,
  version int not null,
  title text not null,
  object_key text not null,                  -- the markdown in MinIO
  size_bytes int not null,
  sha256 text not null,
  summary text not null default '',          -- edit note
  created_by uuid references users(id) on delete set null,
  created_by_name text not null default '',
  via text not null default 'web',
  created_at timestamptz not null default now(),
  unique (page_id, version)
);

create table wiki_comments (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id) on delete cascade,
  parent_id uuid references wiki_comments(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  page_version int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null
);
create index wiki_comments_page_idx on wiki_comments (page_id, created_at);

create table wiki_files (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id) on delete cascade,
  filename text not null,
  content_type text not null,
  size_bytes int not null,
  object_key text not null,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Every project has its own folder (kind 'project') with two subfolders, Design and Operations.
-- Access to a project folder follows project membership: project.view to read, wiki.write to edit.
alter table wiki_folders add column project_id uuid references projects(id) on delete set null;
alter table wiki_folders add column system_kind text check (system_kind in ('project', 'design', 'operations'));
create unique index wiki_folders_system_key on wiki_folders (project_id, system_kind) where project_id is not null;

-- Tags on pages.
alter table wiki_pages add column tags text[] not null default '{}';
create index wiki_pages_tags_idx on wiki_pages using gin (tags);

update roles set permissions = array(select distinct unnest(permissions || array['wiki.write']))
 where is_builtin and scope = 'project' and name in ('Owner', 'Editor', 'Contributor');
