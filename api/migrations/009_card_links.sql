-- Unguessable per-card link token, used by the QR code on printed cards (/c/<token>).
-- It only identifies the card; opening it still requires a signed-in user who can view the project.
alter table cards add column link_token text unique;
