import { Hono } from 'hono';
import { z } from 'zod';
import { connectionInput, toolPermission } from '../../../shared/mcp-connections';
import { AppError } from '../../../shared/contracts';
import {
  ownedConnection,
  connectionViews,
  customMcpEnabled,
  connectionView,
  userConnection,
} from './catalog';
import { publicMcpUrl } from './endpoint';
import { secretKey } from './secrets';
import { boundedText } from '../../http/body';

export function clientMetadata(appUrl: string) {
  return {
    client_id: new URL('/api/mcp/client-metadata', appUrl).href,
    client_name: 'MkHarness',
    client_uri: new URL(appUrl).origin,
    redirect_uris: [new URL('/api/mcp/callback', appUrl).href],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
export const mcpRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();
mcpRoutes.use('*', async (_c, next) => {
  if (!customMcpEnabled()) throw new AppError(404, 'mcp_disabled');
  await next();
});
async function body(c: { req: { raw: Request } }) {
  try {
    return JSON.parse(await boundedText(new Response(c.req.raw.body), 32 * 1024));
  } catch {
    throw new AppError(400, 'invalid_mcp_request');
  }
}
mcpRoutes.get('/connections', async (c) =>
  c.json({ connections: await connectionViews(c.env, c.get('userId')) }),
);
mcpRoutes.post('/connections', async (c) => {
  const parsed = connectionInput.safeParse(await body(c));
  if (!parsed.success) throw new AppError(400, 'invalid_mcp_request');
  const input = parsed.data;
  publicMcpUrl(input.endpoint);
  await secretKey(c.env);
  const owner = c.get('userId'),
    id = crypto.randomUUID();
  const row = await c.env.DB.prepare(
    'INSERT INTO mcp_connections(id,owner,name,endpoint,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM mcp_connections WHERE owner=? AND deleted_at IS NULL)<10 RETURNING id',
  )
    .bind(id, owner, input.name, input.endpoint, Date.now(), owner)
    .first();
  if (!row) throw new AppError(429, 'mcp_connection_limit');
  try {
    const connection = await userConnection(c.env, owner, id).initialize(owner, id, input);
    return c.json({ connection: connectionView(connection) }, 201);
  } catch (error) {
    await c.env.DB.prepare('UPDATE mcp_connections SET deleted_at=? WHERE id=? AND owner=?')
      .bind(Date.now(), id, owner)
      .run();
    throw error;
  }
});
mcpRoutes.post('/connections/:id/connect', async (c) => {
  const result = await (
    await ownedConnection(c.env, c.get('userId'), c.req.param('id'))
  ).connectRemote(c.get('userId'));
  return c.json({ ...result, connection: connectionView(result.connection) });
});
mcpRoutes.patch('/connections/:id', async (c) => {
  const parsed = z
    .object({
      revision: z.number().int().positive(),
      enabled: z.boolean().optional(),
      permissions: z.record(z.string(), toolPermission).optional(),
    })
    .strict()
    .safeParse(await body(c));
  if (!parsed.success) throw new AppError(400, 'invalid_mcp_request');
  return c.json({
    connection: connectionView(
      await (
        await ownedConnection(c.env, c.get('userId'), c.req.param('id'))
      ).configure(c.get('userId'), parsed.data),
    ),
  });
});
mcpRoutes.delete('/connections/:id', async (c) => {
  const owner = c.get('userId'),
    id = c.req.param('id');
  await (await ownedConnection(c.env, owner, id)).disconnect(owner);
  await c.env.DB.prepare('UPDATE mcp_connections SET deleted_at=? WHERE id=? AND owner=?')
    .bind(Date.now(), id, owner)
    .run();
  return c.json({ deleted: true });
});
mcpRoutes.get('/callback', async (c) => {
  const owner = c.get('userId'),
    id = c.req.query('state')?.split('.').at(-1);
  try {
    if (!id || !z.uuid().safeParse(id).success) throw new AppError(400, 'invalid_oauth_state');
    const result = await (await ownedConnection(c.env, owner, id)).callback(owner, c.req.url);
    if (!result.ok) throw new AppError(400, result.code ?? 'mcp_authorization_failed');
    return c.redirect(new URL('/?mcp=connected', c.env.APP_URL).href, 303);
  } catch {
    return c.redirect(new URL('/?mcp=error', c.env.APP_URL).href, 303);
  }
});
