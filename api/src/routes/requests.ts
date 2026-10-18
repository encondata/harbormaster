import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { resolveProject } from '../services/common.js';
import {
  commentOnRequest, createRequest, getRequestForCtx, listRequestComments, listRequests, requestHistory, requestInput, triage, triageInput, updateRequest, vote,
} from '../services/requests.js';
import { one } from '../db.js';
import { parse } from '../validate.js';

export default async function requestRoutes(app: FastifyInstance) {
  app.get('/api/projects/:project/requests', async (req) => {
    const ctx = requireUser(req);
    const p = await resolveProject((req.params as any).project);
    const f = req.query as Record<string, string | undefined>;
    return listRequests(ctx, p.id, { status: f.status ?? 'open', query: f.q, sort: f.sort });
  });

  app.post('/api/projects/:project/requests', async (req) => {
    const ctx = requireUser(req);
    const p = await resolveProject((req.params as any).project);
    return createRequest(ctx, p.id, parse(requestInput, req.body));
  });

  app.get('/api/requests/:ref', async (req) => {
    const ctx = requireUser(req);
    const { request, perms } = await getRequestForCtx(ctx, (req.params as any).ref);
    const voted = !!(await one(`select 1 from request_votes where request_id = $1 and user_id = $2`, [request.id, ctx.user.id]));
    const [comments, history] = await Promise.all([listRequestComments(request.id), requestHistory(request.id)]);
    return {
      ...request, voted, comments, history,
      can_edit: perms.has('request.triage') || (request.requested_by === ctx.user.id && perms.has('request.create')),
    };
  });

  app.patch('/api/requests/:ref', async (req) => {
    const ctx = requireUser(req);
    const { request } = await getRequestForCtx(ctx, (req.params as any).ref);
    return updateRequest(ctx, request.id, parse(requestInput.partial(), req.body));
  });

  app.post('/api/requests/:ref/vote', async (req) => {
    const ctx = requireUser(req);
    const { request } = await getRequestForCtx(ctx, (req.params as any).ref);
    return vote(ctx, request.id, parse(z.object({ vote: z.boolean() }), req.body).vote);
  });

  app.post('/api/requests/:ref/comments', async (req) => {
    const ctx = requireUser(req);
    const { request } = await getRequestForCtx(ctx, (req.params as any).ref);
    await commentOnRequest(ctx, request.id, parse(z.object({ body: z.string() }), req.body).body);
    return { ok: true };
  });

  app.post('/api/requests/:ref/triage', async (req) => {
    const ctx = requireUser(req);
    const { request } = await getRequestForCtx(ctx, (req.params as any).ref);
    return triage(ctx, request.id, parse(triageInput, req.body));
  });
}
