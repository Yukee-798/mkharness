import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { MCPClientManager } from 'agents/mcp/client';
import { AppError } from '../../../shared/contracts';
import type {
  ConnectionInput,
  ConnectionView,
  ToolPermission,
} from '../../../shared/mcp-connections';
import { jsonText } from '../../../shared/json';
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
export class McpConnection extends DurableObject<Env> {
  private lifecycle: Lifecycle<Env>;
  private client: MCPClientManager;
  private secrets: SecretStore;
  private queue: Promise<unknown> = Promise.resolve();
  private activeCalls = new Map<string, AbortController>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS mcp_dispatch (id TEXT PRIMARY KEY,status TEXT NOT NULL)',
    );
    this.secrets = new SecretStore(ctx.storage, secretKey(env), ctx.id.toString());
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
    if (await this.ctx.storage.get('connection')) throw new AppError(409, 'mcp_connection_exists');
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
  async call(
    owner: string,
    input: {
      name: string;
      hash: string;
      grant: number;
      operation: string;
      arguments: string;
      authorization: 'once' | 'auto';
      expiresAt: number;
    },
  ) {
    return this.serial(async () => {
      let dispatched = false;
      try {
        let state = await this.state(owner);
        const outstanding = this.ctx.storage.sql
          .exec<{ id: string; status: string }>(
            "SELECT id,status FROM mcp_dispatch WHERE status!='cancelled' LIMIT 1",
          )
          .toArray()[0];
        if (outstanding)
          throw new AppError(
            409,
            outstanding.status === 'unknown' ||
              (outstanding.status === 'dispatching' && !this.activeCalls.has(outstanding.id))
              ? 'remote_outcome_unknown'
              : 'mcp_connection_busy',
          );
        const validate = () => {
          if (!customMcpEnabled()) throw new AppError(404, 'mcp_disabled');
          const tool = state.tools.find((t) => t.name === input.name);
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
        const live = this.client
          .listTools({ serverId: state.id })
          .find((t) => t.name === input.name);
        if (
          !live ||
          (await digest({
            name: live.name,
            description: (live.description ?? live.name).slice(0, 4096),
            schema: live.inputSchema,
          })) !== input.hash
        )
          throw new AppError(409, 'mcp_definition_changed');
        state = await this.state(owner);
        validate();
        if (
          this.ctx.storage.sql
            .exec("SELECT id FROM mcp_dispatch WHERE id=? AND status='cancelled'", input.operation)
            .toArray().length
        )
          throw new AppError(409, 'mcp_cancelled');
        this.ctx.storage.sql.exec(
          'INSERT INTO mcp_dispatch(id,status) VALUES(?,?)',
          input.operation,
          'dispatching',
        );
        dispatched = true;
        const controller = new AbortController();
        this.activeCalls.set(input.operation, controller);
        const result = convertResult(
          await this.client.callTool(
            { serverId: state.id, name: input.name, arguments: JSON.parse(input.arguments) },
            { timeout: 30_000, maxTotalTimeout: 30_000, signal: controller.signal },
          ),
        );
        controller.signal.throwIfAborted();
        this.activeCalls.delete(input.operation);
        this.ctx.storage.sql.exec(
          'UPDATE mcp_dispatch SET status=? WHERE id=?',
          'responded',
          input.operation,
        );
        return { ok: true as const, result: JSON.stringify(result) };
      } catch (error) {
        this.activeCalls.delete(input.operation);
        if (dispatched)
          this.ctx.storage.sql.exec(
            'UPDATE mcp_dispatch SET status=? WHERE id=?',
            'unknown',
            input.operation,
          );
        return {
          ok: false as const,
          code: dispatched
            ? 'remote_outcome_unknown'
            : error instanceof AppError
              ? error.code
              : 'mcp_call_failed',
        };
      }
    });
  }
  async cancel(owner: string, operation: string) {
    await this.state(owner);
    const existing = this.ctx.storage.sql
      .exec<{ status: string }>('SELECT status FROM mcp_dispatch WHERE id=?', operation)
      .toArray()[0];
    this.activeCalls.get(operation)?.abort();
    if (!existing)
      this.ctx.storage.sql.exec(
        'INSERT INTO mcp_dispatch(id,status) VALUES(?,?)',
        operation,
        'cancelled',
      );
    else if (existing.status !== 'cancelled')
      this.ctx.storage.sql.exec(
        'UPDATE mcp_dispatch SET status=? WHERE id=?',
        'unknown',
        operation,
      );
    return { dispatched: !!existing && existing.status !== 'cancelled' };
  }
  async acknowledge(owner: string, operation: string) {
    await this.state(owner);
    this.ctx.storage.sql.exec(
      'DELETE FROM mcp_dispatch WHERE id=? AND status=?',
      operation,
      'responded',
    );
  }
}
