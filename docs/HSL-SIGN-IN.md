# Sign in with HackSpaceLabs

Harbor Master can let people sign in with their HackSpaceLabs account (the HSL Keycloak realm at
`auth.hackspacelabs.com`). It is added alongside the existing sign-ins. **Passwords, Google
sign-in, open sessions, API tokens and the Claude connector all keep working unchanged.**

## Who gets in

- **People already in Harbor Master** link their HSL account once, in any of these ways:
  - **Account → Security → Link HackSpaceLabs account**, while signed in the usual way.
  - An administrator enters their **HSL username** on their user page (Users → the person →
    *HackSpaceLabs sign-in*). Their first HSL sign-in then links to that account.
  - If HSL marks their email as verified and it matches their Harbor Master email, it links
    automatically. (HSL doesn't verify emails today, so expect to use one of the two above.)

  After linking, only that HSL account signs in as them.
- **New people** who sign in with HSL get a Harbor Master account straight away, **with no roles
  and no projects**. An administrator then adds them to projects as usual. Because HSL doesn't
  verify email addresses, their HSL email goes into their profile's contact email, and the
  account email is `<hsl username>@hsl.invalid` until an administrator changes it. Otherwise
  someone could claim another person's email, and with it their Google sign-in.
- If someone's HSL email already belongs to a Harbor Master account that isn't linked, the sign-in
  is refused with instructions to link from the Account page. That way no duplicate account
  is created.
- Deactivated users can't sign in with HSL either. Every HSL sign-in, refusal, link, unlink and
  account creation is in the audit log.

## Setup

1. On the HSL server, set Harbor Master's address in `deployment/.env`, then rerun the installer.
   It registers the `harbormaster` sign-in client in Keycloak:

   ```bash
   HARBORMASTER_ORIGIN=https://harbormaster.hackspacelabs.com
   ```

2. Still in the HSL `deployment` folder, write Harbor Master's settings into Harbor Master's
   `.env`. The secret is never printed:

   ```bash
   node scripts/harbormaster-secret.mjs /path/to/harbormaster/.env
   ```

   This sets `HSL_OIDC_ISSUER`, `HSL_OIDC_CLIENT_ID` and `HSL_OIDC_CLIENT_SECRET`. If Harbor Master
   runs on another machine, run it against a scratch file and copy the three lines across.

3. Make sure Harbor Master's `PUBLIC_URL` is exactly the `HARBORMASTER_ORIGIN` from step 1, then
   restart its API:

   ```bash
   docker compose up -d api
   ```

The **Sign in with HackSpaceLabs** button appears on the sign-in page once all three settings are
present. The API container must be able to reach the HSL issuer URL.

## Day to day

- **Changing HSL accounts:** Users → the person → HackSpaceLabs sign-in → **Unlink**. People
  can also unlink themselves on the Account page if they still have a password or Google.
- **Signing out** of Harbor Master doesn't sign you out of HackSpaceLabs.
- **Roles** still live in Harbor Master. HSL roles aren't read yet.
