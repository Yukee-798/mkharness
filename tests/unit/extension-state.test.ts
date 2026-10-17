import { expect, it, vi } from 'vitest';
import { createExtensionProjection } from '../../src/server/extensions/state';
import { defineDoc, type ConversationId } from '@earendil-works/pi-durable';
import { BG } from '../../src/server/chat/context';
const target = 42 as ConversationId;
const empty = () => ({ entries: [], tasks: [], submissions: [] });

it('removing public projections removes their document reads and listeners', async () => {
  const pi = { commit: vi.fn(), snapshot: vi.fn(), subscribeCommits: vi.fn() };
  const projection = createExtensionProjection(pi as any, target, [], BG, {
    restore: async () => empty(),
  });
  await projection.restore();
  expect(projection.project()).toEqual({});
  expect(
    projection.accept([{ type: 'entry', value: { id: 2, conversationId: target } }] as any),
  ).toBe(false);
  expect(pi.commit).not.toHaveBeenCalled();
  expect(pi.snapshot).not.toHaveBeenCalled();
  expect(pi.subscribeCommits).not.toHaveBeenCalled();
});
it('declared documents retain newer commits during bootstrap and stay scoped to the explicit target', async () => {
  const token = defineDoc({
    kind: 'example.progress',
    version: 1,
    scope: 'conversation',
    history: 'latest',
    fork: 'initial',
    initial: () => ({ status: 'old', private: 'credential' }),
  });
  let resolve!: (value: ReturnType<typeof token.definition.initial>) => void;
  const pi = {
    snapshot: vi.fn(
      () =>
        new Promise<ReturnType<typeof token.definition.initial>>((done) => {
          resolve = done;
        }),
    ),
  };
  const projection = createExtensionProjection(
    pi as any,
    target,
    [
      {
        id: 'example',
        stateDocuments: [token],
        projectConversation: ({ documents }) => ({
          status: documents?.get(token.definition.kind)?.status ?? null,
        }),
      },
    ],
    BG,
    { restore: async () => empty() },
  );
  const restored = projection.restore();
  expect(
    projection.accept([
      {
        type: 'document',
        conversationId: target,
        record: { kind: token.definition.kind },
        value: { status: 'new', private: 'secret' },
      },
    ] as any),
  ).toBe(true);
  resolve({ status: 'old', private: 'credential' });
  await restored;
  expect(pi.snapshot).toHaveBeenCalledWith(token, target, BG);
  expect(projection.project()).toEqual({ example: { status: 'new' } });
  expect(
    projection.accept([
      {
        type: 'document',
        conversationId: 1,
        record: { kind: token.definition.kind },
        value: { status: 'foreign' },
      },
    ] as any),
  ).toBe(false);
});
it('folds only page facts, permits inherited page annotations and keeps commits newer than the locator read', async () => {
  let finish!: (value: any) => void;
  const projection = createExtensionProjection(
    {} as any,
    target,
    [
      {
        id: 'page',
        projectHistory: ({ entries }) =>
          Object.fromEntries(entries.map((entry) => [String(entry.id), { label: entry.kind }])),
        projectConversation: ({ tasks }) => ({
          completed: tasks
            .filter((task) => task.state.status === 'terminal')
            .map((task) => Number(task.id)),
        }),
      },
    ],
    BG,
    {
      restore: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  );
  const restoring = projection.restore();
  projection.accept([
    { type: 'entry', value: { id: 55, conversationId: target, kind: 'newer' } },
  ] as any);
  finish({
    entries: [{ id: 30, conversationId: 1, kind: 'inherited' }],
    tasks: [],
    submissions: [],
  });
  await restoring;
  expect(projection.annotations()).toEqual({
    '30': { page: { label: 'inherited' } },
    '55': { page: { label: 'newer' } },
  });
  expect(
    projection.accept([
      { type: 'entry', value: { id: 99, conversationId: 1, kind: 'hidden-after-fork' } },
    ] as any),
  ).toBe(false);
  expect(projection.annotations()).not.toHaveProperty('99');
  projection.accept([
    { type: 'task', value: { id: 60, conversationId: target, state: { status: 'terminal' } } },
  ] as any);
  expect(projection.project()).toEqual({ page: { completed: [60] } });
});
