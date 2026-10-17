import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { MCPClientManager } from 'agents/mcp/client';
import { Type } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { AppError } from '../../../shared/contracts';
import type {
  ConnectionInput,
  ConnectionView,
  ToolPermission,
} from '../../../shared/mcp-connections';
import { jsonText } from '../../../shared/json';
import { mcpConfiguration, deploymentRevision, type MCPConfig } from '../configuration';
import { schemaAccepted, convertResult } from './protocol';
import { secretKey, SecretStore } from './secrets';
import { publicMcpUrl, mcpFetch } from './endpoint';
import { ConnectionOAuth } from './oauth';

/** Restore explicitly with the host's non-serializable fetch/auth policy before any network I/O. */
class ConnectionClient extends MCPClientManager {
  override async restoreConnectionsFromStorage() {}
}
import { digest } from './digest';
import { customMcpEnabled } from './catalog';
type RecordState = ConnectionView & { owner: string };
type DeploymentState = RecordState & { configurationRevision: string };
export type McpCallInput = {
  name: string;
  hash: string;
  grant: number;
  operation: string;
  arguments: string;
  authorization: 'once' | 'auto';
  expiresAt: number;
};
type DispatchReceipt = {
  id: string;
  status: 'dispatching' | 'responded' | 'unknown' | 'cancelled' | 'acknowledged';
  payload_hash: string | null;
  result: string | null;
  replay: 'safe' | 'unsafe';
  policy_revision: string | null;
};
export class McpConnection extends DurableObject<Env> {
  private lifecycle: Lifecycle<Env>;
  private client: MCPClientManager;
  private secrets: SecretStore;
  private queue: Promise<unknown> = Promise.resolve();
  private activeCalls = new Map<string, AbortController>();
  private deploymentTransportRevision?: string;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS mcp_dispatch (id TEXT PRIMARY KEY,status TEXT NOT NULL,payload_hash TEXT,result TEXT,replay TEXT NOT NULL,policy_revision TEXT)',
    );
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS mcp_dispatch_outstanding ON mcp_dispatch(status) WHERE replay='unsafe' AND status IN ('dispatching','unknown','responded')",
    );
    // Constructing a deployment connection never requires the user-secret key.
    this.secrets = new SecretStore(ctx.storage, () => secretKey(env), ctx.id.toString());

    this.lifecycle = new Lifecycle(this);
    this.client = new ConnectionClient('mkharness', '0.1.0');
    this.lifecycle.use(this.client);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private async state(owner: string, includeDisconnected = false) {
    const state = await this.ctx.storage.get<RecordState>('connection');
    if (
      !state ||
      state.owner !== owner ||
      (!includeDisconnected && state.status === 'disconnected')
    )
      throw new AppError(404, 'mcp_connection_not_found');
    return state;
  }
  private async save(state: RecordState) {
    await this.ctx.storage.put('connection', state);
  }
  private async update(
    owner: string,
    change: (state: RecordState) => void,
    includeDisconnected = false,
  ) {
    await this.ctx.storage.transaction(async (tx) => {
      const state = await tx.get<RecordState>('connection');
      if (
        !state ||
        state.owner !== owner ||
        (!includeDisconnected && state.status === 'disconnected')
      )
        throw new AppError(404, 'mcp_connection_not_found');
      change(state);
      await tx.put('connection', state);
    });
  }
  async initialize(owner: string, id: string, input: ConnectionInput): Promise<string> {
    if ((await this.ctx.storage.get('connection')) || (await this.ctx.storage.get('deployment')))
      throw new AppError(409, 'mcp_connection_exists');
    publicMcpUrl(input.endpoint);
    await secretKey(this.env);
    if (input.token) await this.secrets.put('bearer', input.token);
    if (input.clientId)
      await this.secrets.put('client', {
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      });
    const state: RecordState = {
      id,
      owner,
      name: input.name,
      endpoint: input.endpoint,
      auth: input.auth,
      enabled: true,
      status: 'connecting',
      revision: 1,
      grant: 1,
      tools: [],
    };
    await this.save(state);
    return this.metadata(owner);
  }
  private failure(error: unknown): string {
    return JSON.stringify({
      error: {
        code: error instanceof AppError ? error.code : 'mcp_connection_failed',
        status: error instanceof AppError ? error.status : 503,
      },
    });
  }
  async metadata(owner: string): Promise<string> {
    try {
      return JSON.stringify(await this.view(owner));
    } catch (error) {
      return this.failure(error);
    }
  }
  private async view(owner: string): Promise<ConnectionView> {
    // An interrupted deletion can leave its D1 index row until the next retry.
    // Keep that owner's tombstone readable so it cannot poison the whole directory.
    const { owner: _owner, ...view } = await this.state(owner, true);
    return view;
  }
  private async prepare(state: RecordState) {
    if (!customMcpEnabled()) throw new AppError(404, 'mcp_disabled');
    await this.lifecycle.start();
    if (this.client.mcpConnections[state.id]) return;
    const callback = new URL('/api/mcp/callback', this.env.APP_URL).href;
    const provider =
      state.auth === 'auto'
        ? new ConnectionOAuth(this.ctx.storage, this.secrets, state.id, callback, this.env.APP_URL)
        : undefined;
    const info = await provider?.clientInformation();
    await this.client.registerServer(state.id, {
      name: state.name,
      url: state.endpoint,
      ...(provider ? { callbackUrl: callback, ...(info ? { clientId: info.client_id } : {}) } : {}),
      transport: {
        type: 'streamable-http',
        authProvider: provider,
        requestInit: { redirect: 'manual' },
        fetch: async (input, init) => {
          const target = publicMcpUrl(String(input instanceof Request ? input.url : input));
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          if (state.auth === 'bearer') {
            if (target.href !== new URL(state.endpoint).href)
              throw new AppError(403, 'mcp_credential_destination_mismatch');
            headers.set('Authorization', 'Bearer ' + (await this.secrets.get<string>('bearer')));
          }
          return mcpFetch(input, { ...init, headers });
        },
      },
    });
  }
  private async discover(state: RecordState) {
    const result = await this.client.discoverIfConnected(state.id, { timeoutMs: 15_000 });
    if (!result?.success) throw new AppError(503, 'mcp_discovery_failed');
    const tools = this.client.listTools({ serverId: state.id });
    jsonText(tools);
    if (tools.length > 200) throw new AppError(503, 'mcp_tool_limit');
    const discovered = await Promise.all(
      tools.map(async (tool) => {
        const description = (tool.description ?? tool.name).slice(0, 4096);
        const schema = structuredClone(
          tool.inputSchema,
        ) as ConnectionView['tools'][number]['schema'];
        return {
          name: tool.name,
          description,
          schema,
          hash: await digest({ name: tool.name, description, schema }),
          supported: schemaAccepted(schema) && schema.type === 'object',
        };
      }),
    );
    await this.update(state.owner, (current) => {
      current.tools = discovered.map((tool) => ({
        ...tool,
        permission:
          current.tools.find((t) => t.name === tool.name && t.hash === tool.hash)?.permission ??
          'ask',
      }));
      current.status = 'ready';
      delete current.error;
      current.revision++;
    });
  }

  async connectRemote(owner: string): Promise<{ connection: string; authorizationUrl?: string }> {
    return this.serial(async () => {
      let state: RecordState;
      try {
        state = await this.state(owner);
        if (!state.enabled) throw new AppError(409, 'mcp_disabled');
      } catch (error) {
        return { connection: this.failure(error) };
      }
      try {
        await this.prepare(state);
        const result = await this.client.connectToServer(state.id);
        if (result.state === 'authenticating') {
          publicMcpUrl(result.authUrl);
          await this.update(owner, (current) => {
            if (current.tools.length && current.status !== 'authorizing') current.grant++;
            current.status = 'authorizing';
          });
          return { connection: await this.metadata(owner), authorizationUrl: result.authUrl };
        }
        if (result.state !== 'connected') throw new AppError(503, 'mcp_connection_failed');
        await this.discover(state);
      } catch (error) {
        await this.update(owner, (current) => {
          current.status = 'error';
          current.error = error instanceof AppError ? error.code : 'mcp_connection_failed';
        }).catch(() => {});
      }
      return { connection: await this.metadata(owner) };
    });
  }
  async callback(owner: string, url: string): Promise<{ ok: boolean; code?: string }> {
    try {
      await this.serial(async () => {
        const state = await this.state(owner);
        if (!state.enabled) throw new AppError(409, 'mcp_disabled');
        await this.prepare(state);
        const oauth = this.client.mcpConnections[state.id]?.options.transport.authProvider;
        const nonce = new URL(url).searchParams.get('state');
        if (!nonce || !oauth || !(await oauth.checkState(nonce)).valid)
          throw new AppError(400, 'mcp_authorization_failed');
        // A cold registration has no transport yet; initialize it with the secure policy first.
        // The SDK keeps callback PKCE verifiers scoped to each state, including this older state.
        if (this.client.mcpConnections[state.id]?.connectionState === 'connecting')
          await this.client.connectToServer(state.id);
        const result = await this.client.handleCallbackRequest(new Request(url));
        if (!result.authSuccess) throw new AppError(400, 'mcp_authorization_failed');
        const connected = await this.client.connectToServer(state.id);
        if (connected.state !== 'connected') throw new AppError(503, 'mcp_connection_failed');
        await this.discover(state);
        return this.metadata(owner);
      });
      return { ok: true };
    } catch {
      return { ok: false, code: 'mcp_authorization_failed' };
    }
  }
  async configure(
    owner: string,
    patch: { enabled?: boolean; permissions?: Record<string, ToolPermission>; revision: number },
  ) {
    try {
      await this.update(owner, (state) => {
        if (patch.revision !== state.revision) throw new AppError(409, 'mcp_connection_changed');
        if (patch.enabled !== undefined) state.enabled = patch.enabled;
        for (const [name, permission] of Object.entries(patch.permissions ?? {})) {
          const tool = state.tools.find((t) => t.name === name);
          if (!tool || !tool.supported) throw new AppError(400, 'mcp_tool_unavailable');
          tool.permission = permission;
        }
        state.revision++;
      });
      return this.metadata(owner);
    } catch (error) {
      return this.failure(error);
    }
  }

  async disconnect(owner: string) {
    const state = await this.state(owner, true);
    await this.update(
      owner,
      (current) => {
        if (current.status === 'disconnected') return;
        current.enabled = false;
        current.status = 'disconnected';
        current.grant++;
      },
      true,
    );
    for (const controller of this.activeCalls.values()) controller.abort();
    await this.lifecycle.start();
    await this.client.removeServer(state.id).catch(() => {});
    for (const key of ['tokens', 'client', 'bearer']) await this.secrets.delete(key);
  }
  private deploymentConfig(serverId: string): MCPConfig {
    const config = mcpConfiguration(this.env as Env & Record<string, unknown>).find(
      (item) => item.serverId === serverId,
    );
    if (!config) throw new AppError(404, 'mcp_disabled');
    return config;
  }
  private async deploymentState(
    owner: string,
    serverId: string,
  ): Promise<DeploymentState | undefined> {
    const user = await this.ctx.storage.get<RecordState>('connection');
    const state = await this.ctx.storage.get<DeploymentState>('deployment');
    if (user || (state && (state.owner !== owner || state.id !== serverId)))
      throw new AppError(404, 'mcp_connection_not_found');
    return state;
  }
  private async prepareDeployment(state: DeploymentState, config: MCPConfig) {
    await this.lifecycle.start();
    if (
      this.deploymentTransportRevision === state.configurationRevision &&
      this.client.mcpConnections[state.id]
    )
      return;
    if (this.client.mcpConnections[state.id]) await this.client.removeServer(state.id);
    await this.client.registerServer(state.id, {
      name: state.id,
      url: config.endpoint,
      transport: {
        type: 'streamable-http',
        requestInit: { redirect: 'manual' },
        fetch: async (input, init) => {
          const target = publicMcpUrl(String(input instanceof Request ? input.url : input));
          if (target.href !== new URL(config.endpoint).href)
            throw new AppError(403, 'mcp_credential_destination_mismatch');
          const headers = new Headers(
            init?.headers ?? (input instanceof Request ? input.headers : undefined),
          );
          if (config.credential) {
            const secret = (this.env as unknown as Record<string, unknown>)[config.credential];
            if (typeof secret !== 'string' || !secret)
              throw new AppError(503, 'mcp_credential_missing');
            headers.set('Authorization', 'Bearer ' + secret);
          }
          return mcpFetch(input, { ...init, headers });
        },
      },
    });
    this.deploymentTransportRevision = state.configurationRevision;
  }
  private async deploymentReady(state: DeploymentState, config: MCPConfig) {
    await this.prepareDeployment(state, config);
    if (this.client.mcpConnections[state.id]?.connectionState === 'ready') return;
    const result = await this.client.connectToServer(state.id);
    if (result.state !== 'connected') throw new AppError(503, 'mcp_connection_failed');
    const found = await this.client.discoverIfConnected(state.id, { timeoutMs: 15_000 });
    if (!found?.success) throw new AppError(503, 'mcp_discovery_failed');
  }
  /** Trusted deployment catalog, discovered only while creating a chat. */
  async deploymentMetadata(owner: string, serverId: string): Promise<string> {
    return this.serial(async () => {
      try {
        const previous = await this.deploymentState(owner, serverId);
        const config = this.deploymentConfig(serverId);
        const configurationRevision = await deploymentRevision(
          config,
          this.env as unknown as Record<string, unknown>,
        );
        const state: DeploymentState = {
          id: serverId,
          owner,
          name: serverId,
          endpoint: config.endpoint,
          auth: 'none',
          enabled: true,
          status: 'connecting',
          revision: 1,
          grant: 1,
          tools: [],
          configurationRevision,
        };
        await this.deploymentReady(state, config);
        const tools = this.client.listTools({ serverId });
        jsonText(tools);
        if (tools.length > 200) throw new AppError(503, 'mcp_tool_limit');
        state.tools = await Promise.all(
          tools
            .filter((tool) => config.allowlist.includes(tool.name))
            .map(async (tool) => {
              const description = (tool.description ?? tool.name).slice(0, 4096);
              const schema = structuredClone(
                tool.inputSchema,
              ) as ConnectionView['tools'][number]['schema'];
              return {
                name: tool.name,
                description,
                schema,
                hash: await digest({ name: tool.name, description, schema }),
                supported: schemaAccepted(schema) && schema.type === 'object',
                permission: 'auto' as const,
              };
            }),
        );
        state.status = 'ready';
        state.revision = (previous?.revision ?? 0) + 1;
        await this.ctx.storage.put('deployment', state);
        const { owner: _owner, ...view } = state;
        return jsonText(view);
      } catch (error) {
        return this.failure(error);
      }
    });
  }
  async deploymentCall(
    owner: string,
    serverId: string,
    configurationRevision: string,
    input: McpCallInput,
  ) {
    return this.serial(async () => {
      try {
        const state = await this.deploymentState(owner, serverId);
        if (!state) throw new AppError(404, 'mcp_connection_not_found');
        // A cached receipt is scoped to this accepted configuration. Current policy
        // may revoke future calls, but cannot erase an already committed response.
        const payloadHash = await digest({ serverId, configurationRevision, input });
        const existing = this.receipt(input.operation);
        if (existing) return this.repeated(existing, payloadHash);
        const config = this.deploymentConfig(serverId);
        const replay = config.safeTools?.includes(input.name) ? 'safe' : 'unsafe';
        return this.dispatch(
          input,
          payloadHash,
          replay,
          async () => {
            const validate = async () => {
              const current = this.deploymentConfig(serverId);
              if (
                (await deploymentRevision(
                  current,
                  this.env as unknown as Record<string, unknown>,
                )) !== configurationRevision ||
                state.configurationRevision !== configurationRevision ||
                !current.allowlist.includes(input.name)
              )
                throw new AppError(409, 'mcp_definition_changed');
              if (
                !state.tools.some(
                  (tool) => tool.name === input.name && tool.hash === input.hash && tool.supported,
                )
              )
                throw new AppError(409, 'mcp_definition_changed');
            };
            await validate();
            await this.deploymentReady(state, config);
            await this.validateLive(serverId, input);
            await validate();
            return serverId;
          },
          configurationRevision,
        );
      } catch (error) {
        return this.callFailure(error);
      }
    });
  }
  private receipt(operation: string) {
    return this.ctx.storage.sql
      .exec<DispatchReceipt>('SELECT * FROM mcp_dispatch WHERE id=?', operation)
      .toArray()[0];
  }
  private repeated(receipt: DispatchReceipt, payloadHash: string) {
    if (receipt.payload_hash && receipt.payload_hash !== payloadHash)
      return { ok: false as const, code: 'mcp_operation_conflict' };
    if (receipt.status === 'responded' && receipt.result)
      return { ok: true as const, result: receipt.result };
    return {
      ok: false as const,
      code:
        receipt.status === 'cancelled'
          ? 'mcp_cancelled'
          : receipt.status === 'acknowledged'
            ? 'mcp_receipt_acknowledged'
            : 'remote_outcome_unknown',
    };
  }
  private callFailure(error: unknown) {
    return { ok: false as const, code: error instanceof AppError ? error.code : 'mcp_call_failed' };
  }
  private async validateLive(serverId: string, input: McpCallInput) {
    const live = this.client.listTools({ serverId }).find((tool) => tool.name === input.name);
    if (
      !live ||
      (await digest({
        name: live.name,
        description: (live.description ?? live.name).slice(0, 4096),
        schema: live.inputSchema,
      })) !== input.hash
    )
      throw new AppError(409, 'mcp_definition_changed');
    try {
      validateToolArguments(
        {
          name: live.name,
          description: live.description ?? live.name,
          parameters: Type.Unsafe(live.inputSchema),
        },
        {
          type: 'toolCall',
          id: input.operation,
          name: input.name,
          arguments: JSON.parse(input.arguments),
        },
      );
    } catch {
      throw new AppError(400, 'mcp_arguments_invalid');
    }
  }
  /** Both credential sources share the same network budget, intent and durable response path. */
  private async dispatch(
    input: McpCallInput,
    payloadHash: string,
    replay: 'safe' | 'unsafe',
    prepare: () => Promise<string>,
    policyRevision?: string,
  ) {
    let dispatched = false;
    try {
      const outstanding = this.ctx.storage.sql
        .exec<DispatchReceipt>(
          "SELECT * FROM mcp_dispatch WHERE replay='unsafe' AND status IN ('dispatching','unknown','responded') LIMIT 1",
        )
        .toArray()[0];
      if (outstanding && (replay === 'unsafe' || policyRevision !== outstanding.policy_revision))
        throw new AppError(
          409,
          outstanding.status === 'responded' ? 'mcp_connection_busy' : 'remote_outcome_unknown',
        );
      jsonText(JSON.parse(input.arguments));
      const serverId = await prepare();
      // Cancellation can interleave while discovery is in progress.
      const cancelled = this.receipt(input.operation);
      if (cancelled) return this.repeated(cancelled, payloadHash);
      this.ctx.storage.sql.exec(
        'INSERT INTO mcp_dispatch(id,status,payload_hash,result,replay,policy_revision) VALUES(?,?,?,?,?,?)',
        input.operation,
        'dispatching',
        payloadHash,
        null,
        replay,
        policyRevision ?? null,
      );
      dispatched = true;
      const controller = new AbortController();
      this.activeCalls.set(input.operation, controller);
      const result = jsonText(
        convertResult(
          await this.client.callTool(
            { serverId, name: input.name, arguments: JSON.parse(input.arguments) },
            { timeout: 30_000, maxTotalTimeout: 30_000, signal: controller.signal },
          ),
        ),
      );
      controller.signal.throwIfAborted();
      this.ctx.storage.sql.exec(
        'UPDATE mcp_dispatch SET status=?,result=? WHERE id=?',
        'responded',
        result,
        input.operation,
      );
      return { ok: true as const, result };
    } catch (error) {
      if (dispatched)
        this.ctx.storage.sql.exec(
          'UPDATE mcp_dispatch SET status=? WHERE id=?',
          replay === 'unsafe' ? 'unknown' : 'cancelled',
          input.operation,
        );
      return dispatched && replay === 'unsafe'
        ? { ok: false as const, code: 'remote_outcome_unknown' }
        : this.callFailure(error);
    } finally {
      this.activeCalls.delete(input.operation);
    }
  }
  async call(owner: string, input: McpCallInput) {
    return this.serial(async () => {
      try {
        let state = await this.state(owner, true);
        const payloadHash = await digest(input);
        const existing = this.receipt(input.operation);
        if (existing) return this.repeated(existing, payloadHash);
        return this.dispatch(input, payloadHash, 'unsafe', async () => {
          const validate = () => {
            if (state.status === 'disconnected')
              throw new AppError(404, 'mcp_connection_not_found');
            if (!customMcpEnabled()) throw new AppError(404, 'mcp_disabled');
            const tool = state.tools.find((tool) => tool.name === input.name);
            if (Date.now() >= input.expiresAt) throw new AppError(409, 'mcp_approval_expired');
            if (tool?.permission === 'ask' && input.authorization !== 'once')
              throw new AppError(403, 'mcp_approval_required');
            if (!state.enabled || tool?.permission === 'disabled')
              throw new AppError(403, 'mcp_disabled');
            if (state.grant !== input.grant) throw new AppError(409, 'mcp_authorization_changed');
            if (!tool?.supported || tool.hash !== input.hash)
              throw new AppError(409, 'mcp_definition_changed');
          };
          validate();
          await this.prepare(state);
          if (this.client.mcpConnections[state.id]?.connectionState !== 'ready') {
            const result = await this.client.connectToServer(state.id);
            if (result.state === 'authenticating') {
              await this.update(owner, (current) => {
                current.status = 'reauthorize';
              });
              throw new AppError(401, 'mcp_authorization_required');
            }
            if (result.state !== 'connected') throw new AppError(503, 'mcp_connection_failed');
            await this.discover(state);
          }
          await this.validateLive(state.id, input);
          state = await this.state(owner);
          validate();
          return state.id;
        });
      } catch (error) {
        return this.callFailure(error);
      }
    });
  }
  private cancelOperation(operation: string) {
    const existing = this.receipt(operation);
    this.activeCalls.get(operation)?.abort();
    if (!existing)
      this.ctx.storage.sql.exec(
        'INSERT INTO mcp_dispatch(id,status,payload_hash,result,replay,policy_revision) VALUES(?,?,?,?,?,?)',
        operation,
        'cancelled',
        null,
        null,
        'unsafe',
        null,
      );
    else if (existing.status === 'dispatching')
      this.ctx.storage.sql.exec(
        'UPDATE mcp_dispatch SET status=? WHERE id=?',
        'unknown',
        operation,
      );
    return {
      dispatched: !!existing && !['cancelled', 'acknowledged'].includes(existing.status),
      // A completed remote effect stays known when Stop races the caller's result commit.
      ...(existing?.status === 'responded' && existing.result ? { result: existing.result } : {}),
    };
  }
  async cancel(owner: string, operation: string) {
    await this.state(owner, true);
    return this.cancelOperation(operation);
  }
  async deploymentCancel(owner: string, serverId: string, operation: string) {
    if (!(await this.deploymentState(owner, serverId)))
      throw new AppError(404, 'mcp_connection_not_found');
    return this.cancelOperation(operation);
  }
  private acknowledgeOperation(operation: string) {
    // Retain a compact tombstone so a delayed duplicate RPC can never redispatch.
    this.ctx.storage.sql.exec(
      'UPDATE mcp_dispatch SET status=?,result=NULL WHERE id=? AND status=?',
      'acknowledged',
      operation,
      'responded',
    );
  }
  async acknowledge(owner: string, operation: string) {
    await this.state(owner, true);
    this.acknowledgeOperation(operation);
  }
  async deploymentAcknowledge(owner: string, serverId: string, operation: string) {
    if (!(await this.deploymentState(owner, serverId)))
      throw new AppError(404, 'mcp_connection_not_found');
    this.acknowledgeOperation(operation);
  }
}
