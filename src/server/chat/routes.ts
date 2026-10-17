import { Hono } from 'hono';
import { boundedText } from '../http/body';
import {
  AppError,
  commandSchema,
  conversationTitleSchema,
  createConversationSchema,
} from '../../shared/contracts';
import { finiteJson } from '../../shared/json';
import { queueActionSchema } from '../../shared/queue';
import {
  createChat,
  directoryActor,
  listChats,
  resolveChat,
  type ChatDirectoryRow,
} from './directory';

function jsonResult(value: unknown, success = 200) {
  const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
  const status =
    error && typeof error === 'object' && 'status' in error ? Number(error.status) : success;
  return Response.json(value, { status });
}

function nativeTarget(raw: string | undefined) {
  if (raw === undefined) return {};
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new AppError(400, 'invalid_target');
  return { target: Number(raw) };
}

async function jsonBody(request: Request, limit: number) {
  let raw: string;
  try {
    raw = await boundedText(new Response(request.body, { headers: request.headers }), limit);
  } catch {
    throw new AppError(413, 'request_too_large');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(400, 'invalid_json');
  }
}

export const conversationRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; conversationId: string; chat: ChatDirectoryRow };
}>();

conversationRoutes.get('/', async (c) =>
  c.json(await listChats(c.env, c.get('userId'), c.req.query('cursor'))),
);

conversationRoutes.post('/', async (c) => {
  const parsed = createConversationSchema.safeParse(await jsonBody(c.req.raw, 4096));
  if (!parsed.success) throw new AppError(400, 'invalid_request');
  const chat = await createChat(c.env, c.get('userId'), parsed.data);
  return c.json({ id: chat.id, title: chat.title }, 201);
});

conversationRoutes.use('/:id/*', async (c, next) => {
  const chat = await resolveChat(
    c.env,
    c.get('userId'),
    c.req.param('id'),
    c.req.method === 'DELETE',
  );
  if (c.req.query('view') !== undefined)
    throw new AppError(
      400,
      'protocol_mismatch',
      'Refresh the app to use the current chat protocol.',
    );
  c.set('chat', chat);
  c.set('conversationId', chat.id);
  await next();
});

conversationRoutes.patch('/:id', async (c) => {
  const body = await jsonBody(c.req.raw, 2048);
  const title = conversationTitleSchema.safeParse(
    body && typeof body === 'object' && 'title' in body ? body.title : undefined,
  );
  if (!title.success) throw new AppError(400, 'invalid_title', '标题需为 1 至 120 个字符');
  const renamed = await c.env.DB.prepare(
    "UPDATE conversations SET title=?,title_custom=1 WHERE id=? AND owner=? AND instance_generation=? AND lifecycle='active' RETURNING id,title,updated_at",
  )
    .bind(title.data, c.get('chat').id, c.get('userId'), c.get('chat').instance_generation)
    .first();
  if (!renamed) throw new AppError(404, 'not_found');
  return c.json(renamed);
});

conversationRoutes.delete('/:id', async (c) => {
  const chat = c.get('chat');
  if (chat.lifecycle === 'deleted') return c.json({ deleting: true }, 202);
  const result = await c.env.CONVERSATIONS.getByName(chat.id).command(directoryActor(chat), {
    type: 'delete',
  });
  if (result && typeof result === 'object' && 'error' in result) return jsonResult(result);
  // The chat DO owns erasure. Keep this row and its create receipt to refuse stale initialization.
  await c.env.DB.prepare(
    "UPDATE conversations SET lifecycle='deleting' WHERE id=? AND owner=? AND instance_generation=? AND lifecycle='active'",
  )
    .bind(chat.id, chat.owner, chat.instance_generation)
    .run();
  return c.json({ deleting: true }, 202);
});

conversationRoutes.post('/:id/extensions/:extensionId/controls/:name', async (c) => {
  const payload = await jsonBody(c.req.raw, 4096);
  const result = await c.env.CONVERSATIONS.getByName(c.get('chat').id).command(
    directoryActor(c.get('chat')),
    {
      type: 'extension_control',
      extensionId: c.req.param('extensionId'),
      name: c.req.param('name'),
      payload: JSON.stringify(payload),
      ...nativeTarget(c.req.query('conversationId')),
    },
  );
  return jsonResult(result);
});

conversationRoutes.post('/:id/runs', async (c) => {
  const parsed = commandSchema.safeParse(await jsonBody(c.req.raw, 1048576));
  if (!parsed.success) throw new AppError(400, 'invalid_request');
  const chat = c.get('chat');
  const result = await c.env.CONVERSATIONS.getByName(chat.id).command(directoryActor(chat), {
    type: 'submit',
    command: parsed.data,
    ...nativeTarget(c.req.query('conversationId')),
  });
  if (result && typeof result === 'object' && 'error' in result) return jsonResult(result);
  // A directory projection failure must not turn an accepted native submission into a retry.
  await c.env.DB.prepare(
    "UPDATE conversations SET title=CASE WHEN title_custom=0 AND title='新聊天' THEN ? ELSE title END,updated_at=? WHERE id=? AND owner=? AND instance_generation=? AND lifecycle='active'",
  )
    .bind(
      (parsed.data.text || parsed.data.images?.[0]?.name || '新聊天').slice(0, 60),
      Date.now(),
      chat.id,
      chat.owner,
      chat.instance_generation,
    )
    .run()
    .catch(() =>
      console.error(
        JSON.stringify({ stage: 'chat_directory', chatId: chat.id, error: 'projection_failed' }),
      ),
    );
  return jsonResult(result, 202);
});

conversationRoutes.get('/:id/snapshot', async (c) => {
  if (c.req.query('cursor') !== undefined) throw new AppError(400, 'invalid_cursor');
  return jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).read(directoryActor(c.get('chat')), {
      type: 'snapshot',
      ...nativeTarget(c.req.query('conversationId')),
    }),
  );
});

conversationRoutes.get('/:id/history', async (c) =>
  jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).read(directoryActor(c.get('chat')), {
      type: 'history',
      cursor: c.req.query('cursor'),
      ...nativeTarget(c.req.query('conversationId')),
    }),
  ),
);

conversationRoutes.post('/:id/runs/:runId/queue', async (c) => {
  const parsed = queueActionSchema.safeParse(await jsonBody(c.req.raw, 1024));
  if (!parsed.success) throw new AppError(400, 'invalid_request');
  return jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).command(directoryActor(c.get('chat')), {
      type: 'queue',
      runId: c.req.param('runId'),
      action: parsed.data.action,
      ...nativeTarget(c.req.query('conversationId')),
    }),
  );
});

conversationRoutes.post('/:id/runs/:runId/queue/ack', async (c) =>
  jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).command(directoryActor(c.get('chat')), {
      type: 'acknowledge_queue_edit',
      runId: c.req.param('runId'),
      ...nativeTarget(c.req.query('conversationId')),
    }),
  ),
);

conversationRoutes.get('/:id/runs/:runId/events', (c) =>
  c.env.CONVERSATIONS.getByName(c.get('chat').id).observe(directoryActor(c.get('chat')), {
    runId: c.req.param('runId'),
    ...nativeTarget(c.req.query('conversationId')),
  }),
);

conversationRoutes.post('/:id/stop', async (c) =>
  jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).command(directoryActor(c.get('chat')), {
      type: 'stop',
      ...nativeTarget(c.req.query('conversationId')),
    }),
    202,
  ),
);

conversationRoutes.get('/:id/extensions/:extensionId/resources/:ref', async (c) =>
  jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).read(directoryActor(c.get('chat')), {
      type: 'resource',
      extensionId: c.req.param('extensionId'),
      ref: c.req.param('ref'),
      ...nativeTarget(c.req.query('conversationId')),
    }),
  ),
);

conversationRoutes.patch('/:id/extensions/:extensionId/resources/:ref/state', async (c) => {
  const body = await jsonBody(c.req.raw, 1048576);
  if (
    !body ||
    typeof body !== 'object' ||
    !('state' in body) ||
    !('expectedRevision' in body) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0
  )
    throw new AppError(400, 'invalid_state');
  try {
    finiteJson(body.state);
  } catch {
    throw new AppError(400, 'invalid_state');
  }
  return jsonResult(
    await c.env.CONVERSATIONS.getByName(c.get('chat').id).command(directoryActor(c.get('chat')), {
      type: 'save_resource_state',
      extensionId: c.req.param('extensionId'),
      ref: c.req.param('ref'),
      state: body.state,
      expectedRevision: Number(body.expectedRevision),
      ...nativeTarget(c.req.query('conversationId')),
    }),
  );
});
