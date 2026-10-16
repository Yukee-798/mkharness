import handler from '@tanstack/react-start/server-entry';
import api from './server/index';

export { ConversationAgent } from './server/conversations/agent';
export { McpConnection } from './server/mcp/connections/connection';

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
