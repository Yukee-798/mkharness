import { extensionConfiguration } from '../../src/extensions/configuration';
import * as activation from '../../src/extensions/server';
import { afterEach, expect, it, vi } from 'vitest';
import { collectContributions } from '../../src/server/extensions/contributions';
import { loadBrowserExtensions } from '../../src/browser/extensions/extensions';
import { definitions, extensionIds } from '../../src/extensions/server';
import { applicationContributions } from '../../src/server/extensions/assembly';
afterEach(() => vi.restoreAllMocks());

it('uses the supplied custom MCP setting instead of the deployment default', async () => {
  const first = vi.fn(async () => ({ owner: 'owner', bindings: '[]' }));
  const prepare = vi.fn(() => ({ bind: () => ({ first }) }));
  const env = { DB: { prepare } } as unknown as Env;
  const host = { identity: 'chat', conversationId: 'chat', pi: vi.fn(), command: vi.fn() };
  for (const custom of [false, true]) {
    prepare.mockClear();
    await applicationContributions(env, async () => [], host, {
      mcp: { enabled: true, custom },
    });
    expect(prepare).toHaveBeenCalledTimes(custom ? 1 : 0);
  }
  expect(() => activation.extensionIds({ mcp: { enabled: true, custom: 'yes' } } as any)).toThrow(
    'invalid_extension_configuration',
  );
  expect(() => activation.extensionIds({ openui: { enabled: true, inspect: 1 } } as any)).toThrow(
    'invalid_extension_configuration',
  );
});

it('rejects a factory identity that disagrees with the static activation namespace', async () => {
  vi.spyOn(definitions[0]!, 'create').mockResolvedValue({ id: 'different-id' });
  await expect(
    applicationContributions({} as Env, async () => [], undefined, {
      ...extensionConfiguration,
      openui: { enabled: false },
    }),
  ).rejects.toMatchObject({ code: 'extension_identity_mismatch' });
});
it('validates advertised static IDs without executing any factory', () => {
  const factory = vi.spyOn(definitions[0]!, 'create');
  const original = definitions[1]!.id;
  try {
    definitions[1]!.id = definitions[0]!.id;
    expect(() => extensionIds()).toThrow('duplicate');
    expect(factory).not.toHaveBeenCalled();
  } finally {
    definitions[1]!.id = original;
  }
});

it('rejects duplicate IDs and native tool names before installation', () => {
  expect(() => collectContributions([{ id: 'x' }, { id: 'x' }])).toThrow('duplicate');
  expect(() =>
    collectContributions([
      { id: 'a', extension: { name: 'a', tools: [{ name: 'shared' }] } },
      { id: 'b', extension: { name: 'b', tools: [{ name: 'shared' }] } },
    ] as any),
  ).toThrow('duplicate');
});
it('loads only reviewed browser IDs and isolates failed optional modules', async () => {
  const known = vi.fn(async () => ({ toolkit: {} }));
  const broken = vi.fn(async () => {
    throw new Error('offline');
  });
  const result = await loadBrowserExtensions(['known', 'missing', 'broken'], { known, broken });
  expect(known).toHaveBeenCalledTimes(1);
  expect(result.modules).toHaveLength(1);
  expect(result.unavailable).toEqual(['missing', 'broken']);
});
it('downloads extensions concurrently but resolves conflicts in declared order', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const toolkit = { duplicate: { type: 'backend' as const, render: () => null } };
  const first = vi.fn(async () => {
    await held;
    return { toolkit };
  });
  const second = vi.fn(async () => ({ toolkit }));
  const loading = loadBrowserExtensions(['first', 'second', 'first'], { first, second });
  try {
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  } finally {
    release();
  }
  const result = await loading;
  expect(result.modules.map((module) => module.id)).toEqual(['first']);
  expect(result.unavailable).toEqual(['second']);
});
it('rejects incomplete host handlers and conflicting browser tool registrations', async () => {
  expect(() => collectContributions([{ id: 'broken', resources: {} }] as any)).toThrow('invalid');
  expect(() => collectContributions([{ id: 'broken', controls: { decide: {} } }] as any)).toThrow(
    'invalid',
  );
  expect(() => collectContributions([{ id: 'broken', actions: { choose: {} } }] as any)).toThrow(
    'invalid',
  );
  const result = await loadBrowserExtensions(['first', 'second'], {
    first: async () => ({ toolkit: { duplicate: { type: 'backend', render: () => null } } }),
    second: async () => ({ toolkit: { duplicate: { type: 'backend', render: () => null } } }),
  });
  expect(result.unavailable).toEqual(['second']);
  expect(result.modules).toHaveLength(1);
});

it('removing the async definition removes tools, actions, guards and document projections together', async () => {
  const env = {
    ASYNC_SERVICE_URL: 'https://async.example.test',
  } as unknown as Env;
  const host = { identity: 'chat', pi: vi.fn(), command: vi.fn() };
  const config = { ...extensionConfiguration, openui: { enabled: false } };
  const installed = await applicationContributions(env, async () => [], host, config);
  const example = installed.find((item) => item.id === 'async-example')!;
  expect(example.extension?.tools?.map((tool) => tool.name)).toEqual([
    'example_generate',
    'example_recheck',
  ]);
  expect(example.extension?.tasks?.[0]?.definition.name).toBe('app.remote-example');
  expect(Object.keys(example.actions!)).toEqual(['retry', 'recheck']);
  expect(Object.keys(example.execution!)).toEqual([
    'beforeModel',
    'beforeSubmit',
    'taskUnavailable',
  ]);
  expect(example.stateDocuments?.[0]?.definition.kind).toBe('app.remote-intents');
  const remaining = activation
    .enabledDefinitions(config)
    .filter((item) => item.id !== 'async-example');
  vi.spyOn(activation, 'enabledDefinitions').mockReturnValue(remaining);
  const removed = await applicationContributions(env, async () => [], host, config);
  expect(removed.map((item) => item.id)).not.toContain('async-example');
  expect(
    removed.flatMap((item) => item.extension?.tools ?? []).map((tool) => tool.name),
  ).not.toContain('example_generate');
  expect(host.pi).not.toHaveBeenCalled();
});

it('one configuration controls every registered contribution without running disabled factories', async () => {
  const config = Object.fromEntries(
    Object.keys(extensionConfiguration).map((id) => [
      id,
      { enabled: id === 'reply' || id === 'example' },
    ]),
  );
  const factories = definitions
    .filter((definition) => !config[definition.id]?.enabled)
    .map((definition) => vi.spyOn(definition, 'create'));
  expect(extensionIds(config)).toEqual(['reply', 'example']);
  const contributions = await applicationContributions(
    {} as Env,
    async () => [],
    undefined,
    config,
  );
  expect(contributions.map((item) => item.id)).toEqual(['reply', 'example']);
  for (const factory of factories) expect(factory).not.toHaveBeenCalled();
  expect(() => extensionIds({ ...config, typo: { enabled: true } })).toThrow(
    'unknown_extension_configuration',
  );
});
