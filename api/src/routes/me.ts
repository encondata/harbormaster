// Your own profile: details, photo avatar and your history.
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { deleteObject, getObject, putObject } from '../storage.js';
import { parse } from '../validate.js';
import { queryAudit } from './admin.js';

const PROFILE_FIELDS = ['first_name', 'last_name', 'preferred_name', 'job_title', 'contact_email', 'phone', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country'] as const;

const txt = (max: number) => z.string().trim().max(max);
const profileInput = z.object({
  first_name: txt(80).min(1, 'First name is required'),
  last_name: txt(80).min(1, 'Last name is required'),
  preferred_name: txt(80).default(''),
  job_title: txt(120).default(''),
  contact_email: txt(200).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Contact email is not a valid address').default(''),
  phone: txt(40).regex(/^[0-9+().\-\s]*$/, 'Phone can only contain digits, spaces and + ( ) . -').default(''),
  address_line1: txt(200).default(''),
  address_line2: txt(200).default(''),
  city: txt(100).default(''),
  region: txt(100).default(''),
  postal_code: txt(20).default(''),
  country: txt(2).or(z.string().trim()).refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), 'Country is a 2-letter code, e.g. US').transform((s) => s.toUpperCase()).default(''),
});

const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const AVATAR_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif']);

export const displayName = (p: { preferred_name: string; first_name: string; last_name: string }) =>
  (p.preferred_name ? `${p.preferred_name} ${p.last_name}` : `${p.first_name} ${p.last_name}`).trim();

export default async function meRoutes(app: FastifyInstance) {
  // Where this server is reached, for the "connect Claude" commands.
  app.get('/api/meta', async (req) => {
    requireUser(req);
    return { public_url: config.publicUrl, mcp_url: `${config.publicUrl}/api/mcp`, token_prefix: 'hsl_' };
  });

  app.get('/api/me/profile', async (req) => {
    const ctx = requireUser(req);
    const u = await one(
      `select id, email, name, kind, is_active, created_at, last_login_at, password_changed_at, avatar_updated_at,
              password_hash is not null as has_password, google_sub is not null as google_linked, ${PROFILE_FIELDS.join(', ')}
         from users where id = $1`,
      [ctx.user.id],
    );
    const roles = await q<{ name: string }>(`select r.name from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 order by r.name`, [ctx.user.id]);
    const projectRoles = await q<{ name: string }>(
      `select distinct r.name from project_members m join roles r on r.id = m.role_id where m.user_id = $1 order by r.name`,
      [ctx.user.id],
    );
    return { ...u, global_roles: roles.map((r) => r.name), project_roles: projectRoles.map((r) => r.name) };
  });

  app.patch('/api/me/profile', async (req) => {
    const ctx = requireUser(req);
    const input = parse(profileInput, req.body);
    const before = (await one(`select name, ${PROFILE_FIELDS.join(', ')} from users where id = $1`, [ctx.user.id]))!;
    const name = displayName(input);
    await q(
      `update users set ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')}, name = $${PROFILE_FIELDS.length + 2}, updated_at = now() where id = $1`,
      [ctx.user.id, ...PROFILE_FIELDS.map((f) => input[f]), name],
    );
    const changes = diff(before, { ...input, name }, [...PROFILE_FIELDS, 'name']);
    if (Object.keys(changes).length) {
      await audit(ctx, { action: 'user.profile_updated', entityType: 'user', entityId: ctx.user.id, summary: `${name} updated their profile (${Object.keys(changes).map((k) => k.replace(/_/g, ' ')).join(', ')})`, changes });
    }
    return { ok: true, name };
  });

  app.post('/api/me/avatar', async (req) => {
    const ctx = requireUser(req);
    if (!req.isMultipart()) throw badRequest('Upload the photo as multipart/form-data');
    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES } });
    if (!file) throw badRequest('No photo attached');
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest('That photo is larger than 8 MB');
    let out: Buffer;
    try {
      const img = sharp(data, { limitInputPixels: 50_000_000, failOn: 'error' });
      const meta = await img.metadata();
      if (!meta.format || !AVATAR_FORMATS.has(meta.format)) throw new Error('format');
      // Re-encoding drops all metadata (camera details, GPS location). rotate() applies EXIF orientation first.
      out = await img.rotate().resize(256, 256, { fit: 'cover', position: 'attention' }).webp({ quality: 85 }).toBuffer();
    } catch {
      throw badRequest('That file is not a photo we can read. Use a JPG, PNG, WebP, GIF or HEIC image.');
    }
    const key = `avatars/${ctx.user.id}.webp`;
    await putObject(key, out, 'image/webp');
    await q(`update users set avatar_key = $2, avatar_updated_at = now() where id = $1`, [ctx.user.id, key]);
    await audit(ctx, { action: 'user.avatar_updated', entityType: 'user', entityId: ctx.user.id, summary: `${ctx.user.name} changed their photo` });
    return one(`select avatar_updated_at from users where id = $1`, [ctx.user.id]);
  });

  app.delete('/api/me/avatar', async (req) => {
    const ctx = requireUser(req);
    const u = await one<{ avatar_key: string | null }>(`select avatar_key from users where id = $1`, [ctx.user.id]);
    if (u?.avatar_key) await deleteObject(u.avatar_key).catch(() => {});
    await q(`update users set avatar_key = null, avatar_updated_at = null where id = $1`, [ctx.user.id]);
    if (u?.avatar_key) await audit(ctx, { action: 'user.avatar_removed', entityType: 'user', entityId: ctx.user.id, summary: `${ctx.user.name} removed their photo` });
    return { ok: true };
  });

  // Anyone signed in can see avatars (they appear next to names everywhere).
  app.get('/api/users/:id/avatar', async (req, reply) => {
    requireUser(req);
    const u = await one<{ avatar_key: string | null }>(`select avatar_key from users where id = $1`, [(req.params as any).id]);
    if (!u?.avatar_key) throw notFound('No photo');
    reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff');
    return reply.send(await getObject(u.avatar_key));
  });

  app.get('/api/me/history', async (req) => {
    const ctx = requireUser(req);
    return queryAudit({ ...(req.query as any), actor_id: ctx.user.id });
  });
}
