-- Sign in with HackSpaceLabs (the HSL Keycloak realm). Additive only: passwords, Google sign-in,
-- sessions and API tokens are untouched.
-- hsl_sub is the stable Keycloak account id once linked. hsl_username is the Keycloak username:
-- recorded on link, or set ahead of time by an administrator so that person's first HSL sign-in
-- links to this account (Keycloak usernames can't be changed by their owners, emails can).
alter table users add column hsl_sub text, add column hsl_username text;
create unique index users_hsl_sub_key on users (hsl_sub) where hsl_sub is not null;
create unique index users_hsl_username_key on users (lower(hsl_username)) where hsl_username is not null;

-- In-flight sign-ins now say which provider they're for, and a link attempt names the signed-in user.
alter table oauth_states
  add column provider text not null default 'google',
  add column link_user_id uuid references users (id) on delete cascade;
