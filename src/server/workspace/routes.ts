import { Hono } from 'hono';
import { z } from 'zod';
import {
  AppError,
  createConversationSchema,
  conversationTitleSchema,
} from '../../shared/contracts';
import { workspaceCommandSchema } from '../../shared/workspace';
import { boundedText } from '../http/body';
import { directoryActor, createChat } from '../chat/directory';
import { listScenarios, resolveScenario } from './directory';
import { renderReport, reportRuntimeMessages } from '../../scenarios/reports/template';
import type { ReportRevision } from './documents';
import type { Json } from '../../shared/json';
function result(value: unknown, success = 200) {
  if (value && typeof value === 'object' && 'status' in value && value.status === 'accepted')
    success = 202;
  const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
  return Response.json(value, {
    status:
      error && typeof error === 'object' && 'status' in error ? Number(error.status) : success,
  });
}
async function body(request: Request) {
  try {
    return JSON.parse(
      await boundedText(new Response(request.body, { headers: request.headers }), 1100000),
    ) as unknown;
  } catch {
    throw new AppError(400, 'invalid_request');
  }
}
export const scenarioRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
scenarioRoutes.get('/', async (c) =>
  c.json({ items: await listScenarios(c.env, c.get('userId'), c.req.query('kind') ?? 'canvas') }),
);
scenarioRoutes.post('/', async (c) => {
  const request = createConversationSchema
    .extend({ kind: z.literal('canvas') })
    .strict()
    .parse(await body(c.req.raw));
  const chat = await createChat(
    c.env,
    c.get('userId'),
    { requestId: request.requestId },
    request.kind,
  );
  const stub = c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id);
  const initialized = await stub.workspaceRead(directoryActor(chat), 'snapshot', {});
  if (initialized && typeof initialized === 'object' && 'error' in initialized)
    return result(initialized);
  return c.json(
    {
      id: chat.scenario_id!,
      mainChatId: chat.id,
      workspaceId: chat.workspace_id!,
      kind: chat.kind!,
      title: chat.title!,
      titleCustom: !!chat.title_custom,
      updatedAt: chat.updated_at!,
    },
    201,
  );
});
scenarioRoutes.get('/chat/:id', async (c) => {
  const { resolveChat } = await import('../chat/directory');
  const chat = await resolveChat(c.env, c.get('userId'), c.req.param('id'));
  return c.json({
    id: chat.scenario_id!,
    mainChatId: chat.id,
    workspaceId: chat.workspace_id!,
    kind: chat.kind!,
    title: chat.title!,
    titleCustom: !!chat.title_custom,
    updatedAt: chat.updated_at!,
  });
});
scenarioRoutes.get('/:id', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  return c.json({
    id: chat.scenario_id!,
    mainChatId: chat.id,
    workspaceId: chat.workspace_id!,
    kind: chat.kind!,
    title: chat.title!,
    titleCustom: !!chat.title_custom,
    updatedAt: chat.updated_at!,
  });
});
scenarioRoutes.patch('/:id', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  const { title } = z
    .object({ title: conversationTitleSchema })
    .strict()
    .parse(await body(c.req.raw));
  await c.env.DB.prepare(
    "UPDATE conversations SET title=?,title_custom=1,updated_at=? WHERE id=? AND owner=? AND lifecycle='active'",
  )
    .bind(title, Date.now(), chat.id, chat.owner)
    .run();
  return c.json({ ok: true });
});
scenarioRoutes.delete('/:id', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'), true);
  return result(
    await c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id).command(
      directoryActor(chat),
      { type: 'delete' },
    ),
    202,
  );
});
scenarioRoutes.post('/:id/workspace/read', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  const value = z
    .object({
      query: z.string().regex(/^[a-z][a-z0-9_.-]{0,100}$/),
      input: z.json().default({}),
      cursor: z.string().max(4096).optional(),
    })
    .strict()
    .parse(await body(c.req.raw));
  return result(
    await c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id).workspaceRead(
      directoryActor(chat),
      value.query,
      value.input as Json,
      value.cursor,
    ),
  );
});
scenarioRoutes.post('/:id/workspace/execute', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  const command = workspaceCommandSchema.parse(await body(c.req.raw));
  const response = await c.env.CONVERSATIONS.getByName(
    chat.runtime_name ?? chat.id,
  ).workspaceExecute(directoryActor(chat), command);
  return result(response);
});
scenarioRoutes.get('/:id/workspace/events', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  return c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id).workspaceWatch(
    directoryActor(chat),
  );
});
scenarioRoutes.get('/:id/assets/:assetId', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  return c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id).workspaceAsset(
    directoryActor(chat),
    c.req.param('assetId'),
    c.req.query('download') === '1',
  );
});
scenarioRoutes.get('/:id/reports/:reportId/export', async (c) => {
  const chat = await resolveScenario(c.env, c.get('userId'), c.req.param('id'));
  const stub = c.env.CONVERSATIONS.getByName(chat.runtime_name ?? chat.id),
    actor = directoryActor(chat);
  const revision =
    c.req.query('revision') === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(c.req.query('revision'));
  const raw = await stub.workspaceRead(actor, 'report', {
    id: c.req.param('reportId'),
    ...(revision ? { revision } : {}),
  });
  if (!raw || typeof raw !== 'object' || 'error' in raw) return result(raw);
  const report = raw as ReportRevision;
  let source = report.source;
  let total = 0;
  const ids = [
    ...new Set([...source.matchAll(/workspace-asset:([a-zA-Z0-9:_-]+)/g)].map((match) => match[1])),
  ];
  for (const id of ids) {
    const response = await stub.workspaceAsset(actor, id, false);
    if (!response.ok) throw new AppError(409, 'report_asset_unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    total += bytes.byteLength;
    if (total > 20 * 1048576) throw new AppError(413, 'report_export_too_large');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    source = source.replaceAll(
      `workspace-asset:${id}`,
      `data:${response.headers.get('Content-Type')};base64,${btoa(binary)}`,
    );
  }
  const locale = c.req.query('locale') === 'zh-CN' ? 'zh-CN' : 'en';
  const html = renderReport(
    source,
    {
      id: report.template,
      dependencies: report.dependencies,
      styles: report.styles,
    },
    '',
    reportRuntimeMessages[locale],
  );
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="report.html"',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
});
