import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ChatRuntime } from '../../src/server/chat/runtime';
import { BG } from '../../src/server/chat/context';
import { fixtureModels } from '../fixture-model';
import { Harness } from '@earendil-works/pi-durable';
import type { StorageProbe } from './entry';
const probes = (env as unknown as { STORAGE_PROBES: DurableObjectNamespace<StorageProbe> })
  .STORAGE_PROBES;
it('opens one paused native runtime and seals it after close', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const runtime = new ChatRuntime(state),
      restore = vi.fn(async () => {});
    const options = { models: fixtureModels(), extensions: [], restore, committed: () => {} };
    const opened = await Promise.all(Array.from({ length: 8 }, () => runtime.open(options)));
    expect(new Set(opened).size).toBe(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect((await opened[0]!.inspect(BG)).tasks).toEqual([]);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(await opened[0]!.closed).toMatchObject({ reason: 'closed' });
    await expect(runtime.open(options)).rejects.toThrow('Runtime is closed');
  });
});
it('native storage failure closes before eviction and never reopens a failed runtime in place', async () => {
  await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
    const abort = vi.fn();
    const waits: Promise<unknown>[] = [];
    const host = {
      storage: state.storage,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      abort,
    } as unknown as DurableObjectState;
    const runtime = new ChatRuntime(host),
      options = {
        models: fixtureModels(),
        extensions: [],
        restore: async () => {},
        committed: () => {},
      };
    const pi = await runtime.open(options);
    const root = await pi.root(BG);
    const before = await runtime.index.revision();
    await runtime.database.exec(
      "CREATE TRIGGER fail_locator BEFORE UPDATE ON app_read_meta BEGIN SELECT RAISE(ABORT,'storage_failure'); END;",
    );
    await expect(
      root.submit({ type: 'write', entry: { kind: 'test.record', data: 'must rollback' } }, BG),
    ).rejects.toThrow('storage_failure');
    expect(await pi.closed).toMatchObject({ reason: 'failed' });
    await Promise.all(waits);
    expect(abort).toHaveBeenCalledTimes(1);
    await expect(runtime.open(options)).rejects.toThrow('Runtime is closed');
    expect(await runtime.index.revision()).toBe(before);
  });
});
it.each(['restore', 'harness'] as const)(
  'drains storage before evicting a failed %s factory and permits close cleanup',
  async (phase) => {
    await runInDurableObject(probes.get(probes.newUniqueId()), async (_instance, state) => {
      const order: string[] = [],
        waits: Promise<unknown>[] = [];
      const abort = vi.fn(() => {
        order.push('abort');
      });
      const host = {
        storage: state.storage,
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        abort,
      } as unknown as DurableObjectState;
      const runtime = new ChatRuntime(host),
        failure = new Error('initialization failure');
      let release!: () => void,
        entered = false;
      const drain = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restore = vi.fn(async () => {
        const close = runtime.database.close.bind(runtime.database);
        vi.spyOn(runtime.database, 'close').mockImplementation(async () => {
          entered = true;
          order.push('close');
          await drain;
          await close();
          order.push('drained');
        });
        if (phase === 'restore') throw failure;
      });
      const openSpy =
        phase === 'harness' ? vi.spyOn(Harness, 'open').mockRejectedValueOnce(failure) : undefined;
      try {
        const options = { models: fixtureModels(), extensions: [], restore, committed: () => {} };
        const opening = runtime.open(options),
          rejected = expect(opening).rejects.toBe(failure);
        await expect.poll(() => entered).toBe(true);
        const closing = runtime.close();
        expect(abort).not.toHaveBeenCalled();
        release();
        await rejected;
        await closing;
        await Promise.all(waits);
        expect(order).toEqual(['close', 'drained', 'abort']);
        expect(restore).toHaveBeenCalledTimes(1);
        await expect(runtime.open(options)).rejects.toThrow('Runtime is closed');
        await expect(runtime.close()).resolves.toBeUndefined();
      } finally {
        release();
        openSpy?.mockRestore();
      }
    });
  },
);
