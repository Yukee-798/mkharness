import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { RemoteIntents } from '../../src/server/remote-intents';
import { BG } from '../../src/server/conversation';

it.each(['lost-receipt', 'invalid-result', 'stop-during-call', 'stop-before-result'])(
  'does not repeat unsafe MCP effects after %s, another call or DO reconstruction',
  async (fault) => {
    let mutations = 0,
      reads = 0;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      const rpc = (await request.json()) as any;
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'unsafe-controlled-fixture', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: ['lookup', 'status'].map((name) => ({
            name,
            description: name,
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
              additionalProperties: false,
            },
          })),
        };
      if (rpc.method === 'tools/call') {
        if (rpc.params.name === 'lookup') {
          mutations++;
          if (fault === 'lost-receipt') throw new Error('accepted mutation, receipt lost');
          if (fault === 'stop-during-call')
            await new Promise<never>((_resolve, reject) => {
              const abort = () => reject(request.signal.reason);
              if (request.signal.aborted) abort();
              else request.signal.addEventListener('abort', abort, { once: true });
            });
          result = {
            content: [
              { type: 'resource_link', name: 'unsupported', uri: 'https://example.test/result' },
            ],
          };
          if (fault === 'stop-before-result')
            result = { content: [{ type: 'text', text: 'remote operation completed' }] };
        } else {
          reads++;
          result = { content: [{ type: 'text', text: 'original operation status' }] };
        }
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
    });
    let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const settled = async () => {
      for (let i = 0; i < 150; i++) {
        const snapshot = JSON.parse(await stub.snapshot());
        if (!snapshot.pending.length && !snapshot.stopping) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('MCP run did not settle');
    };
    try {
      await runInDurableObject(stub, (_, state) => {
        state.storage.sql.exec('CREATE TABLE test_mcp(key TEXT)');
        state.storage.sql.exec("INSERT INTO test_mcp VALUES('unsafe-probe')");
        if (fault === 'stop-before-result')
          state.storage.sql.exec("INSERT INTO test_mcp VALUES('pause-result')");
      });
      await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp unsafe retry' });
      if (fault.startsWith('stop-')) {
        let ready = false;
        for (let i = 0; i < 150; i++) {
          ready =
            fault === 'stop-before-result'
              ? await runInDurableObject(
                  stub,
                  (_, state) =>
                    !!state.storage.sql
                      .exec("SELECT key FROM test_mcp WHERE key='result-paused'")
                      .toArray().length,
                )
              : mutations === 1;
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(ready).toBe(true);
        await stub.stopConversation();
      }
      const snapshot = await settled();
      expect(mutations).toBe(1);
      if (!fault.startsWith('stop-'))
        expect(JSON.stringify(snapshot.entries)).toContain('remote_outcome_unknown');
      expect(snapshot.remote).toEqual([]); // Generic MCP does not invent the async-job retry UI.
      const intents = await runInDurableObject(
        stub,
        async (instance) =>
          (
            await (
              await instance.harness.pi()
            ).snapshot(RemoteIntents, (await instance.root()).id, BG)
          )?.mcp,
      );
      expect(Object.values(intents ?? {})).toMatchObject([
        {
          status:
            fault === 'stop-during-call'
              ? 'dispatching'
              : fault === 'stop-before-result'
                ? 'responded'
                : 'unknown',
        },
      ]);
      const id = stub.id;
      await abortAllDurableObjects();
      stub = env.CONVERSATIONS.get(id);
      await stub.submitRun({
        runId: crypto.randomUUID(),
        text: 'mcp unsafe retry after reconstruction',
      });
      await settled();
      expect(mutations).toBe(1);
      // A safe capability remains usable; ordinary new messages don't authorize another mutation.
      await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp safe status' });
      expect(JSON.stringify((await settled()).entries)).toContain('original operation status');
      expect(reads).toBe(1);
      expect(mutations).toBe(1);
    } finally {
      await abortAllDurableObjects();
      network.mockRestore();
    }
  },
);

it('SDK 0.28 Streamable HTTP discovery, Pi calls and pinned schemas survive reconstruction', async () => {
  let changed = false,
    calls = 0;
  const authorization: (string | null)[] = [];
  const fullResult = 'found\n' + ('x'.repeat(32) + '\n').repeat(2500);
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://mcp.example.test/mcp') return new Response(null, { status: 404 });
    authorization.push(request.headers.get('Authorization'));
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = (await request.json()) as any;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'controlled-fixture', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'lookup',
            description: 'Lookup',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: changed ? [] : ['query'],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      calls++;
      result = { content: [{ type: 'text', text: fullResult }], structuredContent: { value: 2 } };
    } else result = {};
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  });
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  try {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE test_mcp (key TEXT)');
      state.storage.sql.exec("INSERT INTO test_mcp VALUES ('credential-probe')");
    });
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp lookup' });
    for (let i = 0; i < 100; i++) {
      if (!JSON.parse(await stub.snapshot()).pending.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const before = JSON.parse(await stub.snapshot());
    expect(before.capabilityIssues, 'HTTP requests: ' + network.mock.calls.length).toEqual([]);
    expect(
      await runInDurableObject(stub, (instance) => {
        const transport = instance.mcp.mcpConnections.reference.options.transport;
        return 'fetch' in transport ? typeof transport.fetch : 'undefined';
      }),
    ).toBe('function');
    expect(JSON.stringify(before.entries)).toContain('found');
    const result = before.entries
      .flatMap((entry: any) => entry.model ?? [])
      .find(
        (message: any) =>
          message.role === 'toolResult' && message.toolName === 'mcp_reference_lookup',
      );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(fullResult);
    expect(result.content[1].text).toBe(JSON.stringify({ value: 2 }));
    expect(calls).toBe(1);
    expect(authorization.length).toBeGreaterThan(0);
    expect(authorization.every((header) => header === 'Bearer mcp-fixture-secret')).toBe(true);
    expect(
      await runInDurableObject(stub, (instance) => JSON.stringify(instance.mcp.listServers())),
    ).not.toContain('mcp-fixture-secret');
    expect(JSON.stringify(before)).not.toContain('mcp-fixture-secret');
    await abortAllDurableObjects();
    authorization.length = 0;
    stub = env.CONVERSATIONS.get(stub.id);
    expect(JSON.parse(await stub.snapshot()).capabilityIssues).toEqual([]);
    expect(authorization.length).toBeGreaterThan(0);
    expect(authorization.every((header) => header === 'Bearer mcp-fixture-secret')).toBe(true);
    expect(
      await runInDurableObject(stub, (instance) => JSON.stringify(instance.mcp.listServers())),
    ).not.toContain('mcp-fixture-secret');
    expect(calls).toBe(1);
    changed = true;
    await runInDurableObject(stub, async (instance) => {
      // Refresh the actual SDK catalog in this test; production calls use its existing cache.
      expect((await instance.mcp.discoverIfConnected('reference'))?.success).toBe(true);
    });
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp lookup live change' });
    for (let i = 0; i < 100; i++) {
      if (!JSON.parse(await stub.snapshot()).pending.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(await stub.snapshot()).capabilityIssues).toContainEqual(
      expect.objectContaining({ code: 'mcp_definition_changed' }),
    );
    expect(calls).toBe(1);
    await runInDurableObject(stub, async (instance, state) => {
      // The SDK itself encodes a prior deployment's credential in its persisted row.
      state.storage.sql.exec("DELETE FROM test_mcp WHERE key='credential-probe'");
      await instance.mcp.registerServer('reference', {
        url: 'https://mcp.example.test/mcp',
        name: 'reference',
        transport: {
          type: 'streamable-http',
          requestInit: { headers: { Authorization: 'Bearer fixture-retired' } },
        },
      });
    });
    await abortAllDurableObjects();
    authorization.length = 0;
    stub = env.CONVERSATIONS.get(stub.id);
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp lookup again' });
    for (let i = 0; i < 100; i++) {
      if (!JSON.parse(await stub.snapshot()).pending.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(JSON.parse(await stub.snapshot()).capabilityIssues).toContainEqual(
      expect.objectContaining({ code: 'mcp_definition_changed' }),
    );
    expect(calls).toBe(1);
    expect(authorization.length).toBeGreaterThan(0);
    expect(authorization.every((header) => header === null)).toBe(true);
    expect(
      await runInDurableObject(stub, (instance) => {
        const transport = instance.mcp.mcpConnections.reference.options.transport;
        return 'fetch' in transport ? typeof transport.fetch : 'undefined';
      }),
    ).toBe('function');
    // Deployment configuration is now empty; the native SDK still has a persisted row.
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('DROP TABLE test_mcp');
    });
    await abortAllDurableObjects();
    network.mockClear();
    stub = env.CONVERSATIONS.get(stub.id);
    const disabled = JSON.parse(await stub.snapshot());
    expect(
      disabled.entries
        .flatMap((entry: any) => entry.model ?? [])
        .find((message: any) => message.role === 'toolResult' && !message.isError).content[0].text,
    ).toBe(fullResult);
    expect(
      await runInDurableObject(stub, (instance) => Object.keys(instance.mcp.mcpConnections)),
    ).toEqual([]);
    expect(disabled.capabilityIssues).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('a temporary outage on reconstruction recovers on a later call with the same accepted definition', async () => {
  let offline = false,
    calls = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (offline) throw new Error('fixture offline');
    const request = new Request(input, init);
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = (await request.json()) as any;
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'outage-fixture', version: '1' },
          }
        : rpc.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'lookup',
                  description: 'Lookup',
                  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                },
              ],
            }
          : rpc.method === 'tools/call'
            ? { content: [{ type: 'text', text: `fixture result ${++calls}` }] }
            : {};
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  });
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const settle = async () => {
    for (let i = 0; i < 150; i++) {
      if (!JSON.parse(await stub.snapshot()).pending.length) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('MCP fixture did not settle');
  };
  try {
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('CREATE TABLE test_mcp (key TEXT)');
    });
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp lookup initial' });
    await settle();
    expect(calls).toBe(1);
    await abortAllDurableObjects();
    offline = true;
    stub = env.CONVERSATIONS.get(stub.id);
    expect(JSON.parse(await stub.snapshot()).capabilityIssues).toContainEqual(
      expect.objectContaining({ code: 'mcp_connection_failed' }),
    );
    offline = false;
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'mcp lookup recovered' });
    await settle();
    const recovered = JSON.parse(await stub.snapshot());
    expect(calls).toBe(2);
    expect(JSON.stringify(recovered.entries)).toContain('fixture result 2');
    expect(recovered.capabilityIssues).toEqual([]);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});
