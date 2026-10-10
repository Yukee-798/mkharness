import { expect, it } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import { buildMcp, mcpConfiguration } from '../../src/server/mcp';
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
  return {
    registerServer: async () => 'reference',
    connectToServer: async () => ({ state: 'connected' }),
    discoverIfConnected: async () => ({ success: true }),
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
