-- Daily one-way export of a project's boards to a Google Sheet.
alter table projects
  add column sheet_export_id text,
  add column sheet_export_enabled boolean not null default false,
  add column sheet_export_hour integer not null default 6 check (sheet_export_hour between 0 and 23),
  add column sheet_export_last_run_at timestamptz,
  add column sheet_export_last_status text,
  add column sheet_export_last_error text;
