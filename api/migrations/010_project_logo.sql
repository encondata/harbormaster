-- Optional project logo, printed faintly behind printed cards (the built-in H is used when there is none).
alter table projects
  add column logo_key text,
  add column logo_updated_at timestamptz;
