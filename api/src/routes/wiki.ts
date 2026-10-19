// Wiki: folders, pages (versioned in MinIO), comments, files, search, tags and trash.
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import {
  addWikiComment, addWikiFile, createFolder, createPage, deleteFolder, deletePage, deleteWikiComment, editWikiComment, getFolder, getPage,
  getWikiFile, listComments, listTrash, movePage, pageHistory, purgeTrash, recentPages, resolveWikiComment, restoreTrash, restoreVersion,
  savePage, searchWiki, setFolderAccess, updateFolder, wikiTags, wikiTree,
} from '../services/wiki.js';

const versionParam = (v: unknown) => {
  if (v === undefined || v === '') return undefined;
  if (!/^\d+$/.test(String(v))) throw badRequest('version must be a number');
  return Number(v);
};

export default async function wikiRoutes(app: FastifyInstance) {
  app.get('/api/wiki/tree', async (req) => wikiTree(requireUser(req)));
  app.get('/api/wiki/recent', async (req) => recentPages(requireUser(req)));
  app.get('/api/wiki/tags', async (req) => wikiTags(requireUser(req)));
  app.get('/api/wiki/search', async (req) => {
    const { q: text = '', tag } = req.query as { q?: string; tag?: string };
    return searchWiki(requireUser(req), String(text), { tag, limit: 50 });
  });

  // People and global roles, for the folder access editor.
  app.get('/api/wiki/principals', async (req) => {
    const ctx = requireUser(req);
    if (!ctx.global.has('wiki.manage')) throw forbidden();
    const [users, roles] = await Promise.all([
      q(`select id, name, email, kind from users where is_active order by name`),
      q(`select id, name from roles where scope = 'global' order by name`),
    ]);
    return { users, roles };
  });

  app.post('/api/wiki/folders', async (req) => createFolder(requireUser(req), req.body));
  app.get('/api/wiki/folders/:id', async (req) => getFolder(requireUser(req), (req.params as any).id));
  app.patch('/api/wiki/folders/:id', async (req) => { await updateFolder(requireUser(req), (req.params as any).id, req.body); return { ok: true }; });
  app.put('/api/wiki/folders/:id/access', async (req) => { await setFolderAccess(requireUser(req), (req.params as any).id, req.body); return { ok: true }; });
  app.delete('/api/wiki/folders/:id', async (req) => { await deleteFolder(requireUser(req), (req.params as any).id); return { ok: true }; });

  app.post('/api/wiki/pages', { bodyLimit: 3 * 1024 * 1024 }, async (req) => createPage(requireUser(req), req.body));
  app.get('/api/wiki/pages/:id', async (req) => getPage(requireUser(req), (req.params as any).id, versionParam((req.query as any).version)));
  app.patch('/api/wiki/pages/:id', { bodyLimit: 3 * 1024 * 1024 }, async (req) => savePage(requireUser(req), (req.params as any).id, req.body));
  app.delete('/api/wiki/pages/:id', async (req) => { await deletePage(requireUser(req), (req.params as any).id); return { ok: true }; });
  app.post('/api/wiki/pages/:id/move', async (req) => {
    const folder = (req.body as { folder_id?: string | null })?.folder_id ?? null;
    await movePage(requireUser(req), (req.params as any).id, folder);
    return { ok: true };
  });
  app.post('/api/wiki/pages/:id/restore', async (req) => {
    const v = versionParam((req.body as any)?.version);
    if (!v) throw badRequest('version is required');
    return restoreVersion(requireUser(req), (req.params as any).id, v);
  });
  app.get('/api/wiki/pages/:id/history', async (req) => pageHistory(requireUser(req), (req.params as any).id));

  app.get('/api/wiki/pages/:id/comments', async (req) => listComments(requireUser(req), (req.params as any).id));
  app.post('/api/wiki/pages/:id/comments', async (req) => addWikiComment(requireUser(req), (req.params as any).id, req.body));
  app.patch('/api/wiki/comments/:id', async (req) => { await editWikiComment(requireUser(req), (req.params as any).id, req.body); return { ok: true }; });
  app.delete('/api/wiki/comments/:id', async (req) => { await deleteWikiComment(requireUser(req), (req.params as any).id); return { ok: true }; });
  app.post('/api/wiki/comments/:id/resolve', async (req) => {
    await resolveWikiComment(requireUser(req), (req.params as any).id, (req.body as any)?.resolved !== false);
    return { ok: true };
  });

  // Files embedded in pages (images, PDFs…), stored in MinIO and streamed through the API.
  app.post('/api/wiki/pages/:id/files', async (req) => {
    const ctx = requireUser(req);
    if (!req.isMultipart()) throw badRequest('Upload as multipart/form-data');
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest('No file attached');
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`File is larger than ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    const filename = (file.filename || 'file').replace(/[\\/\0\r\n]/g, '_').slice(0, 200);
    return addWikiFile(ctx, (req.params as any).id, { filename, contentType: file.mimetype || 'application/octet-stream', data });
  });
  app.get('/api/wiki/files/:id', async (req, reply) => {
    const f = await getWikiFile(requireUser(req), (req.params as any).id);
    const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/.test(f.content_type) && (req.query as any).download !== '1';
    reply
      .header('content-type', f.content_type)
      .header('content-length', f.size_bytes)
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`)
      .header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(f.body);
  });

  app.get('/api/wiki/trash', async (req) => listTrash(requireUser(req)));
  app.post('/api/wiki/trash/:batch/restore', async (req) => { await restoreTrash(requireUser(req), (req.params as any).batch); return { ok: true }; });
  app.delete('/api/wiki/trash/:batch', async (req) => { await purgeTrash(requireUser(req), (req.params as any).batch); return { ok: true }; });
}
