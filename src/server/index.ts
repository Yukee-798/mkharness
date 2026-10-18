import { modelRoutes } from './models/routes';
import { conversationRoutes } from './chat/routes';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { auth } from './auth';
import { extensionIds } from '../extensions/server';
import { AppError } from '../shared/contracts';
import { skillRoutes } from './skills/routes';
import { skillsEnabled } from './skills/catalog';
import { mcpRoutes, clientMetadata } from './mcp/connections/routes';
import { customMcpEnabled } from './mcp/connections/catalog';

const app = new Hono<{ Bindings: Env; Variables: { userId: string; conversationId: string } }>();
app.get('/api/mcp/client-metadata', (c) =>
  customMcpEnabled() ? c.json(clientMetadata(c.env.APP_URL)) : c.notFound(),
);
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});
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
app.get('/api/capabilities', (c) =>
  c.json({ extensionIds: extensionIds(), customMcp: customMcpEnabled(), skills: skillsEnabled() }),
);
app.route('/api/mcp', mcpRoutes);
app.route('/api/skills', skillRoutes);
app.route('/api/settings', modelRoutes);
app.route('/api/conversations', conversationRoutes);
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
export { ChatSession } from './chat/session-object';
