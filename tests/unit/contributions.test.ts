import { afterEach, expect, it, vi } from 'vitest';
import { collectContributions } from '../../src/server/contributions';
import { loadBrowserExtensions } from '../../src/browser/extensions';
import { definitions, extensionIds } from '../../src/extensions/server';
import { applicationContributions } from '../../src/server/assembly';
afterEach(() => vi.restoreAllMocks());

it('rejects a factory identity that disagrees with the static activation namespace', async () => {
  vi.spyOn(definitions[0]!, 'create').mockResolvedValue({ id: 'different-id' });
  await expect(
    applicationContributions({ ENABLE_GENERATIVE_UI: '0' } as unknown as Env, async () => []),
  ).rejects.toMatchObject({ code: 'extension_identity_mismatch' });
});
it('validates advertised static IDs without executing any factory', () => {
  const factory = vi.spyOn(definitions[0]!, 'create');
  const original = definitions[1]!.id;
  try {
    definitions[1]!.id = definitions[0]!.id;
    expect(() => extensionIds({} as Env)).toThrow('duplicate');
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
it('rejects incomplete host handlers and conflicting browser tool registrations', async () => {
  expect(() => collectContributions([{ id: 'broken', resources: {} }] as any)).toThrow('invalid');
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
