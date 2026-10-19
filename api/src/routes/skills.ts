// Claude skills: list, read (with files, for installing) and publish.
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { badRequest } from '../errors.js';
import { getSkill, listSkills, publishSkill, setSkillArchived } from '../services/skills.js';

export default async function skillRoutes(app: FastifyInstance) {
  app.get('/api/skills', async (req) => {
    requireUser(req);
    return listSkills();
  });

  app.get('/api/skills/:name', async (req) => {
    requireUser(req);
    const { name } = req.params as { name: string };
    const v = (req.query as { version?: string }).version;
    if (v !== undefined && !/^\d+$/.test(v)) throw badRequest('version must be a number');
    return getSkill(name, v ? Number(v) : undefined);
  });

  app.post('/api/skills', { bodyLimit: 4 * 1024 * 1024 }, async (req) => publishSkill(requireUser(req), req.body));

  app.post('/api/skills/:name/archive', async (req) => {
    const ctx = requireUser(req);
    const { name } = req.params as { name: string };
    await setSkillArchived(ctx, name, (req.body as { archived?: boolean })?.archived !== false);
    return { ok: true };
  });
}
