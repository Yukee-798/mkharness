import type { MCPClientManager } from 'agents/mcp/client';
import { defineDoc, defineTool, type Extension } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { AppError } from '../shared/contracts';
import { canonicalJson, finiteJson, jsonText, type Json } from '../shared/compute';

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
function schemaAccepted(schema: unknown, depth = 0): schema is MCPBinding['schema'] {
  if (depth > 20 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  const keys = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'anyOf',
    'description',
    'title',
    'default',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'pattern',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ]);
  if (Object.keys(s).some((key) => !keys.has(key))) return false;
  if (
    'required' in s &&
    (!Array.isArray(s.required) || !s.required.every((v) => typeof v === 'string'))
  )
    return false;
  if (
    'additionalProperties' in s &&
    typeof s.additionalProperties !== 'boolean' &&
    (typeof s.additionalProperties !== 'object' || s.additionalProperties === null)
  )
    return false;
  if (
    'properties' in s &&
    (s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties))
  )
    return false;
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
    if (
      key in s &&
      (typeof s[key] !== 'number' ||
        !Number.isFinite(s[key]) ||
        (key === 'multipleOf' && (s[key] as number) <= 0))
    )
      return false;
  for (const key of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ])
    if (key in s && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0)) return false;
  if ('pattern' in s) {
    if (typeof s.pattern !== 'string' || s.pattern.length > 4096) return false;
    try {
      new RegExp(s.pattern);
    } catch {
      return false;
    }
  }
  for (const key of ['title', 'description'])
    if (key in s && typeof s[key] !== 'string') return false;
  if ('enum' in s && (!Array.isArray(s.enum) || !s.enum.length)) return false;
  if (
    s.type !== undefined &&
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
      s.type as string,
    )
  )
    return false;
  if (!s.type && !s.anyOf && !s.enum && !('const' in s)) return false;
  if (s.anyOf && (!Array.isArray(s.anyOf) || !s.anyOf.every((v) => schemaAccepted(v, depth + 1))))
    return false;
  if (
    s.properties &&
    (typeof s.properties !== 'object' ||
      Array.isArray(s.properties) ||
      !Object.values(s.properties).every((v) => schemaAccepted(v, depth + 1)))
  )
    return false;
  if (s.items && !schemaAccepted(s.items, depth + 1)) return false;
  if (
    typeof s.additionalProperties === 'object' &&
    !schemaAccepted(s.additionalProperties, depth + 1)
  )
    return false;
  return true;
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
  content: [{ type: 'text' as const, text: JSON.stringify({ error: { code } }) }],
});
function convertResult(raw: unknown) {
  finiteJson(raw);
  const value = raw as Record<string, Json>;
  jsonText(value); // UTF-8 size, finite values, 1 MiB ceiling.
  const blocks = value.content;
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      (block) =>
        !block ||
        typeof block !== 'object' ||
        Array.isArray(block) ||
        block.type !== 'text' ||
        typeof block.text !== 'string',
    )
  )
    throw new AppError(503, 'mcp_unsupported_content');
  return {
    isError: value.isError === true,
    content: [
      ...blocks.map((block) => ({
        type: 'text' as const,
        text: (block as Record<string, Json>).text as string,
      })),
      ...('structuredContent' in value
        ? [{ type: 'text' as const, text: JSON.stringify(value.structuredContent) }]
        : []),
    ],
  };
}
/** Adapter only: discovery and calls use the SDK manager; Pi owns tool execution/history. */
export async function buildMcp(
  manager: MCPClientManager,
  configs: MCPConfig[],
  env: Record<string, unknown>,
  pinned?: readonly MCPBinding[],
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
          await manager.registerServer(config.serverId, {
            url: config.endpoint,
            name: config.serverId,
            transport: {
              type: 'streamable-http',
              requestInit: {
                redirect: 'manual',
                headers: config.credential
                  ? { Authorization: `Bearer ${env[config.credential]}` }
                  : {},
              },
              fetch: async (url, init) => {
                const response = await fetch(url, {
                  ...init,
                  redirect: 'manual',
                  signal: AbortSignal.any([
                    ...(init?.signal ? [init.signal] : []),
                    AbortSignal.timeout(30000),
                  ]),
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
          });
          const connected = await manager.connectToServer(config.serverId);
          if (connected.state !== 'connected')
            throw new AppError(
              503,
              connected.state === 'authenticating' ? 'mcp_unauthorized' : 'mcp_connection_failed',
            );
          const found = await manager.discoverIfConnected(config.serverId, { timeoutMs: 15000 });
          if (!found?.success) throw new AppError(503, 'mcp_discovery_failed');
        })(),
        15000,
      );
      discovered = manager.listTools({ serverId: config.serverId });
      jsonText(discovered);
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'mcp_connection_failed';
      diagnostics.push({ serverId: config.serverId, code });
      for (const binding of previous) availability.set(binding.name, code);
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
          schema: tool.inputSchema as MCPBinding['schema'],
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
        if (
          !config.allowlist.includes(binding.remoteName) ||
          !tool ||
          canonicalJson(tool.inputSchema) !== canonicalJson(binding.schema) ||
          (tool.description ?? tool.name).slice(0, 4096) !== binding.description ||
          (config.safeTools?.includes(binding.remoteName) ? 'safe' : 'unsafe') !== binding.replay
        ) {
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
    tools: bindings.map((binding) =>
      defineTool({
        name: binding.name,
        description: binding.description,
        parameters: Type.Unsafe<Record<string, Json>>(binding.schema),
        replay: binding.replay,
        execute: async (args, _api, context) => {
          const signal = context.abortSignal ?? new AbortController().signal;
          if (availability.has(binding.name)) return failure(availability.get(binding.name)!);
          try {
            jsonText(args);
            const result = await bounded(
              manager.callTool(
                { serverId: binding.serverId, name: binding.remoteName, arguments: args },
                { signal: signal, timeout: 30000, maxTotalTimeout: 30000 },
              ),
              30000,
            );
            return convertResult(result);
          } catch (e) {
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
