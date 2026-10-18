import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { authenticate } from './auth.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { migrate, one, pool } from './db.js';
import { HttpError } from './errors.js';
import mcpRoutes from './mcp.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import googleAuthRoutes from './routes/google-auth.js';
import cardRoutes from './routes/cards.js';
import projectRoutes from './routes/projects.js';
import requestRoutes from './routes/requests.js';
import searchRoutes from './routes/search.js';
import meRoutes from './routes/me.js';
import { startScheduler } from './scheduler.js';
import { ensureBucket, storageHealthy } from './storage.js';

const trustHops = Number(process.env.TRUST_PROXY_HOPS ?? 2);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
  // Behind nginx (web container) and the house reverse proxy: trust that many hops for client IPs.
  trustProxy: (_addr: string, hop: number) => hop < trustHops,
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: Math.max(config.maxUploadBytes, 30 * 1024 * 1024), files: 1 } });
await app.register(rateLimit, { global: false });

// Accept an empty body with a JSON content type (common from scripts sending DELETE or POST without data).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = String(body);
  if (!text.trim()) return done(null, undefined);
  try {
    done(null, JSON.parse(text));
  } catch {
    done(Object.assign(new Error('Request body is not valid JSON'), { statusCode: 400 }), undefined);
  }
});

app.decorateRequest('ctx', null);

app.addHook('onRequest', async (req) => {
  if (req.url.startsWith('/api/mcp') || req.url === '/api/health') return;
  if (req.url.startsWith('/api/')) await authenticate(req);
});

// Accounts flagged for a password change can only reach what they need to change it.
app.addHook('preHandler', async (req) => {
  const ctx = req.ctx;
  if (!ctx?.user.must_change_password || ctx.tokenId) return;
  const allowed = ['/api/auth/me', '/api/auth/password', '/api/auth/logout'];
  if (!allowed.some((p) => req.url.split('?')[0] === p)) throw new HttpError(403, 'You must change your password first', 'password_change_required');
});

app.setErrorHandler((err: any, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code ?? 'error' });
  req.log.error(err);
  return reply.code(500).send({ error: 'Something went wrong on the server', code: 'internal' });
});

app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `No route ${req.method} ${req.url.split('?')[0]}`, code: 'not_found' }));

app.get('/api/health', { logLevel: 'warn' }, async (_req, reply) => {
  const db = await one('select 1 as ok').then(() => true).catch(() => false);
  const storage = await storageHealthy();
  return reply.code(db && storage ? 200 : 503).send({ ok: db && storage, db, storage });
});

await app.register(authRoutes);
await app.register(googleAuthRoutes);
await app.register(adminRoutes);
await app.register(projectRoutes);
await app.register(cardRoutes);
await app.register(requestRoutes);
await app.register(searchRoutes);
await app.register(meRoutes);
await app.register(mcpRoutes);

const log = (m: string) => app.log.info(m);
await migrate(log);
await ensureBucket(log);
await bootstrap(log);

await app.listen({ port: config.port, host: '0.0.0.0' });
const scheduler = startScheduler(log);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    clearInterval(scheduler);
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
