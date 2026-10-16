import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionView } from '../../src/shared/mcp-connections';
import {
  connectionViews,
  newConversationBindings,
  ownedConnection,
} from '../../src/server/mcp/connections/catalog';
import { McpRequests } from '../../src/server/mcp/connections/requests';
import { BG } from '../../src/server/conversations/context';

afterEach(() => vi.restoreAllMocks());
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
  const stub = env.MCP_CONNECTIONS.getByName(id);
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
  const restored = env.MCP_CONNECTIONS.getByName(id);
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
  let stub = env.MCP_CONNECTIONS.getByName(id);
  const start = await stub.connectRemote(owner);
  expect(JSON.parse(start.connection).status).toBe('authorizing');
  expect(start.authorizationUrl).toBeTruthy();
  const authorization = new URL(start.authorizationUrl!);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  await abortAllDurableObjects();
  stub = env.MCP_CONNECTIONS.getByName(id);
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
  stub = env.MCP_CONNECTIONS.getByName(id);
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
    await env.MCP_CONNECTIONS.getByName(id).call(owner, { ...input, operation: 'two' }),
  ).toMatchObject({ ok: false, code: 'remote_outcome_unknown' });
  expect(remote.counts().calls).toBe(1);
});
it.each(['approved', 'rejected', 'stop'] as const)(
  'persists a real model-issued Pi tool approval and handles %s',
  async (decision) => {
    const remote = mockServer();
    const { owner, stub } = await makeConnection();
    await stub.connectRemote(owner);
    const bindings = await newConversationBindings(env as Env, owner);
    const conversation = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO conversations(id,owner,title,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
      .bind(conversation, owner, 'MCP approval', Date.now(), Date.now())
      .run();
    await env.DB.prepare('INSERT INTO conversation_mcp_bindings(conversation,bindings) VALUES(?,?)')
      .bind(conversation, JSON.stringify(bindings))
      .run();
    let agent = env.CONVERSATIONS.getByName(conversation);
    await agent.submitRun({ runId: crypto.randomUUID(), text: 'custom_mcp_probe' });
    let parent = 0;
    for (let i = 0; i < 100; i++) {
      parent = await runInDurableObject(agent, async (instance) => {
        const root = await instance.root();
        const doc = await (instance as any).harness
          .pi()
          .then((pi: any) => pi.snapshot(McpRequests, root.id, BG));
        return Number(
          (Object.values(doc?.requests ?? {}).find((r: any) => r.status === 'pending') as any)
            ?.parentId ?? 0,
        );
      });
      if (parent) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(parent).toBeGreaterThan(0);
    const pendingSnapshot = JSON.parse(await agent.snapshot());
    const assistant = pendingSnapshot.entries.find((entry: any) =>
      entry.model?.some(
        (message: any) =>
          message.role === 'assistant' &&
          message.content.some(
            (part: any) => part.type === 'toolCall' && part.name === bindings[0]!.name,
          ),
      ),
    );
    const call = assistant.model
      .flatMap((message: any) => (message.role === 'assistant' ? message.content : []))
      .find((part: any) => part.type === 'toolCall' && part.name === bindings[0]!.name);
    const projected = pendingSnapshot.extensionState.mcp.requests.find(
      (request: any) => request.parentId === parent,
    );
    expect(projected).toMatchObject({
      status: 'pending',
      toolCallId: `${assistant.id}.${encodeURIComponent(call.id)}`,
    });
    expect(await agent.controlExtension('mcp', 'decide', '{}')).toMatchObject({
      ok: false,
      code: 'invalid_mcp_request',
    });
    expect(remote.counts().calls).toBe(0);
    if (decision === 'stop') await agent.stopConversation();
    else {
      if (decision === 'approved') {
        await abortAllDurableObjects();
        agent = env.CONVERSATIONS.getByName(conversation);
        expect(JSON.parse(await agent.snapshot()).extensionState.mcp.requests).toContainEqual(
          projected,
        );
      }
      expect(
        await agent.controlExtension(
          'mcp',
          'decide',
          JSON.stringify({ parentId: parent, decision }),
        ),
      ).toMatchObject({ ok: true });
    }
    let settled = false;
    for (let i = 0; i < 100; i++) {
      const snapshot = JSON.parse(await agent.snapshot());
      if (!snapshot.pending.length && !snapshot.stopping) {
        settled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settled).toBe(true);
    expect(remote.counts().calls).toBe(decision === 'approved' ? 1 : 0);
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
