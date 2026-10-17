import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import {
  buildMcp,
  freezeDeploymentBindings,
  mcpConfiguration,
  type MCPBinding,
} from '../../src/server/mcp/deployment';
import { connectionKey, operationId } from '../../src/server/mcp/configuration';
import { BG } from '../../src/server/chat/context';
import { fixtureModels } from '../fixture-model';
import {
  drainMcpAcknowledgements,
  mcpAcknowledgementTasks,
} from '../../src/server/mcp/acknowledgement';

afterEach(() => vi.restoreAllMocks());
class ReopenableMemoryStorage extends MemoryStorage {
  override async close() {}
}
function server(
  options: { fault?: 'lost' | 'invalid' | 'oversized' | 'abort'; changed?: boolean } = {},
) {
  let mutations = 0,
    reads = 0;
  const authorization: (string | null)[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    if (url.hostname === 'cloudflare-dns.com')
      return Response.json({
        Status: 0,
        Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
      });
    authorization.push(request.headers.get('Authorization'));
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = (await request.json()) as any;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    if (rpc.method === 'tools/list')
      result = {
        tools: ['lookup', 'status'].map((name) => ({
          name,
          description: name,
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: options.changed ? [] : ['query'],
            additionalProperties: false,
          },
        })),
      };
    if (rpc.method === 'tools/call') {
      if (rpc.params.name === 'lookup') mutations++;
      else reads++;
      if (options.fault === 'lost' && rpc.params.name === 'lookup')
        throw new Error('accepted mutation, lost response');
      if (options.fault === 'abort' && rpc.params.name === 'lookup')
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(request.signal.reason);
          if (request.signal.aborted) abort();
          else request.signal.addEventListener('abort', abort, { once: true });
        });
      result =
        options.fault === 'invalid' && rpc.params.name === 'lookup'
          ? { content: [{ type: 'resource_link', uri: 'https://example.test/result' }] }
          : {
              content: [
                {
                  type: 'text',
                  text:
                    options.fault === 'oversized' && rpc.params.name === 'lookup'
                      ? 'x'.repeat(1_048_577)
                      : 'found',
                },
              ],
              structuredContent: { value: 2 },
            };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  });
  return { options, network, authorization, counts: () => ({ mutations, reads }) };
}
async function setup() {
  const owner = crypto.randomUUID();
  const configs = mcpConfiguration({
    MCP_SERVERS: (env as unknown as { MCP_TEST_SERVERS: string }).MCP_TEST_SERVERS,
  });
  const bindings = await freezeDeploymentBindings(env as Env, owner, configs);
  const stub = env.MCP_CONNECTIONS.getByName(
    connectionKey({
      kind: 'deployment',
      ownerId: owner,
      serverId: 'reference',
      configurationRevision: '',
    }),
  );
  return { owner, configs, bindings, stub };
}
function input(binding: MCPBinding, operation = operationId('chat', 1, 5)) {
  return {
    name: binding.remoteName,
    hash: binding.hash,
    grant: 1,
    operation,
    arguments: '{"query":"hi"}',
    authorization: 'auto' as const,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

it('uses the standalone SDK transport, injects deployment secrets only at network time, and re-reads durable results after reconstruction', async () => {
  const remote = server();
  const { owner, bindings, stub } = await setup();
  const binding = bindings.find((item) => item.remoteName === 'lookup')!;
  const call = input(binding);
  const first = await stub.deploymentCall(
    owner,
    binding.serverId,
    binding.configurationRevision,
    call,
  );
  expect(first).toMatchObject({ ok: true });
  const persisted = await runInDurableObject(stub, (_, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
      )
      .toArray();
    return tables.map(({ name }) =>
      state.storage.sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray(),
    );
  });
  expect(JSON.stringify(persisted)).not.toContain('mcp-fixture-secret');
  expect(remote.authorization.every((value) => value === 'Bearer mcp-fixture-secret')).toBe(true);
  await abortAllDurableObjects();
  remote.network.mockClear();
  const restored = env.MCP_CONNECTIONS.get(stub.id);
  expect(
    await restored.deploymentCall(owner, binding.serverId, binding.configurationRevision, call),
  ).toEqual(first);
  expect(remote.network).not.toHaveBeenCalled();
  expect(
    await restored.deploymentCall(owner, binding.serverId, binding.configurationRevision, {
      ...call,
      arguments: '{"query":"different"}',
    }),
  ).toMatchObject({ ok: false, code: 'mcp_operation_conflict' });
  await restored.deploymentAcknowledge(owner, binding.serverId, call.operation);
  expect(
    await restored.deploymentCall(owner, binding.serverId, binding.configurationRevision, call),
  ).toMatchObject({ ok: false, code: 'mcp_receipt_acknowledged' });
  expect(remote.counts().mutations).toBe(1);
});
it.each(['lost', 'invalid', 'oversized'] as const)(
  'keeps %s remote outcomes locked across branches, children and configuration revisions',
  async (fault) => {
    const remote = server({ fault });
    const { owner, bindings, stub, configs } = await setup();
    const binding = bindings.find((item) => item.remoteName === 'lookup')!;
    expect(
      await stub.deploymentCall(
        owner,
        binding.serverId,
        binding.configurationRevision,
        input(binding),
      ),
    ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
    await abortAllDurableObjects();
    const restored = env.MCP_CONNECTIONS.get(stub.id);
    for (const operation of [
      operationId('other-chat', 1, 5),
      operationId('chat', 2, 5),
      operationId('chat', 3, 5),
    ])
      expect(
        await restored.deploymentCall(
          owner,
          binding.serverId,
          binding.configurationRevision,
          input(binding, operation),
        ),
      ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
    const read = bindings.find((item) => item.remoteName === 'status')!;
    expect(
      await restored.deploymentCall(
        owner,
        read.serverId,
        read.configurationRevision,
        input(read, operationId('chat', 3, 6)),
      ),
    ).toMatchObject({ ok: true });
    // Deploy a new endpoint policy in the same logical connection. Discovery can
    // refresh metadata, but cannot erase a previous unknown mutation receipt.
    await runInDurableObject(restored, (instance) =>
      (instance as any).setDeploymentConfiguration([
        {
          ...configs[0],
          endpoint: 'https://changed.example.test/mcp',
          safeTools: ['lookup', 'status'],
        },
      ]),
    );
    const refreshed = JSON.parse(await restored.deploymentMetadata(owner, binding.serverId));
    expect(refreshed.configurationRevision).not.toBe(binding.configurationRevision);
    expect(
      await restored.deploymentCall(
        owner,
        binding.serverId,
        refreshed.configurationRevision,
        input(binding, operationId('chat', 4, 5)),
      ),
    ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
    expect(
      await restored.deploymentCall(
        owner,
        read.serverId,
        refreshed.configurationRevision,
        input(read, operationId('chat', 4, 6)),
      ),
    ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
    expect(remote.counts()).toEqual({ mutations: 1, reads: 1 });
  },
);
it('allows another owner to use the same deployment while the first owner has an unknown operation', async () => {
  const remote = server({ fault: 'lost' });
  const first = await setup();
  const binding = first.bindings[0];
  await first.stub.deploymentCall(
    first.owner,
    binding.serverId,
    binding.configurationRevision,
    input(binding),
  );
  remote.options.fault = undefined;
  const other = await setup();
  const otherBinding = other.bindings[0];
  expect(other.stub.id.toString()).not.toBe(first.stub.id.toString());
  expect(
    await other.stub.deploymentCall(
      other.owner,
      otherBinding.serverId,
      otherBinding.configurationRevision,
      input(otherBinding),
    ),
  ).toMatchObject({ ok: true });
  expect(
    JSON.parse(await first.stub.deploymentMetadata(other.owner, binding.serverId)),
  ).toMatchObject({ error: { code: 'mcp_connection_not_found' } });
  expect(remote.counts().mutations).toBe(2);
});
it('cancels an operation before dispatch and never loosens its frozen schema after a cold reconnect', async () => {
  const remote = server();
  const { owner, bindings, stub } = await setup();
  const binding = bindings[0],
    call = input(binding);
  expect(await stub.deploymentCancel(owner, binding.serverId, call.operation)).toEqual({
    dispatched: false,
  });
  expect(
    await stub.deploymentCall(owner, binding.serverId, binding.configurationRevision, call),
  ).toMatchObject({ ok: false, code: 'mcp_cancelled' });
  remote.options.changed = true;
  await abortAllDurableObjects();
  expect(
    await env.MCP_CONNECTIONS.get(stub.id).deploymentCall(
      owner,
      binding.serverId,
      binding.configurationRevision,
      input(binding, operationId('chat', 1, 6)),
    ),
  ).toMatchObject({ ok: false, code: 'mcp_definition_changed' });
  expect(remote.counts().mutations).toBe(0);
});
it('executes a native Pi MCP child task and acknowledges only its committed result', async () => {
  const remote = server();
  const { owner, bindings, configs, stub } = await setup();
  const registry = createRegistry();
  const built = buildMcp(env as Env, { ownerId: owner, chatId: 'native-chat' }, configs, bindings);
  registry.install(built.extension);
  const pi = await Harness.open(new MemoryStorage(), { models: fixtureModels(), registry }, BG);
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
    await root.waitForIdle(BG);
    expect(JSON.stringify((await root.context(BG)).messages)).toContain('found');
    expect(remote.counts().mutations).toBe(1);
    const receipts = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec('SELECT status,result FROM mcp_dispatch').toArray(),
    );
    expect(receipts).toMatchObject([{ status: 'acknowledged', result: null }]);
  } finally {
    await pi.close(BG);
  }
});

it('preserves an unsafe unknown receipt when Stop aborts an in-flight remote dispatch', async () => {
  const remote = server({ fault: 'abort' });
  const { owner, bindings, stub } = await setup();
  const binding = bindings[0],
    call = input(binding);
  const inFlight = stub.deploymentCall(
    owner,
    binding.serverId,
    binding.configurationRevision,
    call,
  );
  await vi.waitFor(() => expect(remote.counts().mutations).toBe(1));
  expect(await stub.deploymentCancel(owner, binding.serverId, call.operation)).toEqual({
    dispatched: true,
  });
  expect(await inFlight).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
  await abortAllDurableObjects();
  expect(
    await env.MCP_CONNECTIONS.get(stub.id).deploymentCall(
      owner,
      binding.serverId,
      binding.configurationRevision,
      input(binding, operationId('another-chat', 2, 6)),
    ),
  ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
  expect(remote.counts().mutations).toBe(1);
});

it.each(['before delivery', 'after delivery'] as const)(
  'retries a deployment acknowledgement lost %s from its committed native result',
  async (failure) => {
    const remote = server();
    const { owner, bindings, configs, stub } = await setup();
    let attempts = 0;
    let savedResult: unknown;
    const probeEnv = {
      ...env,
      MCP_CONNECTIONS: {
        getByName: () => ({
          deploymentCall: (...args: Parameters<typeof stub.deploymentCall>) =>
            stub.deploymentCall(...args),
          deploymentAcknowledge: async (...args: Parameters<typeof stub.deploymentAcknowledge>) => {
            attempts++;
            if (attempts === 1) {
              savedResult = (await pi.getTask(JSON.parse(args[2])[2], BG))?.state;
              if (failure === 'after delivery') await stub.deploymentAcknowledge(...args);
              throw new Error('lost acknowledgement RPC');
            }
            await stub.deploymentAcknowledge(...args);
          },
        }),
      },
    } as unknown as Env;
    const registry = createRegistry();
    registry.install(
      buildMcp(probeEnv, { ownerId: owner, chatId: 'ack-chat' }, configs, bindings).extension,
    );
    const pi = await Harness.open(new MemoryStorage(), { models: fixtureModels(), registry }, BG);
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
      await root.waitForIdle(BG);
      await vi.waitFor(
        async () => {
          expect(attempts).toBe(2);
          expect((await pi.inspect(BG)).tasks).toEqual([]);
        },
        { timeout: 5000 },
      );
      expect(savedResult).toMatchObject({
        status: 'terminal',
        outcome: { status: 'completed', result: { text: expect.stringContaining('found') } },
      });
      expect(JSON.stringify((await root.context(BG)).messages)).toContain('found');
      expect(
        await runInDurableObject(stub, (_, state) =>
          state.storage.sql.exec('SELECT status,result FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'acknowledged', result: null }]);
      const binding = bindings.find((b) => b.remoteName === 'lookup')!;
      const next = input(binding, operationId('next-chat', 1, 99));
      expect(
        await stub.deploymentCall(owner, binding.serverId, binding.configurationRevision, next),
      ).toMatchObject({ ok: true });
      await stub.deploymentAcknowledge(owner, binding.serverId, next.operation);
      expect(remote.counts().mutations).toBe(2);
    } finally {
      await pi.close(BG);
    }
  },
);

it.each(['native retry', 'deletion drain', 'disabled cold retry', 'in-flight Stop'] as const)(
  'preserves one deployment acknowledgement through cold reconstruction, repeated Stop and %s',
  async (recovery) => {
    const remote = server();
    const { owner, bindings, configs, stub } = await setup();
    let available = false;
    let attempts = 0;
    let operation = '';
    let releaseAvailability!: () => void;
    const delayed = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    const probeEnv = {
      ...env,
      MCP_CONNECTIONS: {
        getByName: () => ({
          deploymentCall: (...args: Parameters<typeof stub.deploymentCall>) =>
            env.MCP_CONNECTIONS.get(stub.id).deploymentCall(...args),
          deploymentCancel: (...args: Parameters<typeof stub.deploymentCancel>) =>
            env.MCP_CONNECTIONS.get(stub.id).deploymentCancel(...args),
          deploymentAcknowledge: async (...args: Parameters<typeof stub.deploymentAcknowledge>) => {
            attempts++;
            operation = args[2];
            if (!available) {
              if (recovery === 'in-flight Stop') await delayed;
              else throw new Error('acknowledgement unavailable');
            }
            await env.MCP_CONNECTIONS.get(stub.id).deploymentAcknowledge(...args);
          },
        }),
      },
    } as unknown as Env;
    const registry = () => {
      const value = createRegistry();
      value.install(
        buildMcp(probeEnv, { ownerId: owner, chatId: 'cold-ack' }, configs, bindings).extension,
      );
      return value;
    };
    const storage = new ReopenableMemoryStorage();
    let pi = await Harness.open(storage, { models: fixtureModels(), registry: registry() }, BG);
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
      await root.waitForIdle(BG);
      await vi.waitFor(() => expect(attempts).toBe(1));
      await pi.close(BG);
      await abortAllDurableObjects();
      const restoredRegistry = recovery === 'disabled cold retry' ? createRegistry() : registry();
      if (recovery === 'disabled cold retry')
        restoredRegistry.install({
          name: 'host-mcp-acknowledgements',
          tasks: mcpAcknowledgementTasks(probeEnv),
        });
      pi = await Harness.open(storage, { models: fixtureModels(), registry: restoredRegistry }, BG);
      const restored = (await pi.conversation(root.id, BG))!;
      for (let stop = 0; stop < 2; stop++) {
        await restored.abort(BG, { background: true });
        const pending = (await pi.inspect(BG)).tasks;
        expect(pending).toHaveLength(1);
        expect(pending[0].record.kind).toBe('app.deployment-mcp-acknowledgement');
        expect(pending[0].record.input).toMatchObject({ operation });
        expect((await pi.getTask(JSON.parse(operation)[2], BG))?.state).toMatchObject({
          status: 'terminal',
          outcome: { status: 'completed', result: { text: expect.stringContaining('found') } },
        });
      }
      if (recovery === 'deletion drain') {
        await pi.close(BG);
        await expect(drainMcpAcknowledgements(storage, probeEnv, BG)).rejects.toThrow(
          'acknowledgement unavailable',
        );
        available = true;
        await drainMcpAcknowledgements(storage, probeEnv, BG);
        await drainMcpAcknowledgements(storage, probeEnv, BG);
      } else {
        available = true;
        releaseAvailability();
        await vi.waitFor(async () => expect((await pi.inspect(BG)).tasks).toEqual([]), {
          timeout: 5000,
        });
      }
      expect(remote.counts().mutations).toBe(1);
      expect(
        await runInDurableObject(env.MCP_CONNECTIONS.get(stub.id), (_, state) =>
          state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'acknowledged' }]);
    } finally {
      releaseAvailability();
      await pi.close(BG);
    }
  },
);

it('keeps a known deployment result when Stop races its native result commit', async () => {
  const remote = server();
  const { owner, bindings, configs, stub } = await setup();
  let release!: () => void;
  const delivered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let operation = '';
  const probeEnv = {
    ...env,
    MCP_CONNECTIONS: {
      getByName: () => ({
        deploymentCall: async (...args: Parameters<typeof stub.deploymentCall>) => {
          const receipt = await stub.deploymentCall(...args);
          operation = args[3].operation;
          await delivered;
          return receipt;
        },
        deploymentCancel: (...args: Parameters<typeof stub.deploymentCancel>) =>
          stub.deploymentCancel(...args),
        deploymentAcknowledge: (...args: Parameters<typeof stub.deploymentAcknowledge>) =>
          stub.deploymentAcknowledge(...args),
      }),
    },
  } as unknown as Env;
  const registry = createRegistry();
  registry.install(
    buildMcp(probeEnv, { ownerId: owner, chatId: 'stop-race' }, configs, bindings).extension,
  );
  const pi = await Harness.open(new MemoryStorage(), { models: fixtureModels(), registry }, BG);
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
    await vi.waitFor(() => expect(operation).not.toBe(''));
    const stopping = root.abort(BG, { background: true });
    await vi.waitFor(async () =>
      expect((await pi.getTask(JSON.parse(operation)[2], BG))?.abortRequested).toBe(true),
    );
    release();
    await stopping;
    await vi.waitFor(async () => expect((await pi.inspect(BG)).tasks).toEqual([]));
    expect((await pi.getTask(JSON.parse(operation)[2], BG))?.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed', result: { text: expect.stringContaining('found') } },
    });
    expect(remote.counts().mutations).toBe(1);
    expect(
      await runInDurableObject(stub, (_, state) =>
        state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
      ),
    ).toEqual([{ status: 'acknowledged' }]);
  } finally {
    release();
    await pi.close(BG);
  }
});

it.each([false, true])(
  'deletion reconciles a deployment response before the native result commit without reopening execution (cold=%s)',
  async (cold) => {
    const remote = server();
    const { owner, bindings, configs, stub } = await setup();
    let release!: () => void;
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let operation = '';
    const probeEnv = {
      ...env,
      MCP_CONNECTIONS: {
        getByName: () => ({
          deploymentCall: async (...args: Parameters<typeof stub.deploymentCall>) => {
            const receipt = await env.MCP_CONNECTIONS.get(stub.id).deploymentCall(...args);
            operation = args[3].operation;
            await delivered;
            return receipt;
          },
          deploymentCancel: (...args: Parameters<typeof stub.deploymentCancel>) =>
            env.MCP_CONNECTIONS.get(stub.id).deploymentCancel(...args),
          deploymentAcknowledge: (...args: Parameters<typeof stub.deploymentAcknowledge>) =>
            env.MCP_CONNECTIONS.get(stub.id).deploymentAcknowledge(...args),
        }),
      },
    } as unknown as Env;
    const registry = createRegistry();
    registry.install(
      buildMcp(probeEnv, { ownerId: owner, chatId: 'delete-response-gap' }, configs, bindings)
        .extension,
    );
    const storage = new ReopenableMemoryStorage();
    const pi = await Harness.open(storage, { models: fixtureModels(), registry }, BG);
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
      await vi.waitFor(() => expect(operation).not.toBe(''));
      const closing = pi.close(BG);
      release();
      await closing;
      expect(
        (await storage.scanTasks({ kind: 'app.deployment-mcp-call' }, 10, undefined, BG)).items[0]
          ?.state.status,
      ).not.toBe('terminal');
      expect(
        (await storage.scanTasks({ kind: 'app.deployment-mcp-acknowledgement' }, 10, undefined, BG))
          .items,
      ).toEqual([]);
      if (cold) await abortAllDurableObjects();
      expect(
        await runInDurableObject(env.MCP_CONNECTIONS.get(stub.id), (_, state) =>
          state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'responded' }]);
      await drainMcpAcknowledgements(storage, probeEnv, BG);
      await drainMcpAcknowledgements(storage, probeEnv, BG);
      expect(
        await runInDurableObject(env.MCP_CONNECTIONS.get(stub.id), (_, state) =>
          state.storage.sql.exec('SELECT status,result FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'acknowledged', result: null }]);
      expect(
        (await storage.scanTasks({ kind: 'app.deployment-mcp-call' }, 10, undefined, BG)).items[0]
          ?.state.status,
      ).not.toBe('terminal');
      expect(remote.counts().mutations).toBe(1);
      const binding = bindings.find((value) => value.remoteName === 'lookup')!;
      const next = input(binding, operationId('next-after-delete', 1, 99));
      expect(
        await env.MCP_CONNECTIONS.get(stub.id).deploymentCall(
          owner,
          binding.serverId,
          binding.configurationRevision,
          next,
        ),
      ).toMatchObject({ ok: true });
      await env.MCP_CONNECTIONS.get(stub.id).deploymentAcknowledge(
        owner,
        binding.serverId,
        next.operation,
      );
      expect(remote.counts().mutations).toBe(2);
    } finally {
      release();
      await pi.close(BG);
    }
  },
);

it('deletion metadata reconciliation preserves an unknown unsafe outcome instead of acknowledging it', async () => {
  const remote = server({ fault: 'lost' });
  const { owner, configs, bindings, stub } = await setup();
  const registry = createRegistry();
  registry.install(
    buildMcp(env as Env, { ownerId: owner, chatId: 'delete-unknown' }, configs, bindings).extension,
  );
  const storage = new ReopenableMemoryStorage();
  const pi = await Harness.open(storage, { models: fixtureModels(), registry }, BG);
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await root.submit({ type: 'input', content: 'mcp lookup' }, BG);
    await root.waitForIdle(BG);
    await pi.close(BG);
    await abortAllDurableObjects();
    await drainMcpAcknowledgements(storage, env as Env, BG);
    const current = env.MCP_CONNECTIONS.get(stub.id);
    expect(
      await runInDurableObject(current, (_, state) =>
        state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
      ),
    ).toEqual([{ status: 'unknown' }]);
    const binding = bindings.find((value) => value.remoteName === 'lookup')!;
    expect(
      await current.deploymentCall(
        owner,
        binding.serverId,
        binding.configurationRevision,
        input(binding, operationId('next-after-unknown-delete', 1, 1)),
      ),
    ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
    expect(remote.counts().mutations).toBe(1);
  } finally {
    await pi.close(BG);
  }
});
