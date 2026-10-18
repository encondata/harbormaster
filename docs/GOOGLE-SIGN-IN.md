# Sign in with Google

Harbor Master can let people sign in with their Google account instead of a password. Accounts
are still created by an administrator: Google sign-in only works when the person's **verified
Google email matches an existing, active Harbor Master user**. The first successful sign-in
links that Google account to the user, and after that only that Google account works for them.

Passwords keep working alongside it.

## One-time setup in Google Cloud

You can use the same Google Cloud project as the daily sheet export.

1. Go to https://console.cloud.google.com/ and open (or create) your project.
2. **APIs & Services → OAuth consent screen**
   - **Internal** if everyone signs in with your Google Workspace domain (e.g. `@encondata.com`).
     Only your domain's accounts can use it, and no Google review is needed.
   - **External** if people use personal Gmail accounts. Add yourself as a test user while
     setting up. Only the `openid`, `email` and `profile` scopes are used, so verification is light.
   - App name **Harbor Master**, plus your support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type **Web application**, name e.g. `Harbor Master`.
   - **Authorized redirect URI**: your `PUBLIC_URL` plus `/api/auth/google/callback`, for example
     `https://harbormaster.example.com/api/auth/google/callback`. For local testing also add
     `http://localhost:8090/api/auth/google/callback`.
   - Create, then copy the **Client ID** and **Client secret**.

## Turn it on

In `.env` on the server:

```bash
GOOGLE_OAUTH_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
# Optional: only allow these email domains (comma-separated)
GOOGLE_OAUTH_ALLOWED_DOMAINS=encondata.com
```

`PUBLIC_URL` must exactly match the address in the redirect URI. Then restart the API:

```bash
docker compose up -d api
```

The **Sign in with Google** button on the sign-in page becomes active. Until then it shows
"Google sign-in isn't set up on this server yet."

## Day to day

- **Adding someone:** create their user (Users → New user) with the email they use for Google.
  They can then sign in with Google straight away; give them a password only if they need one.
- **If they see "No Harbor Master account uses …":** their Google email doesn't match any user.
  Fix the user's email, or add them.
- **If they change Google accounts:** Users → their page → Google sign-in → **Unlink**. The next
  Google sign-in links the new account.
- **Deactivated users** can't sign in with Google either.
- Every Google sign-in, refusal, link and unlink is in the audit log.

"Remember me" applies to Google sign-ins too: unticked, the session ends when the browser closes.
