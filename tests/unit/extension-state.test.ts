import { expect, it, vi } from 'vitest';
import { createExtensionProjection } from '../../src/server/extensions/state';
import { ROOT_CONVERSATION_ID, defineDoc } from '@earendil-works/pi-durable';

it('removing public projections removes their reads and listeners too', async () => {
  const pi = { commit: vi.fn(), snapshot: vi.fn(), subscribeCommits: vi.fn() };
  const projection = createExtensionProjection(pi as any, [], [], {} as any);
  await projection.restore();
  expect(projection.project()).toEqual({});
  expect(
    projection.accept([
      { type: 'entry', value: { id: 2, conversationId: ROOT_CONVERSATION_ID } },
    ] as any),
  ).toBe(false);
  expect(pi.commit).not.toHaveBeenCalled();
  expect(pi.snapshot).not.toHaveBeenCalled();
  expect(pi.subscribeCommits).not.toHaveBeenCalled();
});
it('declared native document projections retain newer commits across bootstrap and exclude private fields', async () => {
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
    commit: async (read: (tx: unknown) => Promise<unknown>) =>
      read({
        scanEntries: async () => ({ items: [] }),
        scanTasks: async () => ({ items: [] }),
      }),
  };
  const projection = createExtensionProjection(
    pi as any,
    [
      {
        id: 'example',
        stateDocuments: [token],
        projectState: ({ documents }) => ({
          status: documents?.get(token.definition.kind)?.status ?? null,
        }),
      },
    ],
    [],
    {} as any,
  );
  const restore = projection.restore();
  expect(
    projection.accept([
      {
        type: 'document',
        conversationId: ROOT_CONVERSATION_ID,
        record: { kind: token.definition.kind },
        value: { status: 'new', private: 'secret' },
      },
    ] as any),
  ).toBe(true);
  resolve({ status: 'old', private: 'credential' });
  await restore;
  expect(projection.project()).toEqual({ example: { status: 'new' } });
  expect(
    projection.accept([
      {
        type: 'document',
        conversationId: ROOT_CONVERSATION_ID,
        record: { kind: 'undeclared' },
        value: { status: 'foreign' },
      },
    ] as any),
  ).toBe(false);
});
it('folds atomic native changes without publishing private or unchanged metadata', () => {
  const projectState = vi.fn(({ tasks }) => ({
    finished: tasks
      .filter((task: any) => task.state.status === 'terminal')
      .map((task: any) => Number(task.id)),
  }));
  const projection = createExtensionProjection(
    {} as any,
    [{ id: 'generic', projectState }],
    [],
    {} as any,
  );
  expect(projection.project()).toEqual({ generic: { finished: [] } });
  expect(
    projection.accept([
      { type: 'task', value: { id: 8, conversationId: 999, state: { status: 'terminal' } } },
    ] as any),
  ).toBe(false);
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(1);
  projection.accept([
    {
      type: 'task',
      value: {
        id: 8,
        conversationId: ROOT_CONVERSATION_ID,
        state: { status: 'running' },
        details: 'Private',
      },
    },
  ] as any);
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(2);
  projection.accept([
    {
      type: 'task',
      value: {
        id: 8,
        conversationId: ROOT_CONVERSATION_ID,
        state: { status: 'terminal' },
        details: 'Private',
      },
    },
  ] as any);
  expect(projection.hasChanges()).toBe(true);
  expect(projection.project()).toEqual({ generic: { finished: [8] } });
  expect(projection.hasChanges()).toBe(false);
  expect(projectState).toHaveBeenCalledTimes(3);
});
