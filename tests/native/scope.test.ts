import {
  createSession,
  defineTask,
  UserEntry,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory';
import { expect, it, vi } from 'vitest';
import { BG } from '../../src/server/chat/context';
import { conversationScope } from '../../src/server/chat/scope';

const owner = defineTask({
  name: 'test.scope-owner',
  version: 1,
  initial: () => ({ phase: 'pending' as const }),
  phases: { pending: async () => {} },
  abort: async () => {},
});

it('Stop scope follows nested ownership across background tasks and excludes ownerless forks', async () => {
  const session = createSession(new MemoryStorage());
  try {
    const graph = await session.commit(async (tx) => {
      const root = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      const at = await tx.appendEntry(UserEntry, root.id, {
        model: [{ role: 'user', content: 'root', timestamp: 1 }],
      });
      const rootTask = await tx.createTask(
        owner,
        {},
        { ownership: { kind: 'conversation' }, conversationId: root.id, background: true },
      );
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: rootTask } });
      const childTask = await tx.createTask(
        owner,
        {},
        { ownership: { kind: 'conversation' }, conversationId: child.id },
      );
      const grandchild = await tx.createConversation({
        ownership: { kind: 'task', taskId: childTask },
      });
      return { root: root.id, at: at.id, childTask, child: child.id, grandchild: grandchild.id };
    }, BG);
    const forks = await session.commit(async (tx) => {
      const independent = await tx.forkConversation(graph.root, graph.at, {
        ownership: { kind: 'ownerless' },
      });
      // History ancestry and execution ownership can deliberately name different scopes.
      const borrowed = await tx.forkConversation(graph.root, graph.at, {
        ownership: { kind: 'task', taskId: graph.childTask },
      });
      return { independent: independent.id, borrowed: borrowed.id };
    }, BG);
    await session.commit(async (tx) => {
      const within = conversationScope(tx);
      expect(await within(graph.root, new Set([Number(graph.root)]))).toBe(true);
      expect(await within(graph.child, new Set([Number(graph.root)]))).toBe(true);
      expect(await within(graph.grandchild, new Set([Number(graph.root)]))).toBe(true);
      expect(await within(forks.independent, new Set([Number(graph.root)]))).toBe(false);
      expect(await within(forks.borrowed, new Set([Number(graph.child)]))).toBe(true);
      expect(await within(graph.root, new Set([Number(graph.child)]))).toBe(false);
      expect(await within(graph.child, new Set([Number(forks.independent)]))).toBe(false);
    }, BG);
  } finally {
    await session.close(BG);
  }
});

it('reads only candidate owner chains and reuses records within one transaction', async () => {
  const id = (value: number) => value as ConversationId;
  const conversation = vi.fn(async (value: ConversationId) =>
    value === id(1)
      ? { id: id(1) }
      : { id: value, owner: { conversationId: id(Number(value) - 1), taskId: 100 as never } },
  );
  const within = conversationScope({ conversation });
  expect(await within(id(4), new Set())).toBe(false);
  expect(conversation).not.toHaveBeenCalled();
  expect(await within(id(4), new Set([1]))).toBe(true);
  expect(await within(id(3), new Set([1]))).toBe(true);
  expect(conversation.mock.calls.map(([value]) => value)).toEqual([4, 3, 2]);
});

it('fails closed if an ownership record is missing or cyclic', async () => {
  const id = (value: number) => value as ConversationId;
  await expect(
    conversationScope({ conversation: async () => undefined })(id(2), new Set([1])),
  ).rejects.toThrow('record is missing');
  await expect(
    conversationScope({
      conversation: async (value) => ({
        id: value,
        owner: { conversationId: value, taskId: 100 as never },
      }),
    })(id(2), new Set([1])),
  ).rejects.toThrow('ownership cycle');
});
