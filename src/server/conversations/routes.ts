import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { boundedText } from '../http/body';
import { AppError, commandSchema, conversationTitleSchema } from '../../shared/contracts';
import { queueActionSchema } from '../../shared/queue';
import { newSkillBindings } from '../skills/catalog';
import { newConversationBindings } from '../mcp/connections/catalog';

export const conversationRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; conversationId: string };
}>();
conversationRoutes.get('/', async (c) => {
  const offset = Math.max(0, Math.min(1000000, Number(c.req.query('cursor')) || 0));
  const { results } = await c.env.DB.prepare(
    'SELECT id,title,created_at,updated_at FROM conversations WHERE owner=? ORDER BY updated_at DESC,id LIMIT 101 OFFSET ?',
  )
    .bind(c.get('userId'), offset)
    .all();
  return c.json({
    items: results.slice(0, 100),
    next: results.length > 100 ? String(offset + 100) : null,
  });
});
conversationRoutes.post('/', async (c) => {
  const id = crypto.randomUUID(),
    now = Date.now();
  let selected: string[] | undefined;
  let skillIds: string[] | undefined;
  if (c.req.header('Content-Length') !== '0' && c.req.raw.body) {
    let body: unknown;
    try {
      body = JSON.parse(await boundedText(new Response(c.req.raw.body), 4096));
    } catch {
      throw new AppError(400, 'invalid_request');
    }
    const parsed = z
      .object({
        mcpConnectionIds: z.array(z.uuid()).max(10).optional(),
        skillIds: z.array(z.uuid()).max(8).optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new AppError(400, 'invalid_request');
    selected = parsed.data.mcpConnectionIds;
    skillIds = parsed.data.skillIds;
  }
  const bindings = await newConversationBindings(c.env, c.get('userId'), selected);
  const skills = await newSkillBindings(c.env, c.get('userId'), skillIds);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO conversations(id,owner,title,created_at,updated_at) VALUES(?,?,?,?,?)',
    ).bind(id, c.get('userId'), '新聊天', now, now),
    c.env.DB.prepare(
      'INSERT INTO conversation_mcp_bindings(conversation,bindings) VALUES(?,?)',
    ).bind(id, JSON.stringify(bindings)),
    c.env.DB.prepare(
      'INSERT INTO conversation_skill_bindings(conversation,bindings) VALUES(?,?)',
    ).bind(id, JSON.stringify(skills)),
  ]);
  return c.json({ id, title: '新聊天' }, 201);
});
conversationRoutes.use('/:id/*', async (c, next) => {
  const id = c.req.param('id');
  const owned = await c.env.DB.prepare('SELECT id FROM conversations WHERE id=? AND owner=?')
    .bind(id, c.get('userId'))
    .first();
  if (!owned) return c.json({ error: { code: 'not_found' } }, 404);
  c.set('conversationId', id);
  await next();
});
conversationRoutes.patch('/:id', async (c) => {
  let raw: string;
  try {
    raw = await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 2048);
  } catch {
    throw new AppError(413, 'request_too_large');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'invalid_json');
  }
  const title = conversationTitleSchema.safeParse(
    body && typeof body === 'object' && 'title' in body ? body.title : undefined,
  );
  if (!title.success) throw new AppError(400, 'invalid_title', '标题需为 1 至 120 个字符');
  const renamed = await c.env.DB.prepare(
    'UPDATE conversations SET title=?,title_custom=1 WHERE id=? AND owner=? RETURNING id,title,updated_at',
  )
    .bind(title.data, c.get('conversationId'), c.get('userId'))
    .first();
  if (!renamed) throw new AppError(404, 'not_found');
  return c.json(renamed);
});
conversationRoutes.delete('/:id', async (c) => {
  await c.env.CONVERSATIONS.getByName(c.get('conversationId')).deleteConversation(
    c.get('conversationId'),
  );
  // The DO has durably accepted teardown; remove access from outside its aborting
  // invocation. Its recovery job repeats this idempotently before wiping storage.
  await c.env.DB.prepare('DELETE FROM conversations WHERE id=? AND owner=?')
    .bind(c.get('conversationId'), c.get('userId'))
    .run();
  return c.json({ deleting: true }, 202);
});
conversationRoutes.post('/:id/extensions/:extensionId/controls/:name', async (c) => {
  let payload: string;
  try {
    payload = await boundedText(new Response(c.req.raw.body), 4096);
    JSON.parse(payload);
  } catch {
    throw new AppError(400, 'invalid_extension_control');
  }
  const result = await c.env.CONVERSATIONS.getByName(c.get('conversationId')).controlExtension(
    c.req.param('extensionId'),
    c.req.param('name'),
    payload,
  );
  if (!result.ok) throw new AppError(result.status, result.code);
  return c.json(JSON.parse(result.value));
});
conversationRoutes.post('/:id/runs', async (c) => {
  let raw: string;
  try {
    raw = await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 1048576);
  } catch {
    throw new AppError(413, 'request_too_large');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'invalid_json');
  }
  const parsed = commandSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'invalid_request');
  const result = await c.env.CONVERSATIONS.getByName(c.get('conversationId')).submitRun(
    parsed.data,
  );
  if ('error' in result)
    return c.json({ error: result.error }, result.error.status as ContentfulStatusCode);
  await c.env.DB.prepare(
    "UPDATE conversations SET title=CASE WHEN title_custom=0 AND title='新聊天' THEN ? ELSE title END,updated_at=? WHERE id=? AND owner=?",
  )
    .bind(
      (parsed.data.text || parsed.data.images?.[0]?.name || '新聊天').slice(0, 60),
      Date.now(),
      c.get('conversationId'),
      c.get('userId'),
    )
    .run();
  return c.json(result, 202);
});
conversationRoutes.get('/:id/snapshot', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).snapshot(
      c.req.query('cursor'),
      c.req.query('view') === 'window',
    ),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
conversationRoutes.get('/:id/history', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).readHistory(c.req.query('cursor')),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
conversationRoutes.post('/:id/runs/:runId/queue', async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(new Response(c.req.raw.body), 1024));
  } catch {
    throw new AppError(400, 'invalid_request');
  }
  const parsed = queueActionSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'invalid_request');
  const result = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).actOnQueuedInput(
      c.req.param('runId'),
      parsed.data.action,
    ),
  );
  if ('error' in result)
    return c.json({ error: result.error }, result.error.status as ContentfulStatusCode);
  return c.json(result);
});
conversationRoutes.get('/:id/runs/:runId/events', (c) =>
  c.env.CONVERSATIONS.getByName(c.get('conversationId')).observeRun(
    c.req.param('runId'),
    c.get('conversationId'),
    c.req.query('view') === 'window',
  ),
);
conversationRoutes.post('/:id/stop', async (c) =>
  c.json(await c.env.CONVERSATIONS.getByName(c.get('conversationId')).stopConversation(), 202),
);
conversationRoutes.get('/:id/extensions/:extensionId/resources/:ref', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).loadResource(
      c.req.param('extensionId'),
      c.req.param('ref'),
    ),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
conversationRoutes.patch('/:id/extensions/:extensionId/resources/:ref/state', async (c) => {
  let body: { state?: unknown; expectedRevision: number };
  let raw: string;
  try {
    raw = await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 1048576);
  } catch {
    throw new AppError(413, 'request_too_large');
  }
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'invalid_json');
  }
  if (!body || !Object.hasOwn(body, 'state')) throw new AppError(400, 'invalid_state');
  const reply = await c.env.CONVERSATIONS.getByName(c.get('conversationId')).saveResourceState(
    c.req.param('extensionId'),
    c.req.param('ref'),
    body.state,
    body.expectedRevision,
  );
  return c.json(reply, 'error' in reply ? (reply.error.status as ContentfulStatusCode) : 200);
});
