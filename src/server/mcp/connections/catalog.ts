import { AppError } from '../../../shared/contracts';
import {
  extensionConfiguration,
  extensionEnabled,
  type ExtensionConfiguration,
} from '../../../extensions/configuration';
import type { ConnectionBinding, ConnectionView } from '../../../shared/mcp-connections';
import { jsonText } from '../../../shared/json';
import { digest } from './digest';
import { connectionKey } from '../configuration';

export function customMcpEnabled(config: ExtensionConfiguration = extensionConfiguration) {
  return extensionEnabled('mcp', config) && config.mcp?.custom !== false;
}
export function connectionView(raw: string): ConnectionView {
  const value = JSON.parse(raw) as ConnectionView | { error: { code: string; status: number } };
  if (!('id' in value)) throw new AppError(value.error.status, value.error.code);
  return value;
}
export function userConnection(env: Env, owner: string, id: string) {
  return env.MCP_CONNECTIONS.getByName(
    connectionKey({ kind: 'user', ownerId: owner, connectionId: id }),
  );
}
export async function ownedConnection(env: Env, owner: string, id: string) {
  const row = await env.DB.prepare(
    'SELECT id FROM mcp_connections WHERE id=? AND owner=? AND deleted_at IS NULL',
  )
    .bind(id, owner)
    .first();
  if (!row) throw new AppError(404, 'mcp_connection_not_found');
  return userConnection(env, owner, id);
}
export async function connectionViews(env: Env, owner: string): Promise<ConnectionView[]> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM mcp_connections WHERE owner=? AND deleted_at IS NULL ORDER BY created_at,id',
  )
    .bind(owner)
    .all<{ id: string }>();
  return Promise.all(
    results.map(async (row) =>
      connectionView(await userConnection(env, owner, row.id).metadata(owner)),
    ),
  );
}
/** Freeze catalog metadata only. Tokens and network sessions are never copied into a conversation. */
export async function newConversationBindings(
  env: Env,
  owner: string,
  ids?: string[],
): Promise<ConnectionBinding[]> {
  if (!customMcpEnabled()) return [];
  const views = await connectionViews(env, owner);
  if (ids?.some((id) => !views.some((v) => v.id === id)))
    throw new AppError(404, 'mcp_connection_not_found');
  const bindings: ConnectionBinding[] = [];
  for (const view of views) {
    if (!view.enabled || view.status !== 'ready' || (ids && !ids.includes(view.id))) continue;
    for (const tool of view.tools.filter((t) => t.supported && t.permission !== 'disabled')) {
      bindings.push({
        connectionId: view.id,
        connectionName: view.name,
        endpoint: view.endpoint,
        grant: view.grant,
        tool,
        name: 'mcp_user_' + (await digest([view.id, tool.name])).slice(0, 24),
      });
    }
  }
  if (bindings.length > 64)
    throw new AppError(400, 'mcp_session_tool_limit', 'Enable at most 64 MCP tools for a new chat');
  jsonText(bindings);
  return bindings;
}
