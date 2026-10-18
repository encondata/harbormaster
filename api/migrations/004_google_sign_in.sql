-- Google sign-in: link a user to their Google account, and hold in-flight sign-in attempts.
alter table users add column google_sub text;
create unique index users_google_sub_key on users (google_sub) where google_sub is not null;

create table oauth_states (
  id text primary key,               -- sha256 of the state value sent to Google
  nonce text not null,
  code_verifier text not null,
  next_path text not null default '/',
  remember boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- "Remember me": unchecked sessions last 12 hours and end when the browser closes.
alter table sessions add column remember boolean not null default true;
