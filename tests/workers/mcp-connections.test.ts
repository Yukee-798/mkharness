import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionView } from '../../src/shared/mcp-connections';
import {
  connectionViews,
  newConversationBindings,
  ownedConnection,
  userConnection,
} from '../../src/server/mcp/connections/catalog';
import { McpRequests } from '../../src/server/mcp/connections/requests';
import { BG } from '../../src/server/chat/context';
import { userMcpContribution } from '../../src/extensions/mcp/server';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { fixtureModels } from '../fixture-model';
import {
  drainMcpAcknowledgements,
  mcpAcknowledgementTasks,
} from '../../src/server/mcp/acknowledgement';

async function pendingMcpAcknowledgements(pi: Harness, context: typeof BG) {
  return (await pi.inspect(context)).tasks.some(({ record }) =>
    ['app.mcp-acknowledgement', 'app.deployment-mcp-acknowledgement'].includes(record.kind),
  );
}
afterEach(() => vi.restoreAllMocks());
class ReopenableMemoryStorage extends MemoryStorage {
  override async close() {}
}
function mockServer(
  options: {
    oauth?: boolean;
    lostResult?: boolean;
    privateMetadata?: boolean;
    refresh?: boolean;
  } = {},
) {
  let expired = false;
  let calls = 0,
    registrations = 0,
    exchanges = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url);
    if (url.hostname === 'cloudflare-dns.com')
      return Response.json({
        Status: 0,
        Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
      });
    if (url.pathname.includes('oauth-protected-resource'))
      return Response.json({
        resource: 'https://remote.example.test/mcp',
        authorization_servers: [
          options.privateMetadata ? 'https://127.0.0.1' : 'https://oauth.example.test',
        ],
        scopes_supported: ['read'],
      });
    if (
      url.pathname.includes('oauth-authorization-server') ||
      url.pathname.includes('openid-configuration')
    )
      return Response.json({
        issuer: 'https://oauth.example.test',
        authorization_endpoint: 'https://oauth.example.test/authorize',
        token_endpoint: 'https://oauth.example.test/token',
        registration_endpoint: 'https://oauth.example.test/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    if (url.pathname === '/register') {
      registrations++;
      return Response.json(
        { ...((await req.json()) as object), client_id: 'test-client' },
        { status: 201 },
      );
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
      if (exchanges && options.refresh) {
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe('fixture-refresh');
      }
      exchanges++;
      return Response.json({
        access_token: exchanges > 1 ? 'fixture-oauth-rotated' : 'fixture-oauth-access',
        token_type: 'Bearer',
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
      });
    }
    if (
      options.oauth &&
      (!req.headers.has('Authorization') ||
        (options.refresh &&
          expired &&
          req.headers.get('Authorization') === 'Bearer fixture-oauth-access'))
    )
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://remote.example.test/.well-known/oauth-protected-resource"',
        },
      });
    if (req.method === 'GET') return new Response(null, { status: 405 });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = (await req.json()) as any;
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
        tools: [
          {
            name: 'read_document',
            description: 'Read document',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        ],
      };
    if (rpc.method === 'tools/call') {
      calls++;
      if (options.lostResult) throw new Error('lost after remote dispatch');
      result = { content: [{ type: 'text', text: 'fixture document' }] };
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  });
  return {
    network,
    expire: () => {
      expired = true;
    },
    counts: () => ({ calls, registrations, exchanges }),
  };
}
async function makeConnection(auth: 'none' | 'auto' | 'bearer' = 'none') {
  const owner = crypto.randomUUID(),
    id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
  )
    .bind(owner, 'MCP test', owner + '@example.test', 0, Date.now(), Date.now())
    .run();
  await env.DB.prepare(
    'INSERT INTO mcp_connections(id,owner,name,endpoint,created_at) VALUES(?,?,?,?,?)',
  )
    .bind(id, owner, 'Remote docs', 'https://remote.example.test/mcp', Date.now())
    .run();
  const stub = userConnection(env as Env, owner, id);
  await stub.initialize(owner, id, {
    name: 'Remote docs',
    endpoint: 'https://remote.example.test/mcp',
    auth,
    ...(auth === 'bearer' ? { token: 'fixture-bearer-secret' } : {}),
  });
  return { owner, id, stub };
}
it('uses SDK discovery, isolates owners, encrypts bearer credentials and restores without eager networking', async () => {
  const remote = mockServer();
  const { owner, id, stub } = await makeConnection('bearer');
  const result = await stub.connectRemote(owner);
  const view = JSON.parse(result.connection) as ConnectionView;
  expect(view.status).toBe('ready');
  expect(view.tools).toHaveLength(1);
  await expect(ownedConnection(env as Env, 'other-owner', id)).rejects.toThrow(
    'mcp_connection_not_found',
  );
  expect(JSON.parse(await stub.metadata('other-owner'))).toMatchObject({
    error: { code: 'mcp_connection_not_found' },
  });
  const stored = await runInDurableObject(stub, (_, state) => state.storage.list());
  expect(JSON.stringify([...stored])).not.toContain('fixture-bearer-secret');
  expect(remote.counts().calls).toBe(0);
  await abortAllDurableObjects();
  remote.network.mockClear();
  const restored = userConnection(env as Env, owner, id);
  expect(JSON.parse(await restored.metadata(owner)).tools).toHaveLength(1);
  expect(remote.network).not.toHaveBeenCalled();
});
it('keeps an interrupted deletion readable and safely retries revocation after reconstruction', async () => {
  const remote = mockServer();
  const { owner, id, stub } = await makeConnection('bearer');
  const before = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  // Simulate a crash after DO revocation but before the HTTP route tombstones its D1 index.
  await stub.disconnect(owner);
  await abortAllDurableObjects();
  expect(await connectionViews(env as Env, owner)).toMatchObject([
    { id, status: 'disconnected', enabled: false, grant: before.grant + 1 },
  ]);
  const restored = await ownedConnection(env as Env, owner, id);
  await restored.disconnect(owner);
  await restored.disconnect(owner);
  expect(JSON.parse(await restored.metadata(owner))).toMatchObject({
    status: 'disconnected',
    grant: before.grant + 1,
  });
  expect(JSON.parse(await restored.metadata('other-owner'))).toMatchObject({
    error: { code: 'mcp_connection_not_found' },
  });
  expect(
    await restored.call(owner, {
      name: before.tools[0]!.name,
      hash: before.tools[0]!.hash,
      grant: before.grant,
      authorization: 'once',
      expiresAt: Date.now() + 60_000,
      operation: 'revoked-connection',
      arguments: '{"query":"docs"}',
    }),
  ).toMatchObject({ ok: false, code: 'mcp_connection_not_found' });
  expect(await newConversationBindings(env as Env, owner)).toEqual([]);
  const secrets = await runInDurableObject(restored, (_, state) =>
    state.storage.list({ prefix: 'secret:' }),
  );
  expect(secrets.size).toBe(0);
  expect(remote.counts().calls).toBe(0);
});
it('completes native OAuth discovery, DCR, state/PKCE callback and encrypted token storage', async () => {
  const remote = mockServer({ oauth: true });
  const { owner, id } = await makeConnection('auto');
  let stub = userConnection(env as Env, owner, id);
  const start = await stub.connectRemote(owner);
  expect(JSON.parse(start.connection).status).toBe('authorizing');
  expect(start.authorizationUrl).toBeTruthy();
  const authorization = new URL(start.authorizationUrl!);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  await abortAllDurableObjects();
  stub = userConnection(env as Env, owner, id);
  const callback = new URL('/api/mcp/callback', env.APP_URL);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('code', 'fixture-code');
  const invalid = new URL(callback);
  invalid.searchParams.set('state', 'wrong.' + id);
  expect(await stub.callback(owner, invalid.href)).toEqual({
    ok: false,
    code: 'mcp_authorization_failed',
  });
  expect(await stub.callback(owner, callback.href)).toEqual({ ok: true });
  expect(JSON.parse(await stub.metadata(owner)).status).toBe('ready');
  expect(remote.counts()).toMatchObject({ registrations: 1, exchanges: 1 });
  await abortAllDurableObjects();
  stub = userConnection(env as Env, owner, id);
  expect(JSON.parse((await stub.connectRemote(owner)).connection).status).toBe('ready');
  expect(remote.counts()).toMatchObject({ registrations: 1, exchanges: 1 });
  const stored = await runInDurableObject(stub, (_, state) => state.storage.list());
  expect(JSON.stringify([...stored])).not.toContain('fixture-oauth-access');
  expect(JSON.stringify([...stored])).not.toContain('fixture-refresh');
  expect(await stub.callback(owner, callback.href)).toEqual({
    ok: false,
    code: 'mcp_authorization_failed',
  });
});
it('pins tools for a chat and blocks later permission revocation before remote dispatch', async () => {
  const remote = mockServer();
  const { owner, stub } = await makeConnection();
  const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  const bindings = await newConversationBindings(env as Env, owner);
  expect(bindings).toHaveLength(1);
  await stub.configure(owner, {
    revision: view.revision,
    permissions: { read_document: 'disabled' },
  });
  const result = await stub.call(owner, {
    name: 'read_document',
    hash: bindings[0].tool.hash,
    grant: bindings[0].grant,
    authorization: 'once',
    expiresAt: Date.now() + 60_000,
    operation: 'revoked',
    arguments: '{"query":"docs"}',
  });
  expect(result).toMatchObject({ ok: false, code: 'mcp_disabled' });
  expect(remote.counts().calls).toBe(0);
});
it('never repeats an uncertain operation, including after connection reconstruction', async () => {
  const remote = mockServer({ lostResult: true });
  const { owner, id, stub } = await makeConnection();
  const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  const input = {
    name: 'read_document',
    hash: view.tools[0].hash,
    grant: view.grant,
    authorization: 'once' as const,
    expiresAt: Date.now() + 60_000,
    operation: 'one',
    arguments: '{"query":"docs"}',
  };
  expect(await stub.call(owner, input)).toMatchObject({
    ok: false,
    code: 'remote_outcome_unknown',
  });
  await abortAllDurableObjects();
  expect(
    await userConnection(env as Env, owner, id).call(owner, { ...input, operation: 'two' }),
  ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
  expect(remote.counts().calls).toBe(1);
});
it.each(['dispatching', 'unknown', 'responded'] as const)(
  'uses the outstanding index with settled history while retaining the %s unsafe guard',
  async (status) => {
    const remote = mockServer();
    const { owner, id, stub } = await makeConnection();
    const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
    const input = {
      name: 'read_document',
      hash: view.tools[0].hash,
      grant: view.grant,
      authorization: 'once' as const,
      expiresAt: Date.now() + 60_000,
      operation: 'outstanding',
      arguments: '{"query":"docs"}',
    };
    expect(await stub.call(owner, input)).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<1000) INSERT INTO mcp_dispatch(id,status,replay) SELECT 'settled-'||n,'acknowledged','unsafe' FROM history",
      );
      sql.exec('UPDATE mcp_dispatch SET status=? WHERE id=?', status, input.operation);
      const plan = sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT * FROM mcp_dispatch WHERE replay='unsafe' AND status IN ('dispatching','unknown','responded') LIMIT 1",
        )
        .toArray();
      expect(plan.map((row) => row.detail).join('\n')).toContain('mcp_dispatch_outstanding');
    });
    await abortAllDurableObjects();
    const restored = userConnection(env as Env, owner, id);
    expect(await restored.call(owner, { ...input, operation: 'next' })).toMatchObject({
      ok: false,
      code: status === 'responded' ? 'mcp_connection_busy' : 'remote_outcome_unknown',
    });
    expect(remote.counts().calls).toBe(1);
    if (status === 'responded') {
      await restored.acknowledge(owner, input.operation);
      expect(await restored.call(owner, { ...input, operation: 'next' })).toMatchObject({
        ok: true,
      });
      expect(remote.counts().calls).toBe(2);
      await restored.acknowledge(owner, 'next');
    }
  },
);
it.each(['approved', 'rejected', 'stop'] as const)(
  'persists a native Pi approval and handles %s without an Agent host',
  async (decision) => {
    const remote = mockServer();
    const { owner, stub } = await makeConnection();
    await stub.connectRemote(owner);
    const bindings = await newConversationBindings(env as Env, owner);
    const chatId = crypto.randomUUID();
    const storage = new ReopenableMemoryStorage();
    let pi: Harness;
    const contribution = await userMcpContribution(env as Env, {
      identity: chatId,
      conversationId: chatId,
      ownerId: owner,
      mcpBindings: bindings,
      pi: async () => pi,
      command: async () => undefined,
    });
    const registry = createRegistry();
    registry.install(contribution.extension!);
    pi = await Harness.open(storage, { models: fixtureModels(), registry }, BG);
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'custom_mcp_probe' }, BG);
      let parentId = 0;
      await vi.waitFor(async () => {
        const doc = await pi.snapshot(McpRequests, root.id, BG);
        parentId =
          Object.values(doc?.requests ?? {}).find((request) => request.status === 'pending')
            ?.parentId ?? 0;
        expect(parentId).toBeGreaterThan(0);
      });
      expect(remote.counts().calls).toBe(0);
      if (decision === 'stop') await root.abort(BG, { background: true });
      else {
        if (decision === 'approved') {
          await pi.close(BG);
          await abortAllDurableObjects();
          pi = await Harness.open(storage, { models: fixtureModels(), registry }, BG);
        }
        const current = (await pi.conversation(root.id, BG))!;
        await contribution.controls!.decide.invoke(
          { parentId, decision },
          { conversation: current, context: BG },
        );
        await current.waitForIdle(BG);
      }
      expect(remote.counts().calls).toBe(decision === 'approved' ? 1 : 0);
      const requests = (await pi.snapshot(McpRequests, root.id, BG))?.requests ?? {};
      expect(Object.values(requests)).toContainEqual(
        expect.objectContaining({
          status:
            decision === 'approved' ? 'completed' : decision === 'stop' ? 'stopped' : 'rejected',
        }),
      );
    } finally {
      await pi.close(BG);
    }
  },
);

it('rejects private authorization metadata before contacting that destination', async () => {
  const remote = mockServer({ oauth: true, privateMetadata: true });
  const { owner, stub } = await makeConnection('auto');
  const result = await stub.connectRemote(owner);
  expect(JSON.parse(result.connection).status).toBe('error');
  expect(
    remote.network.mock.calls.some(
      ([input]) =>
        new URL(String(input instanceof Request ? input.url : input)).hostname === '127.0.0.1',
    ),
  ).toBe(false);
  expect(remote.counts().registrations).toBe(0);
});

it('uses native token refresh and retains the connection grant across rotation', async () => {
  const remote = mockServer({ oauth: true, refresh: true });
  const { owner, stub } = await makeConnection('auto');
  const authorization = new URL((await stub.connectRemote(owner)).authorizationUrl!);
  const callback = new URL('/api/mcp/callback', env.APP_URL);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('code', 'fixture-code');
  expect(await stub.callback(owner, callback.href)).toEqual({ ok: true });
  const before = JSON.parse(await stub.metadata(owner)) as ConnectionView;
  remote.expire();
  const after = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  expect(after.status).toBe('ready');
  expect(after.grant).toBe(before.grant);
  expect(remote.counts()).toMatchObject({ registrations: 1, exchanges: 2 });
  const stored = await runInDurableObject(stub, (_, state) => state.storage.list());
  expect(JSON.stringify([...stored])).not.toContain('fixture-oauth-rotated');
});

it('rechecks expiry, tightened approval policy and cancellation immediately before dispatch', async () => {
  const remote = mockServer();
  const { owner, stub } = await makeConnection();
  const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  const input = {
    name: 'read_document',
    hash: view.tools[0].hash,
    grant: view.grant,
    operation: 'cancelled',
    arguments: '{"query":"docs"}',
    authorization: 'auto' as const,
    expiresAt: Date.now() + 60_000,
  };
  expect(await stub.call(owner, input)).toMatchObject({ ok: false, code: 'mcp_approval_required' });
  expect(
    await stub.call(owner, { ...input, authorization: 'once', expiresAt: Date.now() - 1 }),
  ).toMatchObject({ ok: false, code: 'mcp_approval_expired' });
  expect(await stub.cancel(owner, input.operation)).toEqual({ dispatched: false });
  expect(await stub.call(owner, { ...input, authorization: 'once' })).toMatchObject({
    ok: false,
    code: 'mcp_cancelled',
  });
  expect(remote.counts().calls).toBe(0);
});

it('distinguishes another chat awaiting durable acknowledgement from an unknown outcome', async () => {
  const remote = mockServer();
  const { owner, stub } = await makeConnection();
  const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  const input = {
    name: 'read_document',
    hash: view.tools[0].hash,
    grant: view.grant,
    authorization: 'once' as const,
    expiresAt: Date.now() + 60_000,
    operation: 'chat-one',
    arguments: '{"query":"docs"}',
  };
  expect(await stub.call(owner, input)).toMatchObject({ ok: true });
  expect(await stub.call(owner, { ...input, operation: 'chat-two' })).toMatchObject({
    ok: false,
    code: 'mcp_connection_busy',
  });
  await stub.acknowledge(owner, input.operation);
  expect(await stub.call(owner, { ...input, operation: 'chat-two' })).toMatchObject({ ok: true });
  expect(remote.counts().calls).toBe(2);
  await stub.acknowledge(owner, 'chat-two');
});

async function nativeAcknowledgementFixture(
  acknowledge: (stub: ReturnType<typeof userConnection>, operation: string) => Promise<void>,
  onResult?: () => Promise<void>,
) {
  const remote = mockServer();
  const { owner, id, stub } = await makeConnection();
  const view = JSON.parse((await stub.connectRemote(owner)).connection) as ConnectionView;
  await stub.configure(owner, { revision: view.revision, permissions: { read_document: 'auto' } });
  const bindings = await newConversationBindings(env as Env, owner);
  let operation = '';
  const live = () => userConnection(env as Env, owner, id);
  const probeEnv = {
    ...env,
    MCP_CONNECTIONS: {
      getByName: () => ({
        metadata: (...args: Parameters<typeof stub.metadata>) => live().metadata(...args),
        call: async (...args: Parameters<typeof stub.call>) => {
          const receipt = await live().call(...args);
          operation = args[1].operation;
          await onResult?.();
          return receipt;
        },
        cancel: (...args: Parameters<typeof stub.cancel>) => live().cancel(...args),
        acknowledge: (_owner: string, operation: string) => acknowledge(live(), operation),
      }),
    },
  } as unknown as Env;
  const chatId = crypto.randomUUID();
  const registry = async () => {
    const value = createRegistry();
    const contribution = await userMcpContribution(probeEnv, {
      identity: chatId,
      conversationId: chatId,
      ownerId: owner,
      mcpBindings: bindings,
      pi: async () => {
        throw new Error('unused host');
      },
      command: async () => undefined,
    });
    value.install(contribution.extension!);
    return value;
  };
  return { remote, owner, id, stub, bindings, registry, probeEnv, operation: () => operation };
}

it.each(['before delivery', 'after delivery'] as const)(
  'retries a user acknowledgement lost %s without replaying its remote call',
  async (failure) => {
    let attempts = 0;
    let savedResult: unknown;
    const fixture = await nativeAcknowledgementFixture(async (stub, operation) => {
      attempts++;
      if (attempts === 1) {
        savedResult = (await pi.getTask(JSON.parse(operation)[2], BG))?.state;
        if (failure === 'after delivery') await stub.acknowledge(fixture.owner, operation);
        throw new Error('lost acknowledgement RPC');
      }
      await stub.acknowledge(fixture.owner, operation);
    });
    const pi = await Harness.open(
      new MemoryStorage(),
      {
        models: fixtureModels(),
        registry: await fixture.registry(),
      },
      BG,
    );
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'custom_mcp_probe' }, BG);
      await root.waitForIdle(BG);
      await vi.waitFor(
        async () => {
          expect(attempts).toBe(2);
          expect(await pendingMcpAcknowledgements(pi, BG)).toBe(false);
        },
        { timeout: 5000 },
      );
      expect(savedResult).toMatchObject({
        status: 'terminal',
        outcome: {
          status: 'completed',
          result: { text: expect.stringContaining('fixture document') },
        },
      });
      expect(JSON.stringify((await root.context(BG)).messages)).toContain('fixture document');
      const tool = fixture.bindings[0];
      expect(
        await fixture.stub.call(fixture.owner, {
          name: tool.tool.name,
          hash: tool.tool.hash,
          grant: tool.grant,
          arguments: '{"query":"next"}',
          authorization: 'auto',
          expiresAt: Date.now() + 60_000,
          operation: 'next-chat',
        }),
      ).toMatchObject({ ok: true });
      await fixture.stub.acknowledge(fixture.owner, 'next-chat');
      expect(fixture.remote.counts().calls).toBe(2);
    } finally {
      await pi.close(BG);
    }
  },
);

it.each(['native retry', 'deletion drain', 'disabled cold retry', 'in-flight Stop'] as const)(
  'preserves one user acknowledgement through cold reconstruction, repeated Stop and %s',
  async (recovery) => {
    let available = false;
    let attempts = 0;
    let releaseAvailability!: () => void;
    const delayed = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    const fixture = await nativeAcknowledgementFixture(async (stub, operation) => {
      attempts++;
      if (!available) {
        if (recovery === 'in-flight Stop') await delayed;
        else throw new Error('acknowledgement unavailable');
      }
      await stub.acknowledge(fixture.owner, operation);
    });
    const storage = new ReopenableMemoryStorage();
    let pi = await Harness.open(
      storage,
      { models: fixtureModels(), registry: await fixture.registry() },
      BG,
    );
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'custom_mcp_probe' }, BG);
      await root.waitForIdle(BG);
      await vi.waitFor(() => expect(attempts).toBe(1));
      expect(await pendingMcpAcknowledgements(pi, BG)).toBe(true);
      await pi.close(BG);
      await abortAllDurableObjects();
      const restoredRegistry =
        recovery === 'disabled cold retry' ? createRegistry() : await fixture.registry();
      if (recovery === 'disabled cold retry') {
        const disabled = await userMcpContribution(
          fixture.probeEnv,
          {
            identity: 'disabled',
            conversationId: 'disabled',
            ownerId: fixture.owner,
            mcpBindings: fixture.bindings,
            pi: async () => pi,
            command: async () => undefined,
          },
          { mcp: { enabled: true, custom: false } },
        );
        expect(disabled.extension).toBeUndefined();
        restoredRegistry.install({
          name: 'host-mcp-acknowledgements',
          tasks: mcpAcknowledgementTasks(fixture.probeEnv),
        });
      }
      pi = await Harness.open(storage, { models: fixtureModels(), registry: restoredRegistry }, BG);
      const restored = (await pi.conversation(root.id, BG))!;
      for (let stop = 0; stop < 2; stop++) {
        await restored.abort(BG, { background: true });
        const pending = (await pi.inspect(BG)).tasks;
        expect(pending).toHaveLength(1);
        expect(pending[0].record.kind).toBe('app.mcp-acknowledgement');
        expect(pending[0].record.input).toMatchObject({ operation: fixture.operation() });
        expect(
          Object.values((await pi.snapshot(McpRequests, root.id, BG))!.requests),
        ).toMatchObject([{ status: 'completed' }]);
        expect((await pi.getTask(JSON.parse(fixture.operation())[2], BG))?.state).toMatchObject({
          status: 'terminal',
          outcome: {
            status: 'completed',
            result: { text: expect.stringContaining('fixture document') },
          },
        });
      }
      if (recovery === 'deletion drain') {
        await pi.close(BG);
        await expect(drainMcpAcknowledgements(storage, fixture.probeEnv, BG)).rejects.toThrow(
          'acknowledgement unavailable',
        );
        available = true;
        await drainMcpAcknowledgements(storage, fixture.probeEnv, BG);
        await drainMcpAcknowledgements(storage, fixture.probeEnv, BG);
      } else {
        available = true;
        releaseAvailability();
        await vi.waitFor(async () => expect(await pendingMcpAcknowledgements(pi, BG)).toBe(false), {
          timeout: 5000,
        });
      }
      expect(fixture.remote.counts().calls).toBe(1);
      expect(
        await runInDurableObject(
          userConnection(env as Env, fixture.owner, fixture.id),
          (_, state) => state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'acknowledged' }]);
    } finally {
      releaseAvailability();
      await pi.close(BG);
    }
  },
);

it('keeps a known user result completed when Stop races its native result commit', async () => {
  let release!: () => void;
  const delivered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await nativeAcknowledgementFixture(
    async (stub, operation) => stub.acknowledge(fixture.owner, operation),
    () => delivered,
  );
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models: fixtureModels(),
      registry: await fixture.registry(),
    },
    BG,
  );
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await root.submit({ type: 'input', content: 'custom_mcp_probe' }, BG);
    await vi.waitFor(() => expect(fixture.operation()).not.toBe(''));
    const stopping = root.abort(BG, { background: true });
    await vi.waitFor(async () =>
      expect((await pi.getTask(JSON.parse(fixture.operation())[2], BG))?.abortRequested).toBe(true),
    );
    release();
    await stopping;
    await vi.waitFor(async () => expect(await pendingMcpAcknowledgements(pi, BG)).toBe(false));
    expect(Object.values((await pi.snapshot(McpRequests, root.id, BG))!.requests)).toMatchObject([
      { status: 'completed' },
    ]);
    expect((await pi.getTask(JSON.parse(fixture.operation())[2], BG))?.state).toMatchObject({
      status: 'terminal',
      outcome: {
        status: 'completed',
        result: { text: expect.stringContaining('fixture document') },
      },
    });
    expect(fixture.remote.counts().calls).toBe(1);
    expect(
      await runInDurableObject(fixture.stub, (_, state) =>
        state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
      ),
    ).toEqual([{ status: 'acknowledged' }]);
  } finally {
    release();
    await pi.close(BG);
  }
});

it.each(['warm', 'cold', 'disconnected'] as const)(
  'deletion reconciles a user response before its native result commit with %s connection metadata only',
  async (mode) => {
    let release!: () => void;
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await nativeAcknowledgementFixture(
      async (stub, operation) => stub.acknowledge(fixture.owner, operation),
      () => delivered,
    );
    const storage = new ReopenableMemoryStorage();
    const pi = await Harness.open(
      storage,
      { models: fixtureModels(), registry: await fixture.registry() },
      BG,
    );
    try {
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'custom_mcp_probe' }, BG);
      await vi.waitFor(() => expect(fixture.operation()).not.toBe(''));
      const closing = pi.close(BG);
      release();
      await closing;
      expect(
        (await storage.scanTasks({ kind: 'app.mcp-call' }, 10, undefined, BG)).items[0]?.state
          .status,
      ).not.toBe('terminal');
      expect(
        (await storage.scanTasks({ kind: 'app.mcp-acknowledgement' }, 10, undefined, BG)).items,
      ).toEqual([]);
      if (mode === 'disconnected')
        await userConnection(env as Env, fixture.owner, fixture.id).disconnect(fixture.owner);
      if (mode === 'cold') await abortAllDurableObjects();
      const current = userConnection(env as Env, fixture.owner, fixture.id);
      expect(
        await runInDurableObject(current, (_, state) =>
          state.storage.sql.exec('SELECT status FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'responded' }]);
      await drainMcpAcknowledgements(storage, fixture.probeEnv, BG);
      await drainMcpAcknowledgements(storage, fixture.probeEnv, BG);
      expect(
        await runInDurableObject(current, (_, state) =>
          state.storage.sql.exec('SELECT status,result FROM mcp_dispatch').toArray(),
        ),
      ).toEqual([{ status: 'acknowledged', result: null }]);
      expect(
        (await storage.scanTasks({ kind: 'app.mcp-call' }, 10, undefined, BG)).items[0]?.state
          .status,
      ).not.toBe('terminal');
      expect(fixture.remote.counts().calls).toBe(1);
    } finally {
      release();
      await pi.close(BG);
    }
  },
);
