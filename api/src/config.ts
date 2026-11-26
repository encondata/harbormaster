function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8090').replace(/\/$/, ''),
  cookieSecure: env('COOKIE_SECURE', 'true') !== 'false',
  databaseUrl: env('DATABASE_URL', 'postgres://harbormaster:harbormaster@localhost:5432/harbormaster'),
  s3: {
    endpoint: env('S3_ENDPOINT', 'http://localhost:9000'),
    region: env('S3_REGION', 'us-east-1'),
    accessKey: env('S3_ACCESS_KEY', 'harbormaster'),
    secretKey: env('S3_SECRET_KEY', 'harbormaster'),
    bucket: env('S3_BUCKET', 'harbormaster'),
  },
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', '25')) * 1024 * 1024,
  admin: {
    email: process.env.ADMIN_EMAIL ?? '',
    name: process.env.ADMIN_NAME || 'Administrator',
    password: process.env.ADMIN_PASSWORD ?? '',
  },
  // Password and Google sign-ins: 96 hours, or 30 days with "Remember me", both extended on activity.
  // HackSpaceLabs sessions last as long as the Keycloak session instead.
  sessionHours: 96,
  rememberDays: 30,
  // Google service account key (JSON) used to write exported sheets. Optional.
  googleServiceAccountFile: env('GOOGLE_SERVICE_ACCOUNT_FILE', '/app/secrets/google-service-account.json'),
  // Google sign-in (OAuth / OpenID Connect). Off unless both values are set.
  google: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    // Optional comma-separated list of allowed email domains, e.g. "encondata.com".
    allowedDomains: (process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    // Endpoints can be overridden only to point tests at a stand-in server.
    authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    jwksUrl: process.env.GOOGLE_OAUTH_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: (process.env.GOOGLE_OAUTH_ISSUERS || 'https://accounts.google.com,accounts.google.com').split(','),
  },
  // Sign in with HackSpaceLabs (the HSL Keycloak realm; HSL Suite plan section 5.1). Off unless the
  // issuer, client id and secret are all set. The HSL installer's deployment/scripts/app-env.mjs writes them.
  hsl: {
    issuer: (process.env.HSL_OIDC_ISSUER ?? '').trim().replace(/\/+$/, ''),
    clientId: (process.env.HSL_OIDC_CLIENT_ID ?? '').trim() || 'harbormaster',
    clientSecret: (process.env.HSL_OIDC_CLIENT_SECRET ?? '').trim(),
    // Origin for server-to-server calls to Keycloak when the public issuer isn't reachable from here.
    internalUrl: (process.env.HSL_OIDC_INTERNAL_URL ?? '').trim().replace(/\/+$/, ''),
    autoRedirect: (process.env.HSL_OIDC_AUTO_REDIRECT ?? '').trim().toLowerCase() === 'true',
    recheckSeconds: Math.max(1, Number(process.env.HSL_OIDC_RECHECK_SECONDS) || 60),
    portalUrl: (process.env.HSL_PORTAL_URL ?? '').trim().replace(/\/+$/, ''),
    // The portal gateway, called directly for the API-token owner check. Empty = owner check off.
    portalInternalUrl: (process.env.HSL_PORTAL_INTERNAL_URL ?? '').trim().replace(/\/+$/, ''),
    // App switcher: "id|name|url" entries separated by commas.
    apps: (process.env.HSL_SUITE_APPS ?? '').split(',').map((e) => e.trim().split('|').map((s) => s.trim())).filter((p) => p.length === 3 && p.every(Boolean) && /^https?:\/\//.test(p[2]))
      .map(([id, name, url]) => ({ id, name, url })),
  },
  // Time zone for scheduled jobs such as the daily sheet export.
  timezone: env('TIMEZONE', 'UTC'),
};
