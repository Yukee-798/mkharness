import { expect, it, vi, beforeEach } from 'vitest';
vi.mock('vite', () => ({ createServer: vi.fn(), isRunnableDevEnvironment: () => true }));
import { createServer } from 'vite';
import { openuiBuild } from '../../src/extensions/openui/build';
const close = vi.fn(),
  load = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  load.mockResolvedValue({
    library: {
      toJSONSchema: () => ({ components: 'schema' }),
      toSpec: () => ({ components: 'spec' }),
    },
  });
  vi.mocked(createServer).mockResolvedValue({
    environments: { ssr: { runner: { import: load } } },
    close,
  } as any);
});
function hooks(enabled = true) {
  const plugin = openuiBuild({ enabled });
  return {
    plugin,
    start: plugin.configureServer as () => Promise<void>,
    read: plugin.load as (
      this: { addWatchFile: (file: string) => void },
      source: string,
    ) => Promise<string>,
  };
}
it('prepares before startup resolves, and every load reuses the same cached generation', async () => {
  const { start, read } = hooks();
  await start();
  expect(load).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  const context = { addWatchFile: vi.fn() };
  const [first, second] = await Promise.all([
    read.call(context, '\0virtual:mkharness-openui-catalog'),
    read.call(context, '\0virtual:mkharness-openui-catalog'),
  ]);
  expect(first).toEqual(second);
  expect(first).toContain('export const schema');
  expect(load).toHaveBeenCalledOnce();
});
it('does not evaluate disabled OpenUI during startup', async () => {
  await hooks(false).start();
  expect(createServer).not.toHaveBeenCalled();
});
it('reports invalid catalog preparation at startup and closes the temporary loader', async () => {
  load.mockRejectedValueOnce(new Error('invalid catalog'));
  await expect(hooks().start()).rejects.toThrow('invalid catalog');
  expect(close).toHaveBeenCalledOnce();
});
it('invalidates prepared metadata after a component change and shares the next generation', async () => {
  const { plugin, start, read } = hooks();
  await start();
  const module = {};
  const invalidateModule = vi.fn();
  const update = plugin.hotUpdate as (this: unknown, context: unknown) => unknown;
  update.call(
    { environment: { moduleGraph: { getModuleById: () => module, invalidateModule } } },
    {
      file: new URL('../../src/extensions/openui/catalog.tsx', import.meta.url).pathname,
      modules: [],
    },
  );
  expect(invalidateModule).toHaveBeenCalledWith(module);
  await Promise.all([
    read.call({ addWatchFile: vi.fn() }, '\0virtual:mkharness-openui-catalog'),
    read.call({ addWatchFile: vi.fn() }, '\0virtual:mkharness-openui-catalog'),
  ]);
  expect(load).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});
