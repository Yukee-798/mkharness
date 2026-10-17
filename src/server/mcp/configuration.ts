import { AppError } from '../../shared/contracts';
import { publicMcpUrl } from './connections/endpoint';
import { digest } from './connections/digest';

export type MCPConfig = {
  serverId: string;
  endpoint: string;
  allowlist: string[];
  credential?: string;
  safeTools?: string[];
};
export type ConnectionScope =
  | { kind: 'user'; ownerId: string; connectionId: string }
  | { kind: 'deployment'; ownerId: string; serverId: string; configurationRevision: string };

/** Revisions are checked at dispatch; changing one never creates another logical connection. */
export function connectionKey(scope: ConnectionScope): string {
  return scope.kind === 'user'
    ? `user:${scope.ownerId}:${scope.connectionId}`
    : `deployment:${scope.ownerId}:${scope.serverId}`;
}
export function operationId(chatId: string, conversationId: number, taskId: number): string {
  return JSON.stringify([chatId, conversationId, taskId]);
}

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
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.serverId) ||
      seen.has(item.serverId) ||
      !Array.isArray(item.allowlist) ||
      !item.allowlist.every(
        (name: unknown) => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name),
      ) ||
      (item.safeTools !== undefined &&
        (!Array.isArray(item.safeTools) ||
          !item.safeTools.every((name: unknown) => item.allowlist.includes(name)))) ||
      (item.credential !== undefined &&
        (typeof item.credential !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.credential)))
    )
      throw new AppError(503, 'mcp_configuration_invalid');
    const url = publicMcpUrl(item.endpoint);
    if (url.search) throw new AppError(503, 'mcp_endpoint_invalid');
    seen.add(item.serverId);
  }
  // The secret is resolved only when the independent connection is used. Opening
  // a chat and reading its completed history must not depend on secret availability.
  return raw as MCPConfig[];
}

export async function deploymentRevision(config: MCPConfig, env: Record<string, unknown>) {
  const credential = config.credential ? env[config.credential] : null;
  if (config.credential && (typeof credential !== 'string' || !credential))
    throw new AppError(503, 'mcp_credential_missing');
  return digest({ config, credential });
}
