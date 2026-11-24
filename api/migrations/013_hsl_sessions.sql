-- Sessions made by "Sign in with HackSpaceLabs" (HSL Suite plan, section 5.6). Existing rows are
-- local sessions. An oidc session lasts as long as the Keycloak session (refresh_expires_in) and is
-- rechecked with Keycloak at most every HSL_OIDC_RECHECK_SECONDS.
alter table sessions
  add column auth_source text not null default 'local' check (auth_source in ('local', 'oidc')),
  add column idp_sid text,          -- the ID token's sid (Keycloak session id)
  add column idp_tokens text,       -- AES-256-GCM sealed JSON {sub, refresh_token, id_token}
  add column idp_checked_at timestamptz;
