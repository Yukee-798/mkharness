import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

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
    await runInDurableObject(stub, async (instance) => {
      // The SDK itself encodes a prior deployment's credential in its persisted row.
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
