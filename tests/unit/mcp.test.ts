import { expect, it, vi } from 'vitest';
import { MCPClientManager } from 'agents/mcp/client';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { buildMcp, configureMcpStartup, mcpConfiguration } from '../../src/server/mcp';
const configs = [
  { serverId: 'reference', endpoint: 'https://mcp.example.test/mcp', allowlist: ['lookup'] },
];
const schema = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1 } },
  required: ['query'],
  additionalProperties: false,
};
function manager(
  inputSchema: unknown = schema,
  result: unknown = { content: [{ type: 'text', text: 'found' }], structuredContent: { value: 2 } },
) {
  const connection = { connectionState: 'connecting' };
  return {
    mcpConnections: { reference: connection },
    registerServer: async () => 'reference',
    connectToServer: async () => {
      connection.connectionState = 'connected';
      return { state: 'connected' };
    },
    discoverIfConnected: async () => {
      connection.connectionState = 'ready';
      return { success: true };
    },
    listTools: () => [
      { serverId: 'reference', name: 'lookup', description: 'Lookup', inputSchema },
    ],
    callTool: async () => result,
  } as any;
}
it('registers the real schema and preserves JSON results and isError through Pi', async () => {
  const built = await buildMcp(manager(), configs, {}, undefined);
  const tool = built.extension.tools![0];
  expect(tool.replay).toBe('unsafe');
  expect(() =>
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'c',
      name: tool.name,
      arguments: { query: '' },
    }),
  ).toThrow();
  const result = await tool.execute(
    { query: 'hi' },
    { signal: new AbortController().signal } as any,
    {} as any,
  );
  expect(JSON.stringify(result)).toContain('value');
  const failed = await buildMcp(
    manager(schema, { content: [], isError: true }),
    configs,
    {},
    undefined,
  );
  expect(
    await failed.extension.tools![0].execute(
      { query: 'hi' },
      { signal: new AbortController().signal } as any,
      {} as any,
    ),
  ).toMatchObject({ isError: true });
});

it('rechecks a recovered connection against the pinned definition instead of latching an outage', async () => {
  const initial = await buildMcp(manager(), configs, {});
  const live = manager();
  const connect = live.connectToServer;
  let offline = true;
  live.connectToServer = async () => {
    if (offline) throw new Error('offline');
    return connect();
  };
  const built = await buildMcp(live, configs, {}, initial.bindings);
  expect(
    JSON.stringify(await built.extension.tools![0].execute({}, {} as any, {} as any)),
  ).toContain('mcp_connection_failed');
  offline = false;
  const result = await built.extension.tools![0].execute({ query: 'hi' }, {} as any, {} as any);
  expect(result.isError).toBe(false);
  expect(JSON.stringify(result)).toContain('found');
  expect(built.diagnostics).toEqual([]);
  expect(built.bindings).toEqual(initial.bindings);
});

it('uses current deployment transports before native SDK restore and removes disabled servers', async () => {
  type Row = ReturnType<MCPClientManager['listServers']>[number];
  const rows = new Map<string, Row>();
  const makeManager = () => {
    const native = new MCPClientManager('fixture', '1');
    const storage = native as unknown as {
      getServersFromStorage(): Row[];
      getStoredServerOptions(id: string): unknown;
      saveServerToStorage(row: Row): void;
      removeServerFromStorage(id: string): void;
    };
    // Store the SDK's own encoded rows, rather than reimplementing its transport codec.
    vi.spyOn(storage, 'getServersFromStorage').mockImplementation(() => [...rows.values()]);
    vi.spyOn(storage, 'getStoredServerOptions').mockImplementation((id) => {
      const text = rows.get(id)?.server_options;
      return text ? JSON.parse(text) : undefined;
    });
    vi.spyOn(storage, 'saveServerToStorage').mockImplementation((row) => {
      rows.set(row.id, row as Row);
    });
    vi.spyOn(storage, 'removeServerFromStorage').mockImplementation((id) => {
      rows.delete(id);
    });
    return native;
  };
  const original = makeManager();
  for (const id of ['reference', 'removed'])
    await original.registerServer(id, {
      url: 'https://mcp.example.test/mcp',
      name: id,
      transport: {
        type: 'streamable-http',
        requestInit: { headers: { Authorization: 'Bearer fixture-old' } },
        fetch: async () => new Response(),
      },
    });
  expect(JSON.parse(rows.get('reference')!.server_options!).transport.fetch).toBeUndefined();
  const restored = makeManager();
  const connected = vi.spyOn(restored, 'connectToServer');
  configureMcpStartup(restored, () => [{ ...configs[0], credential: 'FIXTURE_TOKEN' }], {
    FIXTURE_TOKEN: 'fixture-current',
  });
  await restored.restoreConnectionsFromStorage('fixture');
  expect(connected).not.toHaveBeenCalled();
  expect(rows.has('removed')).toBe(false);
  expect(restored.mcpConnections.removed).toBeUndefined();
  const transport = restored.mcpConnections.reference.options.transport as {
    requestInit?: RequestInit;
    fetch?: typeof fetch;
  };
  expect(transport.requestInit?.headers).toEqual({ Authorization: 'Bearer fixture-current' });
  expect(transport.fetch).toBeTypeOf('function');
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  try {
    const response = await transport.fetch!('https://mcp.example.test/mcp', transport.requestInit);
    await expect(response.text()).rejects.toThrow('mcp_result_too_large');
    expect(network).toHaveBeenCalledWith(
      'https://mcp.example.test/mcp',
      expect.objectContaining({
        redirect: 'manual',
        headers: { Authorization: 'Bearer fixture-current' },
        signal: expect.any(AbortSignal),
      }),
    );
  } finally {
    network.mockRestore();
  }
});
it('pins definitions and refuses silent schema replacement, redirection and unsupported blocks', async () => {
  const initial = await buildMcp(manager(), configs, {}, undefined);
  const changed = await buildMcp(
    manager({ ...schema, required: [] }),
    configs,
    {},
    initial.bindings,
  );
  const result = await changed.extension.tools![0].execute(
    { query: 'hi' },
    { signal: new AbortController().signal } as any,
    {} as any,
  );
  expect(JSON.stringify(result)).toContain('mcp_definition_changed');
  expect(changed.bindings).toEqual(initial.bindings);
  const redirected = await buildMcp(
    manager(),
    [{ ...configs[0], endpoint: 'https://other.example.test/mcp' }],
    {},
    initial.bindings,
  );
  expect(redirected.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'mcp_definition_changed' }),
  );
  const unsupported = await buildMcp(
    manager(schema, { content: [{ type: 'resource_link', uri: 'https://private.invalid' }] }),
    configs,
    {},
    undefined,
  );
  expect(
    JSON.stringify(
      await unsupported.extension.tools![0].execute(
        { query: 'hi' },
        { signal: new AbortController().signal } as any,
        {} as any,
      ),
    ),
  ).toContain('mcp_unsupported_content');
});
it('validates endpoint, names and credentials before admission', () => {
  expect(() =>
    mcpConfiguration({
      MCP_SERVERS: '[{"serverId":"bad","endpoint":"http://localhost","allowlist":[]}]',
    }),
  ).toThrow();
  expect(() =>
    mcpConfiguration({
      MCP_SERVERS: JSON.stringify([{ ...configs[0], credential: 'MISSING_SECRET' }]),
    }),
  ).toThrow('mcp_credential_missing');
});

it('keeps pinned tools unavailable on disconnect and rejects oversized output', async () => {
  const initial = await buildMcp(manager(), configs, {}, undefined);
  const offline = await buildMcp(
    {
      ...manager(),
      connectToServer: async () => {
        throw new Error('offline');
      },
    },
    configs,
    {},
    initial.bindings,
  );
  expect(offline.extension.tools).toHaveLength(1);
  expect(
    JSON.stringify(await offline.extension.tools![0].execute({}, {} as any, {} as any)),
  ).toContain('mcp_connection_failed');
  const large = await buildMcp(
    manager(schema, { content: [{ type: 'text', text: 'x'.repeat(1048577) }] }),
    configs,
    {},
    undefined,
  );
  expect(
    JSON.stringify(await large.extension.tools![0].execute({}, {} as any, {} as any)),
  ).toContain('mcp_result_too_large');
  const unsupported = await buildMcp(
    manager({ type: 'object', properties: { ref: { $ref: '#/bad' } } }),
    configs,
    {},
    undefined,
  );
  expect(unsupported.extension.tools).toHaveLength(0);
  expect(unsupported.diagnostics[0].code).toBe('mcp_schema_unsupported');
});
it('disables malformed schemas and overlong mapped names instead of weakening the tool', async () => {
  for (const inputSchema of [
    { ...schema, required: 'query' },
    { ...schema, additionalProperties: 'yes' },
    { ...schema, properties: { query: { type: 'string', minLength: '1' } } },
  ]) {
    const built = await buildMcp(manager(inputSchema), configs, {});
    expect(built.extension.tools).toHaveLength(0);
    expect(built.diagnostics[0].code).toBe('mcp_schema_unsupported');
  }
  const built = await buildMcp(manager(), [{ ...configs[0], serverId: 'a'.repeat(32) }], {});
  // Long remote names must not be truncated into an ambiguous mapping.
  const longManager = {
    ...manager(),
    listTools: () => [{ name: 't'.repeat(64), inputSchema: schema }],
  };
  const long = await buildMcp(
    longManager as any,
    [{ ...configs[0], serverId: 'a'.repeat(32), allowlist: ['t'.repeat(64)] }],
    {},
  );
  expect(built.extension.tools![0].name.length).toBeLessThanOrEqual(64);
  expect(long.extension.tools).toHaveLength(0);
  expect(long.diagnostics[0].code).toBe('mcp_name_invalid');
});

it('refuses live catalog changes before calling and keeps an independent accepted definition', async () => {
  for (const change of ['schema', 'description', 'removed', 'in-place'] as const) {
    let tools = [{ name: 'lookup', description: 'Lookup', inputSchema: structuredClone(schema) }];
    let calls = 0;
    const live = {
      ...manager(),
      listTools: () => tools,
      callTool: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'must not call changed definition' }] };
      },
    };
    const built = await buildMcp(live as any, configs, {});
    if (change === 'schema') tools = [{ ...tools[0], inputSchema: { ...schema, required: [] } }];
    if (change === 'description') tools = [{ ...tools[0], description: 'Changed meaning' }];
    if (change === 'removed') tools = [];
    if (change === 'in-place') tools[0].inputSchema.required.length = 0;
    expect(built.bindings[0].schema, change).toEqual(schema);
    for (let i = 0; i < 2; i++) {
      const result = await built.extension.tools![0].execute({ query: 'hi' }, {} as any, {} as any);
      expect(JSON.stringify(result), change).toContain('mcp_definition_changed');
    }
    expect(calls, change).toBe(0);
    expect(built.diagnostics).toEqual([
      { serverId: 'reference', toolName: 'lookup', code: 'mcp_definition_changed' },
    ]);
  }
});
