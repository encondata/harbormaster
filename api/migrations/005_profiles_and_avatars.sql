-- Profile details and photo avatars.
alter table users
  add column first_name text not null default '',
  add column last_name text not null default '',
  add column preferred_name text not null default '',
  add column job_title text not null default '',
  add column contact_email text not null default '',
  add column phone text not null default '',
  add column address_line1 text not null default '',
  add column address_line2 text not null default '',
  add column city text not null default '',
  add column region text not null default '',
  add column postal_code text not null default '',
  add column country text not null default '',
  add column avatar_key text,
  add column avatar_updated_at timestamptz,
  add column password_changed_at timestamptz;

-- Split existing display names into first / last for people.
update users set
  first_name = split_part(name, ' ', 1),
  last_name = case when position(' ' in name) > 0 then substr(name, position(' ' in name) + 1) else '' end
  where kind = 'human';
