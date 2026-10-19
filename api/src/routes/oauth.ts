// OAuth 2.1 authorization server for MCP connectors (Claude Desktop, claude.ai, Claude Code /mcp).
// Discovery (RFC 9728 + RFC 8414), dynamic client registration (RFC 7591), authorization code
// with PKCE (S256 only), refresh token rotation and revocation (RFC 7009).
// The consent screen is the web page /oauth/authorize, which calls the two /api/oauth/authorize
// routes below with the user's session. An approved connection is an api_tokens row, so it
// shows and revokes like any other token and its changes are audited under the user.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { newApiToken, randomToken, requireUser, sha256 } from '../auth.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { badRequest } from '../errors.js';
import { parse } from '../validate.js';

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 90;
const CODE_TTL_MIN = 10;

export const mcpUrl = () => `${config.publicUrl}/api/mcp`;
export const resourceMetadataUrl = () => `${config.publicUrl}/.well-known/oauth-protected-resource/api/mcp`;

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });

const cors = (reply: FastifyReply) =>
  reply.header('access-control-allow-origin', '*').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version').header('access-control-allow-methods', 'GET, POST, OPTIONS');

/** https anywhere, plain http only back to this machine (Claude Code's local callback). */
function allowedRedirect(u: string) {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The resource indicator (RFC 8707), when sent, must name this server's MCP endpoint. */
const resourceOk = (r: unknown) => r === undefined || r === '' || [mcpUrl(), config.publicUrl, `${config.publicUrl}/`].includes(String(r));

type Client = { id: string; client_id: string; secret_hash: string | null; name: string; redirect_uris: string[]; client_uri: string | null };
const findClient = (clientId: unknown) =>
  typeof clientId === 'string' && clientId ? one<Client>(`select id, client_id, secret_hash, name, redirect_uris, client_uri from oauth_clients where client_id = $1`, [clientId]) : Promise.resolve(null);

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Client authentication at the token endpoint: none for public clients, else secret via body or Basic. */
function clientCredentials(req: FastifyRequest, body: Record<string, string>) {
  const h = req.headers.authorization;
  if (h?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(h.slice(6), 'base64').toString().split(':').map((s) => decodeURIComponent(s ?? ''));
    return { clientId: id, secret };
  }
  return { clientId: body.client_id, secret: body.client_secret };
}

const authorizeInput = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  response_type: z.string().max(50).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
});

/** Checks an authorization request. Problems with the client or redirect are shown, never redirected. */
async function checkAuthorize(input: z.infer<typeof authorizeInput>) {
  const client = await findClient(input.client_id);
  if (!client) throw badRequest("This app isn't registered with Harbor Master. Try connecting again from the app.");
  if (!client.redirect_uris.includes(input.redirect_uri)) throw badRequest("The app's return address doesn't match what it registered. Try connecting again from the app.");
  if (input.response_type !== 'code') throw badRequest('Unsupported request (response_type must be "code").');
  if (!input.code_challenge || input.code_challenge_method !== 'S256') throw badRequest('The app must use PKCE (S256) to connect.');
  if (!resourceOk(input.resource)) throw badRequest('The app asked for access to a different server.');
  return client;
}

function withParams(uri: string, params: Record<string, string | undefined>) {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

async function issueTokens(rowId: string) {
  const access = newApiToken();
  const refresh = `hslr_${randomToken(32)}`;
  await q(
    `update api_tokens set prefix = $2, token_hash = $3, expires_at = now() + make_interval(secs => $4), refresh_hash = $5,
            refresh_expires_at = now() + make_interval(days => $6) where id = $1`,
    [rowId, access.prefix, access.hash, ACCESS_TTL_S, sha256(refresh), REFRESH_TTL_DAYS],
  );
  return { access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh };
}

export default async function oauthRoutes(app: FastifyInstance) {
  // ---- Discovery ---------------------------------------------------------------------------
  const protectedResource = async (_req: FastifyRequest, reply: FastifyReply) =>
    cors(reply).send({
      resource: mcpUrl(),
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ['header'],
      resource_name: 'Harbor Master',
    });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/api/mcp', protectedResource);

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    cors(reply).send({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
      token_endpoint: `${config.publicUrl}/api/oauth/token`,
      registration_endpoint: `${config.publicUrl}/api/oauth/register`,
      revocation_endpoint: `${config.publicUrl}/api/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    }));

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server', '/api/oauth/register', '/api/oauth/token', '/api/oauth/revoke']) {
    app.options(path, async (_req, reply) => cors(reply).code(204).send());
  }

  // ---- Dynamic client registration -----------------------------------------------------------
  app.post('/api/oauth/register', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    cors(reply);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || uris.some((u) => u.length > 2000 || !allowedRedirect(u))) {
      return oauthError(reply, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs (or http on localhost)');
    }
    const method = typeof b.token_endpoint_auth_method === 'string' ? b.token_endpoint_auth_method : 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return oauthError(reply, 400, 'invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
    }
    const name = (typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim() : 'MCP client').slice(0, 100);
    const clientUri = typeof b.client_uri === 'string' && /^https:\/\//.test(b.client_uri) ? b.client_uri.slice(0, 500) : null;
    const clientId = `hslc_${randomToken(18)}`;
    const secret = method === 'none' ? null : `hsls_${randomToken(32)}`;
    // Registrations nobody ever approved are clutter after a day.
    await q(`delete from oauth_clients c where c.created_at < now() - interval '1 day' and c.last_used_at is null
              and not exists (select 1 from api_tokens t where t.oauth_client_id = c.id)`);
    await q(`insert into oauth_clients (client_id, secret_hash, name, redirect_uris, client_uri) values ($1, $2, $3, $4, $5)`,
      [clientId, secret ? sha256(secret) : null, name, uris, clientUri]);
    return reply.code(201).header('cache-control', 'no-store').send({
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(clientUri ? { client_uri: clientUri } : {}),
    });
  });

  // ---- Consent (called by the /oauth/authorize page with the user's session) ----------------
  app.get('/api/oauth/authorize', async (req) => {
    const ctx = requireUser(req);
    const input = parse(authorizeInput, req.query);
    const client = await checkAuthorize(input);
    const existing = await one<{ n: number }>(
      `select count(*)::int as n from api_tokens where user_id = $1 and oauth_client_id = $2 and revoked_at is null`, [ctx.user.id, client.id]);
    return {
      client: { name: client.name, uri: client.client_uri, redirect_host: new URL(input.redirect_uri).host },
      already_connected: (existing?.n ?? 0) > 0,
    };
  });

  app.post('/api/oauth/authorize', async (req) => {
    const ctx = requireUser(req);
    const body = parse(authorizeInput.extend({ decision: z.enum(['allow', 'deny']) }), req.body);
    const client = await checkAuthorize(body);
    if (body.decision === 'deny') {
      return { redirect: withParams(body.redirect_uri, { error: 'access_denied', error_description: 'The user declined', state: body.state, iss: config.publicUrl }) };
    }
    const code = randomToken(32);
    await q(`delete from oauth_codes where expires_at < now()`);
    await q(
      `insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))`,
      [sha256(code), client.id, ctx.user.id, body.redirect_uri, body.code_challenge, body.scope ?? '', CODE_TTL_MIN],
    );
    await audit(ctx, { action: 'oauth.approved', entityType: 'user', entityId: ctx.user.id, summary: `${ctx.user.name} allowed "${client.name}" to connect (returns to ${new URL(body.redirect_uri).host})` });
    return { redirect: withParams(body.redirect_uri, { code, state: body.state, iss: config.publicUrl }) };
  });

  // ---- Token endpoint ----------------------------------------------------------------------
  app.post('/api/oauth/token', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (req, reply) => {
    cors(reply);
    const body = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : String(v ?? '')]));
    const { clientId, secret } = clientCredentials(req, body);
    const client = await findClient(clientId);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Unknown client');
    if (client.secret_hash && !(secret && safeEqual(sha256(secret), client.secret_hash))) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    if (!resourceOk(body.resource)) return oauthError(reply, 400, 'invalid_target', 'Unknown resource');

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.code_verifier) return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required');
      const c = await one<{ user_id: string; redirect_uri: string; code_challenge: string; scope: string; client_id: string }>(
        `delete from oauth_codes where code_hash = $1 and expires_at > now() returning user_id, redirect_uri, code_challenge, scope, client_id`, [sha256(body.code)]);
      if (!c || c.client_id !== client.id) return oauthError(reply, 400, 'invalid_grant', 'The authorization code is invalid or expired');
      if (body.redirect_uri && body.redirect_uri !== c.redirect_uri) return oauthError(reply, 400, 'invalid_grant', 'redirect_uri does not match');
      if (createHash('sha256').update(body.code_verifier).digest('base64url') !== c.code_challenge) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      const user = await one<{ name: string; email: string; is_active: boolean }>(`select name, email, is_active from users where id = $1`, [c.user_id]);
      if (!user?.is_active) return oauthError(reply, 400, 'invalid_grant', 'The account is deactivated');
      const rowId = await tx(async (db) => {
        // Reconnecting the same app replaces its earlier connection.
        await db.query(`update api_tokens set revoked_at = now() where user_id = $1 and oauth_client_id = $2 and revoked_at is null`, [c.user_id, client.id]);
        const t = newApiToken();
        const r = await db.query<{ id: string }>(
          `insert into api_tokens (user_id, name, prefix, token_hash, created_by, oauth_client_id) values ($1, $2, $3, $4, $1, $5) returning id`,
          [c.user_id, client.name, t.prefix, t.hash, client.id]);
        return r.rows[0].id;
      });
      await q(`update oauth_clients set last_used_at = now() where id = $1`, [client.id]);
      const tokens = await issueTokens(rowId);
      await audit(
        { user: { id: c.user_id, email: user.email, name: user.name, kind: 'human', must_change_password: false }, via: 'api', ip: req.ip, tokenId: rowId, sessionId: null, global: new Set(), projectPerms: new Map() },
        { action: 'token.created', entityType: 'user', entityId: c.user_id, summary: `Connected "${client.name}" for ${user.name}` },
      );
      return reply.header('cache-control', 'no-store').send({ ...tokens, ...(c.scope ? { scope: c.scope } : {}) });
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
      const row = await one<{ id: string }>(
        `select t.id from api_tokens t join users u on u.id = t.user_id
          where t.refresh_hash = $1 and t.oauth_client_id = $2 and t.revoked_at is null and t.refresh_expires_at > now() and u.is_active`,
        [sha256(body.refresh_token), client.id]);
      if (!row) return oauthError(reply, 400, 'invalid_grant', 'The refresh token is invalid, expired or revoked');
      await q(`update oauth_clients set last_used_at = now() where id = $1`, [client.id]);
      return reply.header('cache-control', 'no-store').send(await issueTokens(row.id));
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  // ---- Revocation: either token ends the whole connection -----------------------------------
  app.post('/api/oauth/revoke', { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } }, async (req, reply) => {
    cors(reply);
    const body = (req.body ?? {}) as Record<string, string>;
    const { clientId, secret } = clientCredentials(req, body);
    const client = await findClient(clientId);
    if (!client || (client.secret_hash && !(secret && safeEqual(sha256(secret), client.secret_hash)))) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    if (typeof body.token === 'string' && body.token) {
      const h = sha256(body.token);
      await q(`update api_tokens set revoked_at = coalesce(revoked_at, now()) where oauth_client_id = $1 and (token_hash = $2 or refresh_hash = $2)`, [client.id, h]);
    }
    return reply.code(200).send({});
  });
}
