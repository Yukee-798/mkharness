import { expect, it, vi } from 'vitest';
import { collectContributions } from '../../src/server/contributions';
import { loadBrowserExtensions } from '../../src/browser/extensions';

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
