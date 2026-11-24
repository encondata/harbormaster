# Sign in with HackSpaceLabs

Harbor Master can let people sign in with their HackSpaceLabs account (the HSL Keycloak realm at
`auth.hackspacelabs.com`), as one of the HackSpaceLabs apps: sign in once at any of them and the others
open signed in. It follows the HSL Suite plan (section 5, work package 5). With `HSL_OIDC_ISSUER` empty
Harbor Master behaves as before.

## Who gets in

- **Only people with a Harbor Master role in HackSpaceLabs.** In the portal (Identity & access) a person
  or one of their groups needs the `member` or `admin` role on the `harbormaster` app. Anyone else, a
  portal customer for example, sees "Your HackSpaceLabs account doesn't have access to Harbor Master" and
  no account is created for them.
- **People already in Harbor Master** link their HSL account once, in any of these ways:
  - **Account → Security → Link HackSpaceLabs account**, while signed in the usual way.
  - An administrator enters their **HSL username** on their user page (Users → the person →
    *HackSpaceLabs sign-in*). Their first HSL sign-in then links to that account.
  - If HSL marks their email as verified and it matches their Harbor Master email, it links
    automatically. (HSL doesn't verify emails today, so expect to use one of the two above.)

  **After linking, the account signs in only with HackSpaceLabs.** Its password and Google sign-in are
  refused ("This account signs in with HackSpaceLabs"), and its other password or Google sessions end.
  Otherwise disabling someone in HackSpaceLabs would not lock them out.
- **New people** who sign in with HSL get a Harbor Master account straight away, with no projects. An
  administrator then adds them to projects as usual. Because HSL doesn't verify email addresses, their
  HSL email goes into their profile's contact email, and the account email is `<hsl username>@hsl.invalid`
  until an administrator changes it. Otherwise someone could claim another person's email, and with it
  their Google sign-in. If that address is already taken, the sign-in is refused; no second address is
  made up.
- If someone's HSL email already belongs to a Harbor Master account that isn't linked, the sign-in is
  refused with instructions to link from the Account page, so no duplicate account is created.
- Deactivated users can't sign in with HSL either. Every HSL sign-in, refusal, link, unlink, account
  creation and ended session is in the audit log.

## Roles

- HackSpaceLabs `admin` gives the person Harbor Master's built-in **Administrator** role if they don't
  have it yet.
- **Nothing is taken away when the HackSpaceLabs role goes.** Harbor Master's own global roles and project
  memberships stay managed in Harbor Master. Losing both HackSpaceLabs roles (`member` and `admin`) does
  end the person's access: their sessions end within the recheck interval and their tokens stop working.

## Sessions

- A HackSpaceLabs sign-in lasts as long as the HackSpaceLabs session: **96 hours**, or **30 days** when
  "Remember me" is ticked on the HackSpaceLabs sign-in page. Activity doesn't extend it.
- Harbor Master rechecks the session with Keycloak at most every `HSL_OIDC_RECHECK_SECONDS` (60) while it
  is used. Signed out of HackSpaceLabs elsewhere, disabled, or no Harbor Master role any more: the
  session ends. Keycloak unreachable: the session carries on, and is checked again later.
- **Sign out** in Harbor Master also signs you out of HackSpaceLabs, and so of the other HackSpaceLabs apps
  (each notices within its recheck interval). You land on `/signed-out`.
- Password and Google sign-ins (accounts not tied to HackSpaceLabs) last 96 hours, or 30 days with
  "Remember me", extended on activity.
- An open live-update connection (board changes) checks every 25 seconds that its session is still
  valid, so it closes soon after the session ends.
- Clearing `HSL_OIDC_ISSUER` turns HackSpaceLabs sign-in off: sessions made by it end on their next request,
  and accounts tied to HackSpaceLabs can't sign in until it is turned back on. Local accounts work as before.

## API tokens and the Claude connector

Personal API tokens (`hsl_…`) and Claude connector tokens of an account tied to HackSpaceLabs keep working
without a HackSpaceLabs session, so Harbor Master asks the portal, at most every 5 minutes per person,
whether that person is still enabled and still has a Harbor Master role (`HSL_PORTAL_INTERNAL_URL`). If
not, the tokens are refused (and the connector can't refresh) until that changes. If the portal can't
answer, tokens keep working and a warning is logged. If the portal answers 404 (wrong address, wrong
secret, or the call went through the public proxy), tokens of linked people are refused and an error
names the setting to check. With `HSL_PORTAL_INTERNAL_URL` empty this check is off (logged at start),
and off-boarding must include deactivating the person here.

## Keeping a way in

Every server keeps at least one **active Administrator who signs in with a password and is not linked**:
Harbor Master refuses to link the last one. That account is the way in when HackSpaceLabs is down. With
`HSL_OIDC_AUTO_REDIRECT=true` the sign-in page goes straight to HackSpaceLabs; open **`/login?local=1`** for
the password form. Also from the server console:

```bash
docker compose exec api node dist/cli.js reset-password <email>   # also unlinks HackSpaceLabs
docker compose exec api node dist/cli.js make-admin <email>
```

## Setup

1. On the HSL server, set Harbor Master's address in `deployment/.env` (`HARBORMASTER_ORIGIN`), then rerun
   the installer. It registers the `harbormaster` client in Keycloak with its roles.
2. Still in the HSL `deployment` folder, write Harbor Master's settings into Harbor Master's `.env`. The
   secret is never printed:

   ```bash
   node scripts/app-env.mjs harbormaster /path/to/harbormaster/.env
   ```

   This sets `HSL_OIDC_ISSUER`, `HSL_OIDC_CLIENT_ID`, `HSL_OIDC_CLIENT_SECRET`, `HSL_PORTAL_URL` and
   `HSL_SUITE_APPS`. Add `HSL_PORTAL_INTERNAL_URL` (the portal gateway's direct address, for example
   `http://192.168.1.10:8088`) for the token owner check. See `.env.example` for the other settings.
3. Make sure Harbor Master's `PUBLIC_URL` is exactly the `HARBORMASTER_ORIGIN` from step 1, then restart
   its API: `docker compose up -d api`. If the API container can't reach the public issuer address, set
   `HSL_OIDC_INTERNAL_URL` to an address where it can reach Keycloak.

The **Sign in with HackSpaceLabs** button appears on the sign-in page once the settings are present.
Before anyone uses it, link existing people (above), and only then set `HSL_OIDC_AUTO_REDIRECT=true`.
