import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';

it('SDK 0.28 Streamable HTTP discovery, Pi calls and pinned schemas survive reconstruction', async () => {
  let changed = false,
    calls = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://mcp.example.test/mcp') return new Response(null, { status: 404 });
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
      result = { content: [{ type: 'text', text: 'found' }], structuredContent: { value: 2 } };
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
    expect(JSON.stringify(before.entries)).toContain('found');
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
    await abortAllDurableObjects();
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
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});
