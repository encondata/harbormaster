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
  sessionDays: 14,
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
  // Time zone for scheduled jobs such as the daily sheet export.
  timezone: env('TIMEZONE', 'UTC'),
};
