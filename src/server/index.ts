import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { auth, authMode } from './auth';
import { boundedText } from './web';
import { extensionIds } from '../extensions/server';
import { z } from 'zod';
import { ModelCredentials } from './model-credentials';
import {
  applicationModels,
  configuredModelCatalog,
  validateModelSelection,
  modelProviders,
  registeredProvider,
} from './models';
import { AppError, commandSchema, conversationTitleSchema } from '../shared/contracts';
import { queueActionSchema } from '../shared/queue';
const app = new Hono<{ Bindings: Env; Variables: { userId: string; conversationId: string } }>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});
app.on(['POST', 'GET'], '/api/auth/*', (c) => auth(c.env).handler(c.req.raw));
app.get('/api/bootstrap', (c) => c.json({ authMode: authMode(c.env) }));
app.use('/api/*', async (c, next) => {
  const session = await auth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session)
    return c.json({ error: { code: 'unauthenticated', message: 'Sign in to continue' } }, 401);
  if (Boolean(session.user.isAnonymous) !== (authMode(c.env) === 'guest'))
    throw new AppError(409, 'auth_mode_mismatch', '当前身份不适用于此部署模式，请退出后重新进入');
  if (
    !['GET', 'HEAD'].includes(c.req.method) &&
    c.req.header('Origin') !== new URL(c.env.APP_URL).origin
  )
    return c.json({ error: { code: 'invalid_origin' } }, 403);
  c.set('userId', session.user.id);
  await next();
});
app.get('/api/capabilities', (c) => c.json({ extensionIds: extensionIds() }));
app.get('/api/settings/models', async (c) => {
  const credentials = new ModelCredentials(c.env, c.get('userId'));
  return c.json({
    providers: modelProviders.map(({ id, name, factory, defaultModel }) => ({
      id,
      name,
      baseUrl: factory().baseUrl!,
      defaultModelId: defaultModel,
    })),
    modelCatalog: configuredModelCatalog(
      c.env,
      applicationModels(c.env),
      await credentials.configuredModels(),
    ),
    credentials: await Promise.all(modelProviders.map((p) => credentials.metadata(p.id))),
    credentialStorageReady: credentials.storageReady,
  });
});
app.on(['PUT', 'DELETE'], '/api/settings/model-credentials/:provider', async (c) => {
  const provider = registeredProvider(c.req.param('provider')).id;
  let body: unknown;
  try {
    body = JSON.parse(
      await boundedText(new Response(c.req.raw.body, { headers: c.req.raw.headers }), 16 * 1024),
    );
  } catch {
    throw new AppError(400, 'invalid_credential_request');
  }
  const expected = z.uuid().nullable();
  const schema =
    c.req.method === 'PUT'
      ? z
          .object({
            apiKey: z.string(),
            baseUrl: z.string().max(2048).optional(),
            modelId: z.string().trim().min(1).max(200).optional(),
            expectedCurrentId: expected,
          })
          .strict()
      : z.object({ expectedCurrentId: expected }).strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'invalid_credential_request');
  if (
    'apiKey' in parsed.data &&
    'modelId' in parsed.data &&
    typeof parsed.data.modelId === 'string'
  ) {
    const models = applicationModels(c.env);
    const model = models.getModel(provider, parsed.data.modelId);
    if (!model)
      throw new AppError(
        400,
        'unknown_model',
        '模型名未在当前 Pi 目录注册，请填写受支持的 API 模型名',
      );
    validateModelSelection(c.env, models, { provider, modelId: model.id, thinkingLevel: 'off' });
  }
  const credentials = new ModelCredentials(c.env, c.get('userId'));
  return c.json(
    'apiKey' in parsed.data
      ? await credentials.save(
          provider,
          parsed.data as {
            apiKey: string;
            baseUrl?: string;
            modelId?: string;
            expectedCurrentId: string | null;
          },
        )
      : await credentials.remove(provider, parsed.data.expectedCurrentId),
  );
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
app.patch('/api/conversations/:id', async (c) => {
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
app.delete('/api/conversations/:id', async (c) => {
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
app.get('/api/conversations/:id/snapshot', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).snapshot(c.req.query('cursor')),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
app.post('/api/conversations/:id/runs/:runId/queue', async (c) => {
  const body = await c.req.json().catch(() => undefined);
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
app.get('/api/conversations/:id/runs/:runId/events', (c) =>
  c.env.CONVERSATIONS.getByName(c.get('conversationId')).observeRun(
    c.req.param('runId'),
    c.get('conversationId'),
  ),
);
app.post('/api/conversations/:id/stop', async (c) =>
  c.json(await c.env.CONVERSATIONS.getByName(c.get('conversationId')).stopConversation(), 202),
);
app.get('/api/conversations/:id/extensions/:extensionId/resources/:ref', async (c) => {
  const reply = JSON.parse(
    await c.env.CONVERSATIONS.getByName(c.get('conversationId')).loadResource(
      c.req.param('extensionId'),
      c.req.param('ref'),
    ),
  );
  return c.json(reply, reply.error?.status ?? 200);
});
app.patch('/api/conversations/:id/extensions/:extensionId/resources/:ref/state', async (c) => {
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
