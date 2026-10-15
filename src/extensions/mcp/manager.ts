import { useMemo } from 'react';
import { resource, withKey } from '@assistant-ui/tap';
import { useClientLookup, type ClientOutput } from '@assistant-ui/store';
import type { MCPManagerMethods, MCPServerState } from '@assistant-ui/react-mcp';
import type { ConnectionView } from '../../shared/mcp-connections';

export type McpManagementActions = {
  connect(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  add: MCPManagerMethods['addCustomServer'];
};
export function connectionState(view: ConnectionView): MCPServerState {
  const statuses = {
    ready: 'connected',
    connecting: 'disconnected',
    authorizing: 'authRequired',
    reauthorize: 'authRequired',
    disconnected: 'disconnected',
    error: 'error',
  } as const;
  return {
    id: view.id,
    kind: 'custom',
    name: view.name,
    url: view.endpoint,
    connectionState: view.enabled ? statuses[view.status] : 'disconnected',
    lastError: view.error ? { message: view.error } : null,
    tools: view.tools
      .filter((tool) => tool.supported && tool.permission !== 'disabled')
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.schema,
      })),
    authorizationUrl: null,
    pendingElicitations: [],
  };
}
const unavailable = async (): Promise<never> => {
  throw new Error('MCP execution and OAuth callbacks are managed by the server.');
};
function useServerConnection({
  view,
  actions,
}: {
  view: ConnectionView;
  actions: McpManagementActions;
}): ClientOutput<'mcpServer'> {
  const state = useMemo(() => connectionState(view), [view]);
  return {
    getState: () => state,
    connect: () => actions.connect(view.id),
    disconnect: () => actions.disable(view.id),
    remove: () => actions.remove(view.id),
    callTool: unavailable,
    completeAuth: unavailable,
    listResources: unavailable,
    readResource: unavailable,
    answerElicitation: () => {
      throw new Error('MCP elicitation is not available.');
    },
  };
}
const ServerConnection = resource(useServerConnection);

/** Presentation-only scope for the official primitives. No browser transport, token store,
 * auto-connect, modelContext registration, or tool execution is installed. */
function useServerMcpManager({
  views,
  actions,
  hydrated,
}: {
  views: ConnectionView[];
  actions: McpManagementActions;
  hydrated: boolean;
}): ClientOutput<'mcp'> {
  const lookup = useClientLookup(
    views.map((view) => withKey(view.id, ServerConnection({ view, actions }))),
  );
  const byIndex = (index: number) => lookup.get({ index });
  const state = useMemo(
    () => ({
      servers: lookup.state,
      connectors: [],
      customServers: lookup.state,
      isHydrated: hydrated,
    }),
    [lookup.state, hydrated],
  );
  return {
    getState: () => state,
    server: (query) => {
      if ('id' in query) return lookup.get({ key: query.id });
      if (query.kind === 'connector') throw new Error('Preset connectors are not configured.');
      return byIndex(query.index);
    },
    customServer: ({ index }) => byIndex(index),
    connector: () => {
      throw new Error('Preset connectors are not configured.');
    },
    addCustomServer: actions.add,
    removeServer: actions.remove,
  };
}
export const ServerMcpManager = resource(useServerMcpManager);
