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
  // Time zone for scheduled jobs such as the daily sheet export.
  timezone: env('TIMEZONE', 'UTC'),
};
