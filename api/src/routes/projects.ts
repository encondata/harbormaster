import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireProject, requireUser } from '../auth.js';
import { badRequest } from '../errors.js';
import { bus, type ChangeEvent } from '../events.js';
import { resolveProject } from '../services/common.js';
import { fetchGoogleSheet, importWorkbook } from '../services/import-sheet.js';
import {
  addBoard, addColumn, areaInput, boardInput, boardPatch, columnInput, createProject, deleteArea, deleteColumn, getProject, listMembers,
  listProjectsFor, MAX_LOGO_BYTES, projectInput, projectLogo, removeProjectLogo, setProjectLogo, projectPatch, projectSummary, setMember, updateBoard, updateColumn, updateProject, upsertArea,
} from '../services/projects.js';
import { MAX_TICKETS, printCardTickets, printTestTicket, setReceiptPrinter } from '../services/receipt.js';
import { exportSettings, runExport, saveExportSettings } from '../services/sheet-export.js';
import { deleteUpdate, listUpdates, saveUpdate, updateInput } from '../services/updates.js';
import { parse } from '../validate.js';
import { queryAudit } from './admin.js';

const pid = async (req: FastifyRequest) => (await resolveProject((req.params as any).project)).id;

export default async function projectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req) => listProjectsFor(requireUser(req)));

  app.post('/api/projects', async (req) => createProject(requireUser(req), parse(projectInput, req.body)));

  app.get('/api/projects/:project', async (req) => getProject(requireUser(req), await pid(req)));

  app.patch('/api/projects/:project', async (req) => updateProject(requireUser(req), await pid(req), parse(projectPatch, req.body)));

  // Project logo, printed faintly behind printed cards.
  app.get('/api/projects/:project/logo', async (req, reply) => {
    const data = await projectLogo(requireUser(req), await pid(req));
    reply.header('content-type', 'image/png').header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff');
    return reply.send(data);
  });

  app.post('/api/projects/:project/logo', async (req) => {
    const ctx = requireUser(req);
    const projectId = await pid(req);
    await requireProject(ctx, projectId, 'project.manage');
    if (!req.isMultipart()) throw badRequest('Upload the logo as multipart/form-data');
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES } });
    if (!file) throw badRequest('No logo attached');
    const data = await file.toBuffer();
    if (file.file.truncated) throw badRequest('That logo is larger than 8 MB');
    return setProjectLogo(ctx, projectId, data);
  });

  app.delete('/api/projects/:project/logo', async (req) => removeProjectLogo(requireUser(req), await pid(req)));

  // Network receipt printer (Epson ESC/POS over raw TCP).
  app.put('/api/projects/:project/receipt-printer', async (req) => {
    const body = parse(z.object({ host: z.string().trim().min(1).max(64), port: z.number().int().default(9100) }), req.body);
    return setReceiptPrinter(requireUser(req), await pid(req), body);
  });

  app.delete('/api/projects/:project/receipt-printer', async (req) => setReceiptPrinter(requireUser(req), await pid(req), null));

  app.post('/api/projects/:project/receipt-printer/test', async (req) => printTestTicket(requireUser(req), await pid(req)));

  app.post('/api/projects/:project/cards/receipt', async (req) => {
    const body = parse(z.object({ keys: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/)).min(1).max(MAX_TICKETS) }), req.body);
    return printCardTickets(requireUser(req), await pid(req), body.keys);
  });

  app.get('/api/projects/:project/summary', async (req) => projectSummary(requireUser(req), await pid(req)));

  // ----- members -----
  app.get('/api/projects/:project/members', async (req) => listMembers(requireUser(req), await pid(req)));

  app.put('/api/projects/:project/members/:userId', async (req) => {
    const ctx = requireUser(req);
    const body = parse(z.object({ role_id: z.string().uuid() }), req.body);
    const id = await pid(req);
    await setMember(ctx, id, (req.params as any).userId, body.role_id);
    return listMembers(ctx, id);
  });

  app.delete('/api/projects/:project/members/:userId', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await setMember(ctx, id, (req.params as any).userId, null);
    return listMembers(ctx, id);
  });

  // ----- areas -----
  app.post('/api/projects/:project/areas', async (req) => upsertArea(requireUser(req), await pid(req), null, parse(areaInput, req.body)));

  app.patch('/api/projects/:project/areas/:areaId', async (req) =>
    upsertArea(requireUser(req), await pid(req), (req.params as any).areaId, parse(areaInput.partial(), req.body)),
  );

  app.delete('/api/projects/:project/areas/:areaId', async (req) => {
    await deleteArea(requireUser(req), await pid(req), (req.params as any).areaId);
    return { ok: true };
  });

  // ----- boards & columns -----
  app.post('/api/projects/:project/boards', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await addBoard(ctx, id, parse(boardInput, req.body));
    return getProject(ctx, id);
  });

  app.patch('/api/projects/:project/boards/:boardId', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await updateBoard(ctx, id, (req.params as any).boardId, parse(boardPatch, req.body));
    return getProject(ctx, id);
  });

  app.post('/api/projects/:project/boards/:boardId/columns', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await addColumn(ctx, id, (req.params as any).boardId, parse(columnInput, req.body));
    return getProject(ctx, id);
  });

  app.patch('/api/projects/:project/boards/:boardId/columns/:columnId', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    const { boardId, columnId } = req.params as any;
    await updateColumn(ctx, id, boardId, columnId, parse(columnInput.partial(), req.body));
    return getProject(ctx, id);
  });

  app.delete('/api/projects/:project/boards/:boardId/columns/:columnId', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    const { boardId, columnId } = req.params as any;
    await deleteColumn(ctx, id, boardId, columnId, (req.query as any).move_to);
    return getProject(ctx, id);
  });

  // ----- progress updates -----
  app.get('/api/projects/:project/updates', async (req) => listUpdates(requireUser(req), await pid(req)));

  app.post('/api/projects/:project/updates', async (req) => saveUpdate(requireUser(req), await pid(req), null, parse(updateInput, req.body)));

  app.patch('/api/projects/:project/updates/:updateId', async (req) =>
    saveUpdate(requireUser(req), await pid(req), (req.params as any).updateId, parse(updateInput.partial(), req.body)),
  );

  app.delete('/api/projects/:project/updates/:updateId', async (req) => {
    await deleteUpdate(requireUser(req), await pid(req), (req.params as any).updateId);
    return { ok: true };
  });

  // ----- activity -----
  app.get('/api/projects/:project/audit', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await requireProject(ctx, id, 'project.audit');
    return queryAudit({ ...(req.query as any), project_id: id });
  });

  // ----- spreadsheet import -----
  app.post('/api/projects/:project/import', async (req) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await requireProject(ctx, id, 'project.import');
    let data: Buffer;
    let dryRun = false;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest('Attach an .xlsx file');
      dryRun = (file.fields as any)?.dry_run?.value === 'true';
      data = await file.toBuffer();
    } else {
      const body = parse(z.object({ url: z.string().url(), dry_run: z.boolean().optional() }), req.body);
      dryRun = !!body.dry_run;
      data = await fetchGoogleSheet(body.url);
    }
    return importWorkbook(ctx, id, data, { dryRun });
  });

  // ----- daily Google Sheet export -----
  app.get('/api/projects/:project/sheet-export', async (req) => exportSettings(requireUser(req), await pid(req)));

  app.put('/api/projects/:project/sheet-export', async (req) => {
    const body = parse(z.object({ sheet: z.string().max(500).nullable().optional(), enabled: z.boolean().optional(), hour: z.number().int().min(0).max(23).optional() }), req.body);
    return saveExportSettings(requireUser(req), await pid(req), body);
  });

  app.post('/api/projects/:project/sheet-export/run', async (req) => {
    const body = parse(z.object({ dry_run: z.boolean().optional() }), req.body);
    return runExport(requireUser(req), await pid(req), { dryRun: body.dry_run });
  });

  // ----- live change feed (Server-Sent Events) -----
  app.get('/api/projects/:project/events', async (req, reply) => {
    const ctx = requireUser(req);
    const id = await pid(req);
    await requireProject(ctx, id, 'project.view');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    const onChange = (e: ChangeEvent) => {
      if (e.projectId === id) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    bus.on('change', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('change', onChange);
    });
  });
}
