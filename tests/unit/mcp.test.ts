import { expect, it, vi } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import {
  buildMcp,
  freezeDeploymentBindings,
  mcpConfiguration,
  type MCPBinding,
} from '../../src/server/mcp/deployment';
import { connectionKey, operationId, deploymentRevision } from '../../src/server/mcp/configuration';
import { userMcpContribution } from '../../src/extensions/mcp/server';
import { convertResult, schemaAccepted } from '../../src/server/mcp/connections/protocol';
const config = {
  serverId: 'reference',
  endpoint: 'https://mcp.example.test/mcp',
  allowlist: ['lookup'],
  safeTools: [],
};
const schema = {
  type: 'object',
  properties: { query: { type: 'string', minLength: 1 } },
  required: ['query'],
  additionalProperties: false,
};
const binding: MCPBinding = {
  serverId: 'reference',
  endpoint: config.endpoint,
  configurationRevision: 'revision',
  hash: 'hash',
  remoteName: 'lookup',
  name: 'mcp_reference_lookup',
  schema,
  description: 'Lookup',
  replay: 'unsafe',
};

it('constructs an immutable native extension from frozen metadata without network or secrets', () => {
  const getByName = vi.fn();
  const source = structuredClone(binding);
  const built = buildMcp(
    { MCP_CONNECTIONS: { getByName } } as unknown as Env,
    { ownerId: 'owner', chatId: 'chat' },
    [config],
    [source],
  );
  source.schema.required = [];
  expect(getByName).not.toHaveBeenCalled();
  expect(built.bindings[0].schema).toEqual(schema);
  expect(built.extension.tools![0].replay).toBe('safe'); // Replays a durable child receipt.
  expect(() =>
    validateToolArguments(built.extension.tools![0], {
      type: 'toolCall',
      id: 'c',
      name: binding.name,
      arguments: { query: '' },
    }),
  ).toThrow();
});
it('discovers deployment metadata through the owner-scoped independent connection', async () => {
  const metadata = vi.fn(async () =>
    JSON.stringify({
      id: 'reference',
      configurationRevision: 'r1',
      tools: [{ name: 'lookup', schema, hash: 'h1', description: 'Lookup', supported: true }],
    }),
  );
  const getByName = vi.fn(() => ({ deploymentMetadata: metadata }));
  const bindings = await freezeDeploymentBindings(
    { MCP_CONNECTIONS: { getByName } } as unknown as Env,
    'owner',
    [config],
  );
  expect(getByName).toHaveBeenCalledWith('deployment:owner:reference');
  expect(metadata).toHaveBeenCalledWith('owner', 'reference');
  expect(bindings).toMatchObject([{ configurationRevision: 'r1', hash: 'h1', replay: 'unsafe' }]);
});
it('keeps connection identity stable across configuration revisions and invocation identity distinct across chats and branches', () => {
  expect(connectionKey({ kind: 'user', ownerId: 'owner', connectionId: 'connection' })).toBe(
    'user:owner:connection',
  );
  const scope = { kind: 'deployment' as const, ownerId: 'owner', serverId: 'reference' };
  expect(connectionKey({ ...scope, configurationRevision: 'one' })).toBe(
    connectionKey({ ...scope, configurationRevision: 'two' }),
  );
  expect(
    new Set([operationId('chat', 1, 5), operationId('chat', 2, 5), operationId('other-chat', 1, 5)])
      .size,
  ).toBe(3);
});
it('validates deployment policy locally and resolves credential presence only when a connection is used', async () => {
  for (const endpoint of [
    'http://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://private.internal/mcp',
    'https://mcp.example.test/mcp?token=secret',
  ])
    expect(() =>
      mcpConfiguration({ MCP_SERVERS: JSON.stringify([{ ...config, endpoint }]) }),
    ).toThrow();
  const [parsed] = mcpConfiguration({
    MCP_SERVERS: JSON.stringify([{ ...config, credential: 'MISSING_SECRET' }]),
  });
  await expect(deploymentRevision(parsed, {})).rejects.toThrow('mcp_credential_missing');
  const current = await deploymentRevision(parsed, { MISSING_SECRET: 'first' });
  expect(await deploymentRevision(parsed, { MISSING_SECRET: 'rotated' })).not.toBe(current);
});
it('retains accepted schema validation including unrestricted native Notion properties', () => {
  const notion = {
    ...schema,
    additionalProperties: {},
    properties: {
      query: { type: 'string', minLength: 1 },
      filters: { type: 'object', additionalProperties: {} },
    },
  };
  expect(schemaAccepted(notion)).toBe(true);
  for (const invalid of [
    { ...schema, required: 'query' },
    { ...schema, additionalProperties: 'yes' },
    { ...schema, properties: { query: { $ref: '#/bad' } } },
  ])
    expect(schemaAccepted(invalid)).toBe(false);
});
it('bounds converted responses and rejects unsupported external content', () => {
  expect(
    convertResult({
      content: [{ type: 'text', text: 'found' }],
      structuredContent: { value: 2 },
      isError: true,
    }),
  ).toMatchObject({
    isError: true,
    output: [
      { type: 'text', text: 'found' },
      { type: 'text', text: '{"value":2}' },
    ],
  });
  expect(() =>
    convertResult({ content: [{ type: 'resource_link', uri: 'https://example.test/result' }] }),
  ).toThrow('mcp_unsupported_content');
  expect(() => convertResult({ content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] })).toThrow(
    'JSON size limit exceeded',
  );
});

it('customMcp=false closes only the user contribution and leaves deployment tools available', async () => {
  const host = {
    identity: 'chat',
    conversationId: 'chat',
    ownerId: 'owner',
    nativeConversationId: 1,
    mcpBindings: [],
    pi: vi.fn(),
    command: async () => undefined,
  };
  expect(
    await userMcpContribution({} as Env, host, { mcp: { enabled: true, custom: false } }),
  ).toEqual({ id: 'mcp' });
  expect(
    buildMcp({} as Env, { ownerId: 'owner', chatId: 'chat' }, [config], [binding]).extension.tools,
  ).toHaveLength(1);
});
