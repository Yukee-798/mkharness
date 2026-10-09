import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { auth } from './auth';
import { boundedText } from './web';
import { AppError, commandSchema, type RawState } from '../shared/contracts';
const app = new Hono<{ Bindings: Env; Variables: { userId: string; conversationId: string } }>();
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth(c.env).handler(c.req.raw));
app.use('/api/*', async (c, next) => {
  const session = await auth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session)
    return c.json({ error: { code: 'unauthenticated', message: 'Sign in to continue' } }, 401);
  if (
    !['GET', 'HEAD'].includes(c.req.method) &&
    c.req.header('Origin') !== new URL(c.env.APP_URL).origin
  )
    return c.json({ error: { code: 'invalid_origin' } }, 403);
  c.set('userId', session.user.id);
  await next();
});
app.get('/api/conversations', async (c) => {
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
app.post('/api/conversations', async (c) => {
  const id = crypto.randomUUID(),
    now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO conversations(id,owner,title,created_at,updated_at) VALUES(?,?,?,?,?)',
  )
    .bind(id, c.get('userId'), '新聊天', now, now)
    .run();
  return c.json({ id, title: '新聊天' }, 201);
});
app.use('/api/conversations/:id/*', async (c, next) => {
  const id = c.req.param('id');
  const owned = await c.env.DB.prepare('SELECT id FROM conversations WHERE id=? AND owner=?')
    .bind(id, c.get('userId'))
    .first();
  if (!owned) return c.json({ error: { code: 'not_found' } }, 404);
  c.set('conversationId', id);
  await next();
});
app.post('/api/conversations/:id/runs', async (c) => {
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
    "UPDATE conversations SET title=CASE WHEN title='新聊天' THEN ? ELSE title END,updated_at=? WHERE id=? AND owner=?",
  )
    .bind(parsed.data.text.slice(0, 60), Date.now(), c.get('conversationId'), c.get('userId'))
    .run();
  return c.json(result, 202);
});
app.get('/api/conversations/:id/snapshot', async (c) => {
  return c.body(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).snapshot(c.req.query('cursor')),
    200,
    { 'Content-Type': 'application/json' },
  );
});
app.get('/api/conversations/:id/runs/:runId/events', (c) =>
  c.env.CONVERSATIONS.getByName(c.get('conversationId')).observeRun(
    c.req.param('runId'),
    c.get('conversationId'),
  ),
);
app.post('/api/conversations/:id/stop', async (c) =>
  c.json(await c.env.CONVERSATIONS.getByName(c.get('conversationId')).stopConversation(), 202),
);
app.get('/api/conversations/:id/panels/:ref', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).loadPanel(c.req.param('ref')),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
app.patch('/api/conversations/:id/panels/:ref/state', async (c) => {
  let body: { state?: RawState; expectedRevision: number };
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
  if (!body?.state || typeof body.state !== 'object' || Array.isArray(body.state))
    throw new AppError(400, 'invalid_state');
  const reply = await c.env.CONVERSATIONS.getByName(c.get('conversationId')).savePanelState(
    c.req.param('ref'),
    body.state,
    body.expectedRevision,
  );
  return c.json(reply, 'error' in reply ? (reply.error.status as ContentfulStatusCode) : 200);
});
app.onError((error, c) => {
  if (error instanceof AppError) {
    if (c.req.path.startsWith('/api/auth/'))
      return c.json(
        { code: error.code, message: error.message },
        error.status as ContentfulStatusCode,
      );
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status as ContentfulStatusCode,
    );
  }
  console.error(JSON.stringify({ stage: 'api', error: 'request_failed' }));
  return c.json(
    {
      error: {
        code: 'internal_error',
        message: 'The request failed. Retry or inspect server logs.',
      },
    },
    500,
  );
});
export default app;
export { ConversationAgent } from './conversation';
