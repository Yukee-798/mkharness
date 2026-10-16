import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { defineTask } from '@earendil-works/pi-durable';
import { expect, it } from 'vitest';
import { RemoteIntents } from '../../src/extensions/async-example/runtime';
import { BG } from '../../src/server/conversations/context';
it('native atomic commit rolls back child + reference together; split-commit ablation leaves an unreferenced child', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  try {
    await runInDurableObject(stub, async (instance) => {
      const root = await instance.root();
      const task = defineTask({
        name: 'test.atomic-probe',
        version: 1,
        initial: () => ({ phase: 'work' as const }),
        phases: { work: async () => {} },
        abort: async () => {},
      });
      const children = () =>
        root.commit((tx) => tx.scanTasks({ conversationId: root.id }, 100), BG);
      const before = (await children()).items.length;
      await expect(
        root.commit(async (tx) => {
          await tx.createTask(task, {}, { ownership: { kind: 'conversation' } });
          await tx.doc(RemoteIntents, root.id);
          throw new Error('fault before atomic commit');
        }, BG),
      ).rejects.toThrow('fault');
      expect((await children()).items).toHaveLength(before);
      expect(
        await (await instance.harness.pi()).snapshot(RemoteIntents, root.id, BG),
      ).toBeUndefined();
      // Negative control: persistence succeeds before the reference transaction faults.
      await root.commit(
        (tx) => tx.createTask(task, {}, { ownership: { kind: 'conversation' } }),
        BG,
      );
      await expect(
        root.commit(async (tx) => {
          await tx.doc(RemoteIntents, root.id);
          throw new Error('fault before reference commit');
        }, BG),
      ).rejects.toThrow('fault');
      expect((await children()).items).toHaveLength(before + 1);
    });
  } finally {
    await abortAllDurableObjects();
  }
});
