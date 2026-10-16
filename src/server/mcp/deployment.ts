import { schemaAccepted, convertResult } from './connections/protocol';
import type { MCPClientManager } from 'agents/mcp/client';
import {
  defineDoc,
  defineTool,
  hook,
  ToolTask,
  type Extension,
  type TaskId,
} from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { AppError, type StoredCommand } from '../../shared/contracts';
import { canonicalJson, jsonText, type Json } from '../../shared/json';
import { JSON_TOOL_OUTPUT_LIMITS } from '../extensions/tool-output';
import { McpIntents, mcpIntentUnresolved } from './intents';

export type MCPConfig = {
  serverId: string;
  endpoint: string;
  allowlist: string[];
  credential?: string;
  safeTools?: string[];
};
export type MCPBinding = {
  serverId: string;
  endpoint: string;
  remoteName: string;
  name: string;
  schema: { [key: string]: Json };
  description: string;
  replay: 'safe' | 'unsafe';
};
export const MCPBindings = defineDoc<{ bindings: MCPBinding[] }>({
  kind: 'app.mcp-bindings',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ bindings: [] }),
});
const validServer = /^[a-z][a-z0-9-]{0,31}$/;
const validTool = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export function mcpConfiguration(env: {
  MCP_SERVERS?: string;
  [key: string]: unknown;
}): MCPConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(env.MCP_SERVERS ?? '[]');
  } catch {
    throw new AppError(503, 'mcp_configuration_invalid');
  }
  if (!Array.isArray(raw) || raw.length > 10) throw new AppError(503, 'mcp_configuration_invalid');
  const seen = new Set<string>();
  for (const item of raw) {
    if (
      !item ||
      typeof item.serverId !== 'string' ||
      !validServer.test(item.serverId) ||
      seen.has(item.serverId) ||
      !Array.isArray(item.allowlist) ||
      !item.allowlist.every((name: unknown) => typeof name === 'string' && validTool.test(name))
    )
      throw new AppError(503, 'mcp_configuration_invalid');
    let url: URL;
    try {
      url = new URL(item.endpoint);
    } catch {
      throw new AppError(503, 'mcp_endpoint_invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
      throw new AppError(503, 'mcp_endpoint_invalid');
    if (
      item.safeTools &&
      (!Array.isArray(item.safeTools) ||
        !item.safeTools.every((name: unknown) => item.allowlist.includes(name)))
    )
      throw new AppError(503, 'mcp_configuration_invalid');
    if (
      item.credential &&
      (typeof item.credential !== 'string' ||
        typeof env[item.credential] !== 'string' ||
        !env[item.credential])
    )
      throw new AppError(503, 'mcp_credential_missing');
    seen.add(item.serverId);
  }
  return raw as MCPConfig[];
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(503, 'mcp_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
const failure = (code: string) => ({
  isError: true,
  output: [{ type: 'text' as const, text: JSON.stringify({ error: { code } }) }],
});
function sameDefinition(
  binding: MCPBinding,
  tool: ReturnType<MCPClientManager['listTools']>[number] | undefined,
  config: MCPConfig | undefined,
) {
  if (!tool || !config) return false;
  try {
    return (
      config.endpoint === binding.endpoint &&
      config.allowlist.includes(binding.remoteName) &&
      canonicalJson(tool.inputSchema) === canonicalJson(binding.schema) &&
      (tool.description ?? tool.name).slice(0, 4096) === binding.description &&
      (config.safeTools?.includes(binding.remoteName) ? 'safe' : 'unsafe') === binding.replay
    );
  } catch {
    return false;
  }
}
function serverOptions(
  config: MCPConfig,
  env: Record<string, unknown>,
): Parameters<MCPClientManager['registerServer']>[1] {
  return {
    url: config.endpoint,
    name: config.serverId,
    transport: {
      type: 'streamable-http' as const,
      requestInit: {
        redirect: 'manual' as const,
      },
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        // Native MCP persists requestInit. Inject deployment secrets only at the
        // network boundary, keeping them out of the recoverable connection row.
        const headers = new Headers(
          init?.headers ?? (url instanceof Request ? url.headers : undefined),
        );
        const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
        if (config.credential) headers.set('Authorization', `Bearer ${env[config.credential]}`);
        const response = await fetch(url, {
          ...init,
          headers,
          redirect: 'manual',
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
        });
        if (response.status >= 300 && response.status < 400)
          throw new AppError(503, 'mcp_redirect_blocked');
        if (!response.body) return response;
        let bytes = 0;
        const boundedBody = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > 2 * 1024 * 1024) throw new AppError(503, 'mcp_result_too_large');
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(boundedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    },
  };
}

/** Install before Lifecycle startup; deployment configuration owns live connections. */
export function configureMcpStartup(
  manager: MCPClientManager,
  configs: () => MCPConfig[],
  env: Record<string, unknown>,
) {
  const restore = manager.restoreConnectionsFromStorage.bind(manager);
  // SDK 0.28 restores before Pi starts, omits fetch from persistence, and registerServer
  // reuses an existing connection rather than updating its transport. Assemble first,
  // after the SDK creates its catalog, then let native restoration reuse these connections.
  manager.restoreConnectionsFromStorage = async (clientName) => {
    const current = configs();
    for (const server of manager.listServers())
      if (!current.some((config) => config.serverId === server.id))
        await manager.removeServer(server.id);
    for (const config of current)
      await manager.registerServer(config.serverId, serverOptions(config, env));
    await restore(clientName);
  };
}

async function connect(manager: MCPClientManager, serverId: string) {
  if (manager.mcpConnections[serverId]?.connectionState === 'ready') return;
  const connected = await manager.connectToServer(serverId).catch(() => {
    throw new AppError(503, 'mcp_connection_failed');
  });
  if (connected.state !== 'connected')
    throw new AppError(
      503,
      connected.state === 'authenticating' ? 'mcp_unauthorized' : 'mcp_connection_failed',
    );
  const found = await manager.discoverIfConnected(serverId, { timeoutMs: 15000 }).catch(() => {
    throw new AppError(503, 'mcp_discovery_failed');
  });
  if (!found?.success) throw new AppError(503, 'mcp_discovery_failed');
}
/** Adapter only: discovery and calls use the SDK manager; Pi owns tool execution/history. */
export async function buildMcp(
  manager: MCPClientManager,
  configs: MCPConfig[],
  env: Record<string, unknown>,
  pinned?: readonly MCPBinding[],
  command?: () => Promise<StoredCommand>,
) {
  const bindings: MCPBinding[] = [...(pinned ?? [])];
  const availability = new Map<string, string>();
  const diagnostics: { serverId: string; toolName?: string; code: string }[] = [];
  for (const config of configs) {
    const previous = bindings.filter((b) => b.serverId === config.serverId);
    if (previous.some((b) => b.endpoint !== config.endpoint)) {
      diagnostics.push({ serverId: config.serverId, code: 'mcp_definition_changed' });
      for (const binding of previous) availability.set(binding.name, 'mcp_definition_changed');
      continue;
    }
    let discovered: ReturnType<MCPClientManager['listTools']>;
    try {
      await bounded(
        (async () => {
          await manager.registerServer(config.serverId, serverOptions(config, env));
          await connect(manager, config.serverId);
        })(),
        15000,
      );
      discovered = manager.listTools({ serverId: config.serverId });
      jsonText(discovered);
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'mcp_connection_failed';
      diagnostics.push({ serverId: config.serverId, code });
      continue;
    }
    if (!previous.length) {
      for (const tool of discovered) {
        if (!config.allowlist.includes(tool.name)) continue;
        const name = `mcp_${config.serverId.replaceAll('-', '_')}_${tool.name}`;
        if (!validTool.test(name)) {
          diagnostics.push({
            serverId: config.serverId,
            toolName: tool.name,
            code: 'mcp_name_invalid',
          });
          continue;
        }
        if (
          !validTool.test(tool.name) ||
          !schemaAccepted(tool.inputSchema) ||
          tool.inputSchema.type !== 'object'
        ) {
          diagnostics.push({
            serverId: config.serverId,
            toolName: tool.name,
            code: 'mcp_schema_unsupported',
          });
          continue;
        }
        const binding: MCPBinding = {
          serverId: config.serverId,
          endpoint: config.endpoint,
          remoteName: tool.name,
          name,
          schema: structuredClone(tool.inputSchema) as MCPBinding['schema'],
          description: (tool.description ?? tool.name).slice(0, 4096),
          replay: config.safeTools?.includes(tool.name) ? 'safe' : 'unsafe',
        };
        if (bindings.some((b) => b.name === binding.name))
          throw new AppError(503, 'mcp_name_collision');
        try {
          jsonText([...bindings, binding]);
        } catch {
          diagnostics.push({
            serverId: config.serverId,
            toolName: tool.name,
            code: 'mcp_definition_too_large',
          });
          continue;
        }
        bindings.push(binding);
      }
    } else
      for (const binding of previous) {
        const tool = discovered.find((t) => t.name === binding.remoteName);
        if (!sameDefinition(binding, tool, config)) {
          availability.set(binding.name, 'mcp_definition_changed');
          diagnostics.push({
            serverId: config.serverId,
            toolName: binding.remoteName,
            code: 'mcp_definition_changed',
          });
        }
      }
  }
  for (const binding of bindings)
    if (!configs.some((c) => c.serverId === binding.serverId))
      availability.set(binding.name, 'mcp_disabled');
  const extension: Extension = {
    name: 'remote-mcp',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const binding = bindings.find((binding) => binding.name === call.name);
          if (!binding || binding.replay === 'safe') return;
          const doc = await api.snapshot(McpIntents, api.conversationId, context);
          for (const intent of Object.values(doc?.mcp ?? {}))
            if (
              (intent.serverId === binding.serverId || intent.endpoint === binding.endpoint) &&
              intent.status !== 'responded'
            )
              return {
                block:
                  'remote_outcome_unknown: reconcile this MCP operation before another unsafe call',
              };
        },
      }),
    ],
    tools: bindings.map((binding) =>
      defineTool({
        name: binding.name,
        description: binding.description,
        parameters: Type.Unsafe<Record<string, Json>>(binding.schema),
        replay: binding.replay,
        outputLimits: JSON_TOOL_OUTPUT_LIMITS,
        execute: async (args, api, context) => {
          const signal = context.abortSignal ?? new AbortController().signal;
          if (availability.has(binding.name)) return failure(availability.get(binding.name)!);
          let dispatched = false;
          try {
            if (binding.replay === 'unsafe') {
              const intents =
                (await api.snapshot(McpIntents, api.conversationId, context))?.mcp ?? {};
              for (const intent of Object.values(intents))
                if (
                  (intent.serverId === binding.serverId || intent.endpoint === binding.endpoint) &&
                  mcpIntentUnresolved(intent, await api.getTask(intent.taskId as TaskId, context))
                )
                  return failure('remote_outcome_unknown');
            }
            jsonText(args);
            // A prior transient outage is not a changed definition. Retry connection on this
            // tool invocation only; retain the binding and verify the recovered live catalog.
            await bounded(connect(manager, binding.serverId), 15000);
            // SDK list_changed notifications update this in-memory catalog. Check it without
            // network rediscovery and never dispatch a known changed definition under the old name.
            const tool = manager
              .listTools({ serverId: binding.serverId })
              .find((current) => current.name === binding.remoteName);
            if (
              !sameDefinition(
                binding,
                tool,
                configs.find((config) => config.serverId === binding.serverId),
              )
            ) {
              availability.set(binding.name, 'mcp_definition_changed');
              diagnostics.push({
                serverId: binding.serverId,
                toolName: binding.remoteName,
                code: 'mcp_definition_changed',
              });
              return failure('mcp_definition_changed');
            }
            for (let i = diagnostics.length - 1; i >= 0; i--)
              if (
                diagnostics[i].serverId === binding.serverId &&
                !diagnostics[i].toolName &&
                diagnostics[i].code !== 'mcp_definition_changed'
              )
                diagnostics.splice(i, 1);
            if (binding.replay === 'unsafe') {
              if (!command) return failure('mcp_host_context_missing');
              const runId = (await command()).runId;
              await api.commit(async (tx) => {
                const doc = await tx.doc(McpIntents, api.conversationId);
                doc.mcp ??= {};
                // Read the tracked document view after assignment. The assignment's
                // raw object is not the Pi draft proxy and later mutations won't commit.
                const intents = doc.mcp;
                if (intents[api.taskId]) throw new AppError(409, 'remote_outcome_unknown');
                intents[api.taskId] = {
                  taskId: Number(api.taskId),
                  runId,
                  callId: api.callId,
                  serverId: binding.serverId,
                  endpoint: binding.endpoint,
                  toolName: binding.name,
                  status: 'dispatching',
                };
              }, context);
            }
            dispatched = true;
            const result = await bounded(
              manager.callTool(
                { serverId: binding.serverId, name: binding.remoteName, arguments: args },
                { signal: signal, timeout: 30000, maxTotalTimeout: 30000 },
              ),
              30000,
            );
            const converted = convertResult(result);
            if (binding.replay === 'unsafe')
              await api.commit(async (tx) => {
                (await tx.doc(McpIntents, api.conversationId)).mcp![api.taskId]!.status =
                  'responded';
              }, context);
            return converted;
          } catch (e) {
            if (dispatched && binding.replay === 'unsafe') {
              // The dispatch intent already protects Stop/reconstruction. A native
              // abort mark forbids more writes from this invocation; changing its
              // Context cannot bypass that boundary or prove the remote canceled.
              signal.throwIfAborted();
              await api.commit(async (tx) => {
                const intent = (await tx.doc(McpIntents, api.conversationId)).mcp?.[api.taskId];
                if (intent) intent.status = 'unknown';
              }, context);
              return failure('remote_outcome_unknown');
            }
            return failure(
              e instanceof AppError
                ? e.code
                : (e as Error).message === 'JSON size limit exceeded'
                  ? 'mcp_result_too_large'
                  : signal.aborted
                    ? 'mcp_cancelled'
                    : 'mcp_call_failed',
            );
          }
        },
      }),
    ),
  };
  return { extension, bindings, diagnostics };
}
