import { McpConnection as Base } from '../../src/server/mcp/connections/connection';
import type { MCPConfig } from '../../src/server/mcp/deployment';
/** Isolated MCP fixture: production transport and receipts, controllable deployment policy. */
export class McpConnection extends Base {
  constructor(ctx: DurableObjectState, env: Env) {
    // Only this connection fixture enables deployment MCP. Ordinary directory
    // tests retain an empty deployment configuration and make no discovery calls.
    const fixture = env as Env & { MCP_TEST_SERVERS: string };
    const configured = { ...env, MCP_SERVERS: fixture.MCP_TEST_SERVERS };
    super(ctx, configured);
  }
  setDeploymentConfiguration(configs: MCPConfig[]) {
    (this.env as Env & { MCP_SERVERS?: string }).MCP_SERVERS = JSON.stringify(configs);
  }
}
export default { fetch: () => new Response('MCP fixture') };
