import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../shared/contracts';
import { SKILL_LIMITS } from '../../shared/skills';
import { boundedText } from '../web';
import { importSkill } from './package';
import {
  skillsEnabled,
  skillViews,
  skillPreview,
  ownedSkill,
  publishSkill,
  changeSkill,
} from './catalog';

export const skillRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
skillRoutes.use('*', async (_c, next) => {
  if (!skillsEnabled()) throw new AppError(404, 'skills_disabled');
  await next();
});
async function upload(request: Request) {
  if (Number(request.headers.get('content-length')) > SKILL_LIMITS.upload)
    throw new AppError(413, 'skill_package_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'skill_file_required');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > SKILL_LIMITS.upload) throw new AppError(413, 'skill_package_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
skillRoutes.get('/', async (c) => c.json({ skills: await skillViews(c.env, c.get('userId')) }));
skillRoutes.post('/preview', async (c) => {
  const { preview } = await importSkill(await upload(c.req.raw), c.req.query('filename') ?? '');
  return c.json({ preview });
});
skillRoutes.post('/', async (c) =>
  c.json(
    {
      skill: await publishSkill(
        c.env,
        c.get('userId'),
        await upload(c.req.raw),
        c.req.query('filename') ?? '',
      ),
    },
    201,
  ),
);
skillRoutes.get('/:id', async (c) =>
  c.json({
    preview: await skillPreview(c.env, c.get('userId'), c.req.param('id')),
  }),
);
skillRoutes.post('/:id/versions', async (c) => {
  // Authorize before reading an untrusted upload.
  await ownedSkill(c.env, c.get('userId'), c.req.param('id'));
  const revision = Number(c.req.header('If-Match'));
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new AppError(400, 'invalid_skill_revision');
  return c.json({
    skill: await publishSkill(
      c.env,
      c.get('userId'),
      await upload(c.req.raw),
      c.req.query('filename') ?? '',
      { id: c.req.param('id'), revision },
    ),
  });
});
skillRoutes.on(['PATCH', 'DELETE'], '/:id', async (c) => {
  let body;
  try {
    body = JSON.parse(await boundedText(new Response(c.req.raw.body), 2048));
  } catch {
    throw new AppError(400, 'invalid_skill_request');
  }
  const parsed = z
    .object({ revision: z.number().int().positive(), enabled: z.boolean().optional() })
    .strict()
    .safeParse(body);
  if (!parsed.success || (c.req.method === 'PATCH' && parsed.data.enabled === undefined))
    throw new AppError(400, 'invalid_skill_request');
  return c.json(
    await changeSkill(
      c.env,
      c.get('userId'),
      c.req.param('id'),
      parsed.data.revision,
      c.req.method === 'DELETE' ? undefined : parsed.data.enabled,
    ),
  );
});
